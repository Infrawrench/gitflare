import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import { SearchService, SearchKind, SearchResponseSchema, CodeMatchSchema } from '~/gen/forge/v1/search_pb'
import { IssueSchema, IssueState } from '~/gen/forge/v1/issue_pb'
import { RepoSchema } from '~/gen/forge/v1/repo_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { OwnerSchema, PageResponseSchema, Permission, Visibility } from '~/gen/forge/v1/common_pb'
import { ArtifactsClient } from '../../artifacts/client'
import { findRepoForViewer } from '../../db/repos'
import { ForgeError } from '../../errors'
import { contextFrom, type RequestContext } from '../router'
import { sanitizeFtsQuery } from './repo'

/**
 * Search across repos, issues, users, and code.
 *
 * The first three run against the FTS5 indexes in migration 0004. Those tables
 * are *contentless*, so a column read back from them is always NULL — every
 * query here joins to the base table on rowid and reads the real row from
 * there. See the header of that migration for why.
 *
 * Code search has no index. Blob contents live in Artifacts, not D1, so it walks
 * the default branch's tree at query time and is deliberately bounded. Results
 * are best-effort and `truncated` says so.
 */

/** Files opened during a code search before giving up. */
const CODE_SEARCH_FILE_BUDGET = 300
/** Matches returned before stopping early. */
const CODE_SEARCH_MATCH_LIMIT = 100
const CONTEXT_LINES = 2

export function registerSearchService(router: ConnectRouter): void {
  router.service(SearchService, {
    async search(request, context) {
      const ctx = contextFrom(context.values)
      const started = Date.now()

      const query = request.query.trim()
      if (query === '') throw ForgeError.invalid('A search query is required')

      const limit = Math.min(Math.max(request.page?.limit || 20, 1), 50)

      switch (request.kind) {
        case SearchKind.ISSUES:
          return withTiming(started, await searchIssues(ctx, query, request, limit))
        case SearchKind.USERS:
          return withTiming(started, await searchUsers(ctx, query, limit))
        case SearchKind.CODE:
          return withTiming(started, await searchCode(ctx, query, request))
        default:
          return withTiming(started, await searchRepos(ctx, query, request, limit))
      }
    },
  })
}

function withTiming(started: number, response: ReturnType<typeof create<typeof SearchResponseSchema>>) {
  response.tookMs = Date.now() - started
  return response
}

/**
 * Visibility predicate applied to every repo-scoped search.
 *
 * Written as SQL rather than a post-filter so pagination cannot return a short
 * page full of rows the caller may not see.
 */
function visibilityFilter(ctx: RequestContext, bind: (value: unknown) => string): string {
  if (ctx.viewer.isSiteAdmin) return '1 = 1'
  if (!ctx.viewer.id) return `r.visibility = 'public'`

  const viewer = bind(ctx.viewer.id)
  return `(
    r.visibility = 'public'
    OR r.owner_id = ${viewer}
    OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = ${viewer})
    OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = r.owner_id AND m.user_id = ${viewer})
  )`
}

async function searchRepos(
  ctx: RequestContext,
  query: string,
  request: { owner?: string },
  limit: number,
) {
  const binds: unknown[] = []
  const bind = (value: unknown) => {
    binds.push(value)
    return `?${binds.length}`
  }

  const match = bind(sanitizeFtsQuery(query))
  const filters = [
    `r.rowid IN (SELECT f.rowid FROM repos_fts f WHERE repos_fts MATCH ${match})`,
    visibilityFilter(ctx, bind),
  ]
  if (request.owner) filters.push(`o.login_lower = ${bind(request.owner.toLowerCase())}`)

  const rows = await ctx.env.DB.prepare(
    `SELECT r.*, o.login AS owner_login, o.kind AS owner_kind
     FROM repos r JOIN owners o ON o.id = r.owner_id
     WHERE ${filters.join(' AND ')}
     ORDER BY r.star_count DESC, r.updated_at DESC
     LIMIT ${bind(limit)}`,
  )
    .bind(...binds)
    .all<RepoSearchRow>()

  return create(SearchResponseSchema, {
    repos: (rows.results ?? []).map((row) =>
      create(RepoSchema, {
        id: row.id,
        owner: create(OwnerSchema, {
          id: row.owner_id,
          login: row.owner_login,
          displayName: row.owner_login,
          isOrg: row.owner_kind === 'org',
        }),
        name: row.name,
        description: row.description,
        visibility: row.visibility === 'public' ? Visibility.PUBLIC : Visibility.PRIVATE,
        defaultBranch: row.default_branch,
        starCount: row.star_count,
        forkCount: row.fork_count,
        viewerPermission: Permission.UNSPECIFIED,
        updatedAt: timestampFromDate(new Date(row.updated_at)),
      }),
    ),
    page: create(PageResponseSchema, {}),
  })
}

async function searchIssues(
  ctx: RequestContext,
  query: string,
  request: { owner?: string; repo?: string },
  limit: number,
) {
  const binds: unknown[] = []
  const bind = (value: unknown) => {
    binds.push(value)
    return `?${binds.length}`
  }

  const match = bind(sanitizeFtsQuery(query))
  const filters = [
    `i.rowid IN (SELECT f.rowid FROM issues_fts f WHERE issues_fts MATCH ${match})`,
    // Issues inherit their repo's visibility; searching them must not become a
    // way to read the titles of a private repo's bugs.
    visibilityFilter(ctx, bind),
  ]
  if (request.owner) filters.push(`o.login_lower = ${bind(request.owner.toLowerCase())}`)
  if (request.repo) filters.push(`r.name_lower = ${bind(request.repo.toLowerCase())}`)

  const rows = await ctx.env.DB.prepare(
    `SELECT i.*, a.login AS author_login, a.id AS author_id
     FROM issues i
     JOIN repos r ON r.id = i.repo_id
     JOIN owners o ON o.id = r.owner_id
     JOIN owners a ON a.id = i.author_id
     WHERE ${filters.join(' AND ')}
     ORDER BY i.updated_at DESC
     LIMIT ${bind(limit)}`,
  )
    .bind(...binds)
    .all<IssueSearchRow>()

  return create(SearchResponseSchema, {
    issues: (rows.results ?? []).map((row) =>
      create(IssueSchema, {
        id: row.id,
        number: row.number,
        title: row.title,
        body: row.body,
        state: row.state === 'open' ? IssueState.OPEN : IssueState.CLOSED,
        author: create(UserSchema, { id: row.author_id, login: row.author_login }),
        isPullRequest: row.is_pull === 1,
        commentCount: row.comment_count,
        createdAt: timestampFromDate(new Date(row.created_at)),
        updatedAt: timestampFromDate(new Date(row.updated_at)),
      }),
    ),
    page: create(PageResponseSchema, {}),
  })
}

async function searchUsers(ctx: RequestContext, query: string, limit: number) {
  // Users have no FTS table — the corpus is one short login per row, where a
  // prefix match is both cheaper and closer to what people expect.
  //
  // LIKE wildcards are stripped so they cannot be injected into the pattern. A
  // query made entirely of them strips to nothing, and an empty prefix would
  // match every user — so that returns no results rather than the whole table.
  const prefix = query.toLowerCase().replace(/[%_\\]/g, '')
  if (prefix === '') {
    return create(SearchResponseSchema, { page: create(PageResponseSchema, {}) })
  }

  const rows = await ctx.env.DB.prepare(
    `SELECT o.id, o.login, o.display_name, o.avatar_url
     FROM owners o
     WHERE o.kind = 'user' AND (o.login_lower LIKE ?1 OR lower(o.display_name) LIKE ?1)
     ORDER BY length(o.login), o.login_lower
     LIMIT ?2`,
  )
    .bind(`${prefix}%`, limit)
    .all<{ id: string; login: string; display_name: string; avatar_url: string }>()

  return create(SearchResponseSchema, {
    users: (rows.results ?? []).map((row) =>
      create(UserSchema, {
        id: row.id,
        login: row.login,
        displayName: row.display_name || row.login,
        avatarUrl: row.avatar_url,
      }),
    ),
    page: create(PageResponseSchema, {}),
  })
}

/**
 * Literal substring search over one repo's default branch.
 *
 * Requires `owner` and `repo`: without an index, searching every repo would mean
 * walking every tree, which is not something to offer accidentally.
 */
async function searchCode(
  ctx: RequestContext,
  query: string,
  request: { owner?: string; repo?: string; language?: string },
) {
  if (!request.owner || !request.repo) {
    throw ForgeError.invalid('Code search requires an owner and repository')
  }

  const found = await findRepoForViewer(ctx.env.DB, request.owner, request.repo, {
    id: ctx.viewer.id,
    isSiteAdmin: ctx.viewer.isSiteAdmin,
  })
  if (!found) throw ForgeError.notFound('Repository')

  const artifacts = new ArtifactsClient(ctx.env)
  const refs = await artifacts.listRefs(found.repo.artifacts_name)
  const head = refs.branches.find((branch) => branch.name === found.repo.default_branch)
  if (!head) return create(SearchResponseSchema, { page: create(PageResponseSchema, {}) })

  const level = await artifacts.readTreeAtPath(found.repo.artifacts_name, head.sha, '')
  if (!level) return create(SearchResponseSchema, { page: create(PageResponseSchema, {}) })

  const matches = []
  let filesRead = 0
  let truncated = false
  const needle = query.toLowerCase()

  const queue: { entries: ArtifactsTreeEntry[]; prefix: string }[] = [
    { entries: level.entries, prefix: '' },
  ]

  while (queue.length > 0 && matches.length < CODE_SEARCH_MATCH_LIMIT) {
    const current = queue.shift()!
    for (const entry of current.entries) {
      if (filesRead >= CODE_SEARCH_FILE_BUDGET || matches.length >= CODE_SEARCH_MATCH_LIMIT) {
        truncated = true
        break
      }
      const path = current.prefix ? `${current.prefix}/${entry.name}` : entry.name

      if (entry.type === 'tree') {
        const children = await artifacts.readTree(found.repo.artifacts_name, entry.hash)
        if (children) queue.push({ entries: children, prefix: path })
        continue
      }
      if (entry.type !== 'blob') continue

      filesRead++
      const blob = await artifacts.readBlob(found.repo.artifacts_name, entry.hash)
      if (!blob) continue

      // A NUL byte means binary; searching it would produce noise.
      if (blob.includes(0)) continue

      const lines = new TextDecoder().decode(blob).split('\n')
      for (const [index, line] of lines.entries()) {
        if (!line.toLowerCase().includes(needle)) continue
        matches.push(
          create(CodeMatchSchema, {
            repoFullName: `${request.owner}/${request.repo}`,
            path,
            ref: found.repo.default_branch,
            lineNumber: index + 1,
            line: line.slice(0, 500),
            contextBefore: lines.slice(Math.max(0, index - CONTEXT_LINES), index),
            contextAfter: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
          }),
        )
        if (matches.length >= CODE_SEARCH_MATCH_LIMIT) break
      }
    }
  }

  return create(SearchResponseSchema, {
    code: matches,
    truncated,
    page: create(PageResponseSchema, {}),
  })
}

interface RepoSearchRow {
  id: string
  owner_id: string
  owner_login: string
  owner_kind: 'user' | 'org'
  name: string
  description: string
  visibility: 'public' | 'private'
  default_branch: string
  star_count: number
  fork_count: number
  updated_at: number
}

interface IssueSearchRow {
  id: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  author_id: string
  author_login: string
  is_pull: number
  comment_count: number
  created_at: number
  updated_at: number
}

export type { HandlerContext }
