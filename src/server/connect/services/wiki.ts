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
import { parseGitTime } from '../../artifacts/time'
import { buildCommit, buildTree, hashObject, type TreeEntry } from '../../git/objects'
import { buildReceivePackRequest, parseReceivePackResponse, ZERO_SHA } from '../../git/receive-pack'
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
 * Saving a page builds a blob, a tree, and a commit and pushes them with
 * receive-pack — Artifacts has no object-write API, so the objects are
 * constructed here (see git/objects.ts, verified against `git index-pack`).
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
              time: timestampFromDate(parseGitTime(commit.author)),
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
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(request.slug)) {
        // The slug becomes a filename in the tree; a path separator would let a
        // page write outside the wiki root.
        throw ForgeError.invalid('Page slug may only contain letters, numbers, dots, hyphens, and underscores')
      }

      const sha = await writeWikiTree(ctx, found, {
        [`${request.slug}.md`]: request.content,
      }, request.commitMessage || `Update ${request.slug}`, request.expectedCommitSha)

      return create(SaveWikiPageResponseSchema, {
        page: create(WikiPageSchema, {
          slug: request.slug,
          title: request.title || titleFromSlug(request.slug),
          content: request.content,
          contentHtml: '',
          commitSha: sha,
        }),
      })
    },

    async deleteWikiPage(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      if (!atLeast(found.access.permission, 'write')) {
        throw ForgeError.permissionDenied('You need write access to edit the wiki')
      }

      // A null value removes the entry rather than writing an empty page.
      await writeWikiTree(ctx, found, {
        [`${request.slug}.md`]: null,
      }, request.commitMessage || `Delete ${request.slug}`)

      return create(DeleteWikiPageResponseSchema, {})
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

/**
 * Applies a set of file changes to the wiki repo as one commit.
 *
 * The wiki is flat — one markdown file per page — so the whole tree is rebuilt
 * from the existing entries plus the changes. That is affordable here and
 * avoids the recursive tree rewriting a nested layout would need.
 *
 * The repo is created on first write, which is why the wiki can be listed as
 * "not initialized" until someone saves a page.
 */
async function writeWikiTree(
  ctx: RequestContext,
  found: RepoWithAccess,
  changes: Record<string, string | null>,
  message: string,
  expectedCommitSha?: string,
): Promise<string> {
  const artifacts = new ArtifactsClient(ctx.env)
  const name = wikiArtifactsName(found.repo.owner_login, found.repo.name)

  let repo = await artifacts.tryGetRepo(name)
  if (!repo) {
    await artifacts.createRepo(name, {
      description: `Wiki for ${found.repo.owner_login}/${found.repo.name}`,
      defaultBranch: 'main',
    })
    repo = await artifacts.getRepo(name)
  }

  const branch = repo.defaultBranch || 'main'
  const refs = await artifacts.listRefs(name)
  const head = refs.branches.find((item) => item.name === branch)

  // Refuse the write if the page moved since it was read, the same
  // compare-and-swap the merge path uses.
  if (expectedCommitSha && head && head.sha !== expectedCommitSha) {
    throw new ForgeError(
      'conflict',
      'This page changed since you opened it. Reload and reapply your edit.',
    )
  }

  const entries = new Map<string, TreeEntry>()
  if (head) {
    const level = await artifacts.readTreeAtPath(name, head.sha, '')
    for (const entry of level?.entries ?? []) {
      if (entry.type === 'blob') {
        entries.set(entry.name, { mode: entry.mode, name: entry.name, sha: entry.hash })
      }
    }
  }

  const objects = []
  for (const [filename, content] of Object.entries(changes)) {
    if (content === null) {
      entries.delete(filename)
      continue
    }
    const blob = await hashObject('blob', new TextEncoder().encode(content))
    objects.push(blob)
    entries.set(filename, { mode: '100644', name: filename, sha: blob.sha })
  }

  if (entries.size === 0) throw ForgeError.invalid('A wiki must keep at least one page')

  const tree = await buildTree([...entries.values()])
  const commit = await buildCommit({
    tree: tree.sha,
    parents: head ? [head.sha] : [],
    author: {
      name: ctx.viewer.login ?? 'Gitflare',
      email: `${ctx.viewer.login ?? 'gitflare'}@users.noreply.gitflare`,
      when: Date.now(),
    },
    message,
  })
  objects.push(tree, commit)

  const token = await artifacts.mintToken(name, 'write', 300)
  const body = await buildReceivePackRequest(
    {
      ref: `refs/heads/${branch}`,
      oldSha: head?.sha ?? ZERO_SHA,
      newSha: commit.sha,
    },
    objects,
  )

  const response = await fetch(`${artifacts.remoteFor(name)}/git-receive-pack`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-git-receive-pack-request',
      'User-Agent': 'git/2.45.0 (gitflare)',
    },
    body: body as BufferSource,
  })

  if (!response.ok) {
    throw new ForgeError('unavailable', `Artifacts rejected the write (HTTP ${response.status})`)
  }
  const result = parseReceivePackResponse(new Uint8Array(await response.arrayBuffer()))
  if (!result.ok) {
    throw new ForgeError('conflict', `Wiki write was rejected: ${result.error ?? 'unknown reason'}`)
  }
  return commit.sha
}
