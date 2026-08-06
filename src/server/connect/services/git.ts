import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import { GitService } from '~/gen/forge/v1/git_pb'
import {
  BlobSchema,
  EntryType,
  GetBlobResponseSchema,
  GetCommitResponseSchema,
  GetTreeResponseSchema,
  ListCommitsResponseSchema,
  ListRefsResponseSchema,
  TreeEntrySchema,
} from '~/gen/forge/v1/git_pb'
import { CommitSchema, RefKind, RefSchema, SignatureSchema } from '~/gen/forge/v1/common_pb'
import { ArtifactsClient, MAX_INLINE_BLOB_BYTES } from '../../artifacts/client'
import { requireRepo } from '../../db/repos'
import { ForgeError } from '../../errors'
import { contextFrom, requestContextKey } from '../router'
import { detectLanguage, isProbablyBinary } from '../../git/content'

/**
 * Read-only git browsing.
 *
 * Every method here fans out to whichever Artifacts surface can answer it —
 * binding for commits and trees, REST for file content, the git protocol for
 * refs. See artifacts/client.ts for why that split exists.
 */

/** Bounds a recursive tree walk so a pathological repo cannot exhaust the isolate. */
const MAX_TREE_ENTRIES = 10_000

export function registerGitService(router: ConnectRouter): void {
  router.service(GitService, {
    async listRefs(request, context) {
      const { artifacts, repo } = await load(context, request.owner, request.repo)
      const refs = await artifacts.listRefs(repo.artifacts_name)

      const wanted = request.kind ?? RefKind.UNSPECIFIED
      const out = []

      if (wanted !== RefKind.TAG) {
        for (const branch of refs.branches) {
          out.push(
            create(RefSchema, {
              name: branch.name,
              kind: RefKind.BRANCH,
              sha: branch.sha,
              isDefault: branch.name === repo.default_branch,
            }),
          )
        }
      }
      if (wanted !== RefKind.BRANCH) {
        for (const tag of refs.tags) {
          out.push(create(RefSchema, { name: tag.name, kind: RefKind.TAG, sha: tag.sha, isDefault: false }))
        }
      }

      return create(ListRefsResponseSchema, { refs: out })
    },

    async getTree(request, context) {
      const { artifacts, repo } = await load(context, request.owner, request.repo)
      const sha = await resolveRef(artifacts, repo.artifacts_name, request.ref || repo.default_branch)

      const level = await artifacts.readTreeAtPath(repo.artifacts_name, sha, request.path)
      if (!level) throw ForgeError.notFound('Path')

      if (!request.recursive) {
        return create(GetTreeResponseSchema, {
          entries: level.entries.map((entry) => toTreeEntry(entry, request.path)),
          resolvedSha: sha,
          truncated: false,
        })
      }

      const { entries, truncated } = await walk(artifacts, repo.artifacts_name, level.entries, request.path)
      return create(GetTreeResponseSchema, { entries, resolvedSha: sha, truncated })
    },

    async getBlob(request, context) {
      const { artifacts, repo } = await load(context, request.owner, request.repo)
      const ref = request.ref || repo.default_branch

      const file = await artifacts.readFile(repo.artifacts_name, ref, request.path)
      if (!file) throw ForgeError.notFound('File')

      const binary = isProbablyBinary(file.bytes)
      // Large or binary blobs are described but not inlined; the client follows
      // up with the raw route, which streams instead of buffering.
      const inline = !binary && file.size <= MAX_INLINE_BLOB_BYTES

      return create(GetBlobResponseSchema, {
        blob: create(BlobSchema, {
          sha: file.sha,
          path: request.path,
          size: BigInt(file.size),
          text: inline ? new TextDecoder().decode(file.bytes) : '',
          isBinary: binary,
          truncated: !binary && !inline,
          language: detectLanguage(request.path),
          mimeType: file.contentType,
        }),
      })
    },

    async listCommits(request, context) {
      const { artifacts, repo } = await load(context, request.owner, request.repo)
      const limit = clamp(request.limit, 1, 100, 30)

      // One extra row tells us whether another page exists without a count query.
      const commits = await artifacts.log(repo.artifacts_name, {
        ref: request.ref || repo.default_branch,
        limit: limit + 1,
        offset: Math.max(0, request.offset),
      })

      return create(ListCommitsResponseSchema, {
        commits: commits.slice(0, limit).map(toCommit),
        hasMore: commits.length > limit,
      })
    },

    async getCommit(request, context) {
      const { artifacts, repo } = await load(context, request.owner, request.repo)
      const commit = await artifacts.readCommit(repo.artifacts_name, request.sha)
      if (!commit) throw ForgeError.notFound('Commit')
      return create(GetCommitResponseSchema, { commit: toCommit(commit) })
    },

    async getReadme(request, context) {
      const { artifacts, repo } = await load(context, request.owner, request.repo)
      const ref = request.ref || repo.default_branch
      const directory = request.path ? `${request.path.replace(/\/$/, '')}/` : ''

      for (const candidate of ['README.md', 'README.markdown', 'README.rst', 'README.txt', 'README']) {
        const file = await artifacts.readFile(repo.artifacts_name, ref, `${directory}${candidate}`)
        if (!file || isProbablyBinary(file.bytes)) continue

        const text = new TextDecoder().decode(file.bytes)
        return {
          $typeName: 'forge.v1.GetReadmeResponse' as const,
          blob: create(BlobSchema, {
            sha: file.sha,
            path: `${directory}${candidate}`,
            size: BigInt(file.size),
            text,
            isBinary: false,
            truncated: false,
            language: detectLanguage(candidate),
            mimeType: file.contentType,
          }),
          // Rendering happens client-side; sending raw markdown avoids having to
          // sanitize server-generated HTML on a path that accepts arbitrary
          // repository content.
          html: '',
        }
      }

      return { $typeName: 'forge.v1.GetReadmeResponse' as const, blob: undefined, html: '' }
    },
  })
}

/**
 * Resolves the repo and the caller's access in one step, then hands back the
 * Artifacts client bound to it. Every read here needs all three, and keeping
 * them together means no handler can load a repo and forget the access check.
 */
async function load(context: HandlerContext, owner: string, name: string) {
  const ctx = contextFrom(context.values)
  const found = await requireRepo(ctx.env.DB, owner, name, {
    id: ctx.viewer.id,
    isSiteAdmin: ctx.viewer.isSiteAdmin,
  })
  return { artifacts: new ArtifactsClient(ctx.env), repo: found.repo, ctx }
}

/**
 * Resolves a branch, tag, or SHA to a commit.
 *
 * A 40-hex string is assumed to be a commit already. Anything else needs the ref
 * advertisement, since Artifacts has no name-to-SHA lookup.
 */
async function resolveRef(artifacts: ArtifactsClient, name: string, ref: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref

  const refs = await artifacts.listRefs(name)
  const match =
    refs.branches.find((branch) => branch.name === ref) ?? refs.tags.find((tag) => tag.name === ref)
  if (!match) throw ForgeError.notFound(`Ref "${ref}"`)
  return match.sha
}

/**
 * Depth-first walk of a subtree.
 *
 * The binding reads one level per call, so a deep tree costs one round trip per
 * directory. The entry budget stops a repo with a pathological structure from
 * running the isolate out of time or memory.
 */
async function walk(
  artifacts: ArtifactsClient,
  name: string,
  entries: ArtifactsTreeEntry[],
  prefix: string,
): Promise<{ entries: ReturnType<typeof toTreeEntry>[]; truncated: boolean }> {
  const out: ReturnType<typeof toTreeEntry>[] = []
  const queue: { entries: ArtifactsTreeEntry[]; prefix: string }[] = [{ entries, prefix }]
  let truncated = false

  while (queue.length > 0) {
    const level = queue.shift()!
    for (const entry of level.entries) {
      if (out.length >= MAX_TREE_ENTRIES) return { entries: out, truncated: true }
      out.push(toTreeEntry(entry, level.prefix))

      if (entry.type === 'tree') {
        const children = await artifacts.readTree(name, entry.hash)
        if (children) {
          queue.push({ entries: children, prefix: join(level.prefix, entry.name) })
        } else {
          truncated = true
        }
      }
    }
  }

  return { entries: out, truncated }
}

function toTreeEntry(entry: ArtifactsTreeEntry, prefix: string) {
  return create(TreeEntrySchema, {
    name: entry.name,
    path: join(prefix, entry.name),
    type: entryType(entry),
    mode: entry.mode,
    sha: entry.hash,
  })
}

function entryType(entry: ArtifactsTreeEntry): EntryType {
  // A `commit` entry in a tree is a gitlink — a submodule pointer, not a
  // directory we can descend into.
  if (entry.type === 'commit') return EntryType.SUBMODULE
  if (entry.type === 'tree') return EntryType.DIR
  return entry.mode === '120000' ? EntryType.SYMLINK : EntryType.FILE
}

function toCommit(commit: ArtifactsCommitObject) {
  return create(CommitSchema, {
    sha: commit.hash,
    message: commit.message,
    author: toSignature(commit.author),
    committer: toSignature(commit.committer),
    parents: commit.parents,
    treeSha: commit.treeHash,
  })
}

function toSignature(signature: { name: string; email: string; time: string }) {
  return create(SignatureSchema, {
    name: signature.name,
    email: signature.email,
    time: timestampFromDate(new Date(signature.time)),
  })
}

function join(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.max(value, min), max)
}

export { requestContextKey }
