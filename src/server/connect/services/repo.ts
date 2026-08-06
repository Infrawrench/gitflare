import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter } from '@connectrpc/connect'
import {
  RepoService,
  RepoSchema,
  RepoSort,
  CreateRepoResponseSchema,
  ForkRepoResponseSchema,
  GetRepoResponseSchema,
  ImportRepoResponseSchema,
  ListReposResponseSchema,
  UpdateRepoResponseSchema,
  DeleteRepoResponseSchema,
  SetStarResponseSchema,
  SetWatchResponseSchema,
} from '~/gen/forge/v1/repo_pb'
import { OwnerSchema, PageResponseSchema, Permission, Visibility } from '~/gen/forge/v1/common_pb'
import { ArtifactsClient } from '../../artifacts/client'
import { artifactsName, assertRepoName } from '../../artifacts/names'
import { findRepoForViewer, requireRepo, type RepoRow } from '../../db/repos'
import { resolveCreateTarget } from '../../db/owners'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import type { Permission as RbacPermission } from '../../auth/rbac'
import { contextFrom, type RequestContext } from '../router'

/**
 * Repository lifecycle.
 *
 * Every mutation here has to keep two stores agreed: the D1 row that carries
 * forge metadata and permissions, and the Artifacts repo that holds the git
 * objects. Artifacts is created first in each case — a D1 row pointing at
 * storage that does not exist is a repo that 404s on every clone, whereas an
 * orphaned Artifacts repo is invisible and reclaimable.
 */

export function registerRepoService(router: ConnectRouter): void {
  router.service(RepoService, {
    async createRepo(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewer(ctx)
      assertRepoName(request.name)

      const owner = await resolveCreateTarget(ctx.env.DB, request.owner, viewer)
      const name = artifactsName(owner.login, request.name)
      await assertRepoAvailable(ctx, owner.id, request.name)

      const artifacts = new ArtifactsClient(ctx.env)
      const defaultBranch = request.defaultBranch || 'main'

      await artifacts.createRepo(name, {
        description: request.description,
        defaultBranch,
      })

      const repo = await insertRepo(ctx, {
        ownerId: owner.id,
        name: request.name,
        description: request.description,
        visibility: request.visibility,
        defaultBranch,
        artifactsName: name,
        hasWiki: request.hasWiki,
        hasIssues: request.hasIssues,
      })

      return create(CreateRepoResponseSchema, {
        repo: toRepo(repo, owner.login, owner.kind, Permission.ADMIN, ctx),
      })
    },

    async importRepo(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewer(ctx)
      assertRepoName(request.name)

      const owner = await resolveCreateTarget(ctx.env.DB, request.owner, viewer)
      const name = artifactsName(owner.login, request.name)
      await assertRepoAvailable(ctx, owner.id, request.name)

      const artifacts = new ArtifactsClient(ctx.env)
      const created = await artifacts.importRepo({
        name,
        url: request.cloneUrl,
        ...(request.branch ? { branch: request.branch } : {}),
        ...(request.depth ? { depth: request.depth } : {}),
        description: request.description,
      })

      const repo = await insertRepo(ctx, {
        ownerId: owner.id,
        name: request.name,
        description: request.description,
        visibility: request.visibility,
        defaultBranch: created.defaultBranch || 'main',
        artifactsName: name,
        hasWiki: true,
        hasIssues: true,
        // Artifacts reports the repo as importing until the clone finishes; git
        // routes refuse anything but 'ready'.
        status: 'importing',
        isMirror: request.mirror,
        mirrorSourceUrl: request.cloneUrl,
      })

      return create(ImportRepoResponseSchema, {
        repo: toRepo(repo, owner.login, owner.kind, Permission.ADMIN, ctx),
      })
    },

    async forkRepo(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewer(ctx)

      // Forking needs read on the source, and create rights on the target.
      const source = await requireRepo(ctx.env.DB, request.owner, request.name, viewerOf(ctx), 'read')
      const target = await resolveCreateTarget(ctx.env.DB, request.targetOwner, viewer)
      const targetName = request.targetName || source.repo.name
      assertRepoName(targetName)

      if (target.id === source.repo.owner_id && targetName === source.repo.name) {
        throw ForgeError.invalid('A repository cannot be forked onto itself')
      }
      await assertRepoAvailable(ctx, target.id, targetName)

      const name = artifactsName(target.login, targetName)
      const artifacts = new ArtifactsClient(ctx.env)
      await artifacts.forkRepo(source.repo.artifacts_name, name, {
        description: source.repo.description,
        defaultBranchOnly: request.defaultBranchOnly,
      })

      const repo = await insertRepo(ctx, {
        ownerId: target.id,
        name: targetName,
        description: source.repo.description,
        visibility: source.repo.visibility === 'public' ? Visibility.PUBLIC : Visibility.PRIVATE,
        defaultBranch: source.repo.default_branch,
        artifactsName: name,
        hasWiki: source.repo.has_wiki === 1,
        hasIssues: source.repo.has_issues === 1,
        status: 'forking',
        isFork: true,
        parentRepoId: source.repo.id,
      })

      ctx.waitUntil(
        ctx.env.DB.prepare(`UPDATE repos SET fork_count = fork_count + 1 WHERE id = ?1`)
          .bind(source.repo.id)
          .run(),
      )

      return create(ForkRepoResponseSchema, {
        repo: toRepo(repo, target.login, target.kind, Permission.ADMIN, ctx),
      })
    },

    async getRepo(request, context) {
      const ctx = contextFrom(context.values)
      const found = await findRepoForViewer(ctx.env.DB, request.owner, request.name, viewerOf(ctx))
      if (!found) throw ForgeError.notFound('Repository')

      const extras = await loadViewerExtras(ctx, found.repo.id)
      return create(GetRepoResponseSchema, {
        repo: toRepo(
          found.repo,
          found.repo.owner_login,
          found.repo.owner_kind,
          toProtoPermission(found.access.permission),
          ctx,
          extras,
        ),
      })
    },

    async listRepos(request, context) {
      const ctx = contextFrom(context.values)
      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)
      const cursor = request.page?.cursor ?? ''

      const filters: string[] = []
      const binds: unknown[] = []

      // Visibility is enforced in SQL rather than by filtering afterwards, so
      // pagination cannot return a short page full of rows the caller may not see.
      if (ctx.viewer.isSiteAdmin) {
        filters.push('1 = 1')
      } else if (ctx.viewer.id) {
        binds.push(ctx.viewer.id)
        const p = `?${binds.length}`
        filters.push(`(
          r.visibility = 'public'
          OR r.owner_id = ${p}
          OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = ${p})
          OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = r.owner_id AND m.user_id = ${p})
        )`)
      } else {
        filters.push(`r.visibility = 'public'`)
      }

      if (request.owner) {
        binds.push(request.owner.toLowerCase())
        filters.push(`o.login_lower = ?${binds.length}`)
      }
      if (request.starredByViewer && ctx.viewer.id) {
        binds.push(ctx.viewer.id)
        filters.push(`EXISTS (SELECT 1 FROM stars s WHERE s.repo_id = r.id AND s.user_id = ?${binds.length})`)
      }
      if (request.query) {
        // FTS is contentless, so the index is joined on rowid and the row itself
        // comes from `repos` — see migrations/0004_search.sql.
        binds.push(sanitizeFtsQuery(request.query))
        filters.push(`r.rowid IN (SELECT f.rowid FROM repos_fts f WHERE repos_fts MATCH ?${binds.length})`)
      }
      if (cursor) {
        binds.push(cursor)
        filters.push(`r.id < ?${binds.length}`)
      }

      // IDs are time-sortable (ULID layout), so `id < cursor` is a valid keyset
      // cursor for the default ordering and needs no extra index.
      const order =
        request.sort === RepoSort.NAME
          ? 'r.name_lower ASC, r.id DESC'
          : request.sort === RepoSort.STARS
            ? 'r.star_count DESC, r.id DESC'
            : request.sort === RepoSort.CREATED
              ? 'r.id DESC'
              : 'r.updated_at DESC, r.id DESC'

      binds.push(limit + 1)
      const rows = await ctx.env.DB.prepare(
        `SELECT r.*, o.login AS owner_login, o.kind AS owner_kind
         FROM repos r JOIN owners o ON o.id = r.owner_id
         WHERE ${filters.join(' AND ')}
         ORDER BY ${order}
         LIMIT ?${binds.length}`,
      )
        .bind(...binds)
        .all<RepoRow>()

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      return create(ListReposResponseSchema, {
        repos: page.map((row) =>
          toRepo(row, row.owner_login, row.owner_kind, Permission.UNSPECIFIED, ctx),
        ),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
      })
    },

    async updateRepo(request, context) {
      const ctx = contextFrom(context.values)
      const found = await requireRepo(ctx.env.DB, request.owner, request.name, viewerOf(ctx), 'admin')

      const sets: string[] = []
      const binds: unknown[] = [found.repo.id]

      const set = (column: string, value: unknown) => {
        binds.push(value)
        sets.push(`${column} = ?${binds.length}`)
      }

      if (request.description !== undefined) set('description', request.description)
      if (request.visibility !== undefined && request.visibility !== Visibility.UNSPECIFIED) {
        set('visibility', request.visibility === Visibility.PUBLIC ? 'public' : 'private')
      }
      if (request.defaultBranch !== undefined) set('default_branch', request.defaultBranch)
      if (request.archived !== undefined) set('archived', request.archived ? 1 : 0)
      if (request.hasWiki !== undefined) set('has_wiki', request.hasWiki ? 1 : 0)
      if (request.hasIssues !== undefined) set('has_issues', request.hasIssues ? 1 : 0)
      if (request.ciEnabled !== undefined) set('ci_enabled', request.ciEnabled ? 1 : 0)

      if (request.newName !== undefined && request.newName !== found.repo.name) {
        // The Artifacts repo name is not renamed with it: renaming git storage
        // would break every clone URL and there is no rename API. The D1 row
        // keeps pointing at the original artifacts_name, which is why that
        // column exists separately from `name`.
        assertRepoName(request.newName)
        await assertRepoAvailable(ctx, found.repo.owner_id, request.newName)
        set('name', request.newName)
        set('name_lower', request.newName.toLowerCase())
      }

      set('updated_at', Date.now())
      await ctx.env.DB.prepare(`UPDATE repos SET ${sets.join(', ')} WHERE id = ?1`)
        .bind(...binds)
        .run()

      const reloaded = await requireRepo(
        ctx.env.DB,
        found.repo.owner_login,
        request.newName || found.repo.name,
        viewerOf(ctx),
      )
      return create(UpdateRepoResponseSchema, {
        repo: toRepo(
          reloaded.repo,
          reloaded.repo.owner_login,
          reloaded.repo.owner_kind,
          toProtoPermission(reloaded.access.permission),
          ctx,
        ),
      })
    },

    async deleteRepo(request, context) {
      const ctx = contextFrom(context.values)
      const found = await requireRepo(ctx.env.DB, request.owner, request.name, viewerOf(ctx), 'admin')

      // D1 first: if Artifacts deletion fails the forge row is already gone and
      // the orphan is reclaimable, whereas the reverse leaves a repo that lists
      // fine and 404s on clone.
      await ctx.env.DB.prepare(`DELETE FROM repos WHERE id = ?1`).bind(found.repo.id).run()
      await new ArtifactsClient(ctx.env).deleteRepo(found.repo.artifacts_name)

      return create(DeleteRepoResponseSchema, {})
    },

    async setStar(request, context) {
      const ctx = contextFrom(context.values)
      requireViewer(ctx)
      const found = await requireRepo(ctx.env.DB, request.owner, request.name, viewerOf(ctx), 'read')
      const userId = ctx.viewer.id!

      if (request.starred) {
        await ctx.env.DB.prepare(
          `INSERT INTO stars (repo_id, user_id, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (repo_id, user_id) DO NOTHING`,
        )
          .bind(found.repo.id, userId, Date.now())
          .run()
      } else {
        await ctx.env.DB.prepare(`DELETE FROM stars WHERE repo_id = ?1 AND user_id = ?2`)
          .bind(found.repo.id, userId)
          .run()
      }

      // Recount rather than incrementing: starring twice is a no-op above, and a
      // blind +1 would drift the counter away from the truth.
      const counted = await ctx.env.DB.prepare(
        `UPDATE repos SET star_count = (SELECT count(*) FROM stars WHERE repo_id = ?1)
         WHERE id = ?1 RETURNING star_count`,
      )
        .bind(found.repo.id)
        .first<{ star_count: number }>()

      return create(SetStarResponseSchema, { starCount: counted?.star_count ?? 0 })
    },

    async setWatch(request, context) {
      const ctx = contextFrom(context.values)
      requireViewer(ctx)
      const found = await requireRepo(ctx.env.DB, request.owner, request.name, viewerOf(ctx), 'read')

      if (request.watching) {
        await ctx.env.DB.prepare(
          `INSERT INTO watches (repo_id, user_id, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (repo_id, user_id) DO NOTHING`,
        )
          .bind(found.repo.id, ctx.viewer.id, Date.now())
          .run()
      } else {
        await ctx.env.DB.prepare(`DELETE FROM watches WHERE repo_id = ?1 AND user_id = ?2`)
          .bind(found.repo.id, ctx.viewer.id)
          .run()
      }

      return create(SetWatchResponseSchema, {})
    },
  })
}

// ── helpers ──────────────────────────────────────────────────────────────────

function viewerOf(ctx: RequestContext) {
  return { id: ctx.viewer.id, isSiteAdmin: ctx.viewer.isSiteAdmin }
}

function requireViewer(ctx: RequestContext): { id: string; login: string } {
  if (!ctx.viewer.id || !ctx.viewer.login) throw ForgeError.unauthenticated()
  return { id: ctx.viewer.id, login: ctx.viewer.login }
}

async function assertRepoAvailable(ctx: RequestContext, ownerId: string, name: string): Promise<void> {
  const taken = await ctx.env.DB.prepare(
    `SELECT 1 FROM repos WHERE owner_id = ?1 AND name_lower = ?2`,
  )
    .bind(ownerId, name.toLowerCase())
    .first()
  if (taken) throw new ForgeError('already_exists', `A repository named "${name}" already exists`)
}

interface InsertRepoInput {
  ownerId: string
  name: string
  description: string
  visibility: Visibility
  defaultBranch: string
  artifactsName: string
  hasWiki: boolean
  hasIssues: boolean
  status?: string
  isFork?: boolean
  parentRepoId?: string
  isMirror?: boolean
  mirrorSourceUrl?: string
}

async function insertRepo(ctx: RequestContext, input: InsertRepoInput): Promise<RepoRow> {
  const id = newId()
  const now = Date.now()
  const visibility = input.visibility === Visibility.PUBLIC ? 'public' : 'private'

  await ctx.env.DB.prepare(
    `INSERT INTO repos (
       id, owner_id, name, name_lower, description, visibility, default_branch,
       artifacts_name, status, is_fork, parent_repo_id, is_mirror, mirror_source_url,
       has_wiki, has_issues, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)`,
  )
    .bind(
      id,
      input.ownerId,
      input.name,
      input.name.toLowerCase(),
      input.description,
      visibility,
      input.defaultBranch,
      input.artifactsName,
      input.status ?? 'ready',
      input.isFork ? 1 : 0,
      input.parentRepoId ?? null,
      input.isMirror ? 1 : 0,
      input.mirrorSourceUrl ?? '',
      input.hasWiki ? 1 : 0,
      input.hasIssues ? 1 : 0,
      now,
    )
    .run()

  const row = await ctx.env.DB.prepare(
    `SELECT r.*, o.login AS owner_login, o.kind AS owner_kind
     FROM repos r JOIN owners o ON o.id = r.owner_id WHERE r.id = ?1`,
  )
    .bind(id)
    .first<RepoRow>()

  if (!row) throw new ForgeError('internal', 'Repository row vanished after insert')
  return row
}

async function loadViewerExtras(
  ctx: RequestContext,
  repoId: string,
): Promise<{ starred: boolean; watching: boolean; openIssues: number; openPulls: number }> {
  const [starred, watching, counts] = await Promise.all([
    ctx.viewer.id
      ? ctx.env.DB.prepare(`SELECT 1 FROM stars WHERE repo_id = ?1 AND user_id = ?2`)
          .bind(repoId, ctx.viewer.id)
          .first()
      : Promise.resolve(null),
    ctx.viewer.id
      ? ctx.env.DB.prepare(`SELECT 1 FROM watches WHERE repo_id = ?1 AND user_id = ?2`)
          .bind(repoId, ctx.viewer.id)
          .first()
      : Promise.resolve(null),
    ctx.env.DB.prepare(
      `SELECT
         COUNT(*) FILTER (WHERE is_pull = 0 AND state = 'open') AS open_issues,
         COUNT(*) FILTER (WHERE is_pull = 1 AND state = 'open') AS open_pulls
       FROM issues WHERE repo_id = ?1`,
    )
      .bind(repoId)
      .first<{ open_issues: number; open_pulls: number }>(),
  ])

  return {
    starred: starred !== null,
    watching: watching !== null,
    openIssues: counts?.open_issues ?? 0,
    openPulls: counts?.open_pulls ?? 0,
  }
}

function toRepo(
  row: RepoRow,
  ownerLogin: string,
  ownerKind: 'user' | 'org',
  permission: Permission,
  ctx: RequestContext,
  extras?: { starred: boolean; watching: boolean; openIssues: number; openPulls: number },
) {
  const fullName = `${ownerLogin}/${row.name}`
  return create(RepoSchema, {
    id: row.id,
    owner: create(OwnerSchema, {
      id: row.owner_id,
      login: ownerLogin,
      displayName: ownerLogin,
      isOrg: ownerKind === 'org',
    }),
    name: row.name,
    description: row.description,
    visibility: row.visibility === 'public' ? Visibility.PUBLIC : Visibility.PRIVATE,
    defaultBranch: row.default_branch,
    artifactsName: row.artifacts_name,
    // The raw Artifacts remote is only useful with a repo-scoped token, so it is
    // withheld from anyone who could not mint one anyway.
    artifactsRemote:
      permission === Permission.ADMIN ? new ArtifactsClient(ctx.env).remoteFor(row.artifacts_name) : '',
    cloneUrl: `${ctx.origin}/${fullName}.git`,
    sshUrl: `git@${new URL(ctx.origin).hostname}:${fullName}.git`,
    isFork: row.is_fork === 1,
    isMirror: row.is_mirror === 1,
    archived: row.archived === 1,
    hasWiki: row.has_wiki === 1,
    hasIssues: row.has_issues === 1,
    ciEnabled: row.ci_enabled === 1,
    starCount: row.star_count,
    forkCount: row.fork_count,
    openIssueCount: extras?.openIssues ?? 0,
    openPullCount: extras?.openPulls ?? 0,
    viewerPermission: permission,
    viewerStarred: extras?.starred ?? false,
    viewerWatching: extras?.watching ?? false,
    createdAt: timestampFromDate(new Date(row.created_at)),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    ...(row.pushed_at ? { pushedAt: timestampFromDate(new Date(row.pushed_at)) } : {}),
    status: row.status,
  })
}

function toProtoPermission(permission: RbacPermission): Permission {
  switch (permission) {
    case 'admin':
      return Permission.ADMIN
    case 'maintain':
      return Permission.MAINTAIN
    case 'write':
      return Permission.WRITE
    case 'triage':
      return Permission.TRIAGE
    case 'read':
      return Permission.READ
    default:
      return Permission.NONE
  }
}

/**
 * Makes user input safe for an FTS5 MATCH.
 *
 * FTS5 has its own query syntax; an unescaped quote or a bare `NEAR` is a syntax
 * error, which would surface as a 500 on an ordinary search. Each term is
 * quoted and joined so the query is always literal.
 */
function sanitizeFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ''))
    .filter((term) => term.length > 0)
    .map((term) => `"${term}"*`)
  return terms.length > 0 ? terms.join(' ') : '""'
}

export { toProtoPermission, sanitizeFtsQuery }
