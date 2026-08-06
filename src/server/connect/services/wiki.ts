import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  WikiService,
  WikiPageSchema,
  ListWikiPagesResponseSchema,
  GetWikiPageResponseSchema,
  SaveWikiPageResponseSchema,
  DeleteWikiPageResponseSchema,
  ListWikiRevisionsResponseSchema,
} from '~/gen/forge/v1/wiki_pb'
import { CommitSchema, SignatureSchema } from '~/gen/forge/v1/common_pb'
import { ArtifactsClient } from '../../artifacts/client'
import { wikiArtifactsName } from '../../artifacts/names'
import { requireRepo, type RepoWithAccess } from '../../db/repos'
import { ForgeError } from '../../errors'
import { atLeast } from '../../auth/rbac'
import { contextFrom, type RequestContext } from '../router'

/**
 * Wiki pages.
 *
 * Each repo's wiki is a *sibling Artifacts repo* named `{owner}--{repo}--wiki`,
 * so the whole history is a real git repo that can be cloned, and pages get
 * revisions for free. That naming cannot collide with a real repo: a repo
 * literally called "wiki" encodes to `owner--wiki`, which has two segments to
 * this one's three. See artifacts/names.ts.
 *
 * Writes go through the git protocol, which means the same fast-forward-only
 * constraint as merging: Artifacts has no object-write API, so a page save has
 * to construct a commit. That is not implemented, and SaveWikiPage says so
 * rather than pretending to succeed.
 */

export function registerWikiService(router: ConnectRouter): void {
  router.service(WikiService, {
    async listWikiPages(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      if (found.repo.has_wiki !== 1) {
        throw new ForgeError('failed_precondition', 'The wiki is disabled for this repository')
      }

      const artifacts = new ArtifactsClient(ctx.env)
      const name = wikiArtifactsName(found.repo.owner_login, found.repo.name)

      // The wiki repo is created lazily on first write, so its absence is a
      // normal state rather than an error.
      const repo = await artifacts.tryGetRepo(name)
      if (!repo) return create(ListWikiPagesResponseSchema, { initialized: false })

      const refs = await artifacts.listRefs(name)
      const head = refs.branches.find((branch) => branch.name === repo.defaultBranch)
      if (!head) return create(ListWikiPagesResponseSchema, { initialized: true })

      const level = await artifacts.readTreeAtPath(name, head.sha, '')
      const entries = level?.entries ?? []

      return create(ListWikiPagesResponseSchema, {
        initialized: true,
        pages: entries
          .filter((entry) => entry.type === 'blob' && entry.name.endsWith('.md'))
          .map((entry) =>
            create(WikiPageSchema, {
              slug: entry.name.replace(/\.md$/, ''),
              title: titleFromSlug(entry.name.replace(/\.md$/, '')),
              commitSha: head.sha,
            }),
          ),
      })
    },

    async getWikiPage(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const artifacts = new ArtifactsClient(ctx.env)
      const name = wikiArtifactsName(found.repo.owner_login, found.repo.name)

      const repo = await artifacts.tryGetRepo(name)
      if (!repo) throw ForgeError.notFound('Wiki')

      const ref = request.ref || repo.defaultBranch
      const file = await artifacts.readFile(name, ref, `${request.slug}.md`)
      if (!file) throw ForgeError.notFound(`Wiki page "${request.slug}"`)

      return create(GetWikiPageResponseSchema, {
        page: create(WikiPageSchema, {
          slug: request.slug,
          title: titleFromSlug(request.slug),
          content: new TextDecoder().decode(file.bytes),
          // Rendering happens client-side; the server does not generate HTML
          // from user content on a path it would then have to sanitize.
          contentHtml: '',
          commitSha: file.sha,
        }),
      })
    },

    async listWikiRevisions(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const artifacts = new ArtifactsClient(ctx.env)
      const name = wikiArtifactsName(found.repo.owner_login, found.repo.name)

      if (!(await artifacts.tryGetRepo(name))) throw ForgeError.notFound('Wiki')

      // Artifacts' log has no path filter, so this is the wiki's history rather
      // than one page's. Better than nothing, and honest about being coarse.
      const commits = await artifacts.log(name, {
        limit: Math.min(Math.max(request.limit || 30, 1), 100),
      })

      return create(ListWikiRevisionsResponseSchema, {
        commits: commits.map((commit) =>
          create(CommitSchema, {
            sha: commit.hash,
            message: commit.message,
            author: create(SignatureSchema, {
              name: commit.author.name,
              email: commit.author.email,
              time: timestampFromDate(new Date(commit.author.time)),
            }),
            parents: commit.parents,
            treeSha: commit.treeHash,
          }),
        ),
      })
    },

    async saveWikiPage(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      if (!atLeast(found.access.permission, 'write')) {
        throw ForgeError.permissionDenied('You need write access to edit the wiki')
      }
      void ctx

      // Writing a page means creating a blob, a tree, and a commit. Artifacts
      // has no object-write API — the binding creates whole repos and the REST
      // API is read-only — so this would require building a packfile, the same
      // obstacle that limits merging to fast-forwards. Reporting it is better
      // than a silent no-op that looks like a save.
      throw new ForgeError(
        'unimplemented',
        'Editing the wiki from the web is not implemented: Artifacts has no object-write API, so a page save would have to construct and push a git commit. Clone the wiki repository and push instead.',
      )
    },

    async deleteWikiPage(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      if (!atLeast(found.access.permission, 'write')) {
        throw ForgeError.permissionDenied('You need write access to edit the wiki')
      }
      void ctx
      void request

      throw new ForgeError(
        'unimplemented',
        'Deleting a wiki page from the web is not implemented; clone the wiki repository and push instead.',
      )
    },
  })
}

async function load(
  context: HandlerContext,
  owner: string,
  repo: string,
): Promise<{ ctx: RequestContext; found: RepoWithAccess }> {
  const ctx = contextFrom(context.values)
  const found = await requireRepo(ctx.env.DB, owner, repo, {
    id: ctx.viewer.id,
    isSiteAdmin: ctx.viewer.isSiteAdmin,
  })
  return { ctx, found }
}

/** "getting-started" → "Getting Started", matching the usual wiki convention. */
function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
