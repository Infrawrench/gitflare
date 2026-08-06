import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  OrgService,
  OrgSchema,
  OrgRole,
  OrgMemberSchema,
  TeamSchema,
  CreateOrgResponseSchema,
  GetOrgResponseSchema,
  ListOrgsResponseSchema,
  UpdateOrgResponseSchema,
  DeleteOrgResponseSchema,
  ListOrgMembersResponseSchema,
  AddOrgMemberResponseSchema,
  RemoveOrgMemberResponseSchema,
  ListTeamsResponseSchema,
  CreateTeamResponseSchema,
  UpdateTeamResponseSchema,
  DeleteTeamResponseSchema,
  SetTeamMemberResponseSchema,
  SetTeamRepoResponseSchema,
} from '~/gen/forge/v1/org_pb'
import { PageResponseSchema, Permission, Visibility } from '~/gen/forge/v1/common_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { createOrg, requireOrgOwner, requireOwner, type OwnerRow } from '../../db/owners'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import { isPermission, type Permission as RbacPermission } from '../../auth/rbac'
import { contextFrom, type RequestContext } from '../router'
import { toProtoPermission } from './repo'

/**
 * Organizations and teams.
 *
 * A team grants one permission level across the repos assigned to it, and a
 * user's effective permission on a repo is the maximum over their direct
 * collaborator grant and every team they belong to. That resolution lives in
 * db/repos.ts and is covered by the integration tests; this service only
 * maintains the rows it reads.
 */

export function registerOrgService(router: ConnectRouter): void {
  router.service(OrgService, {
    async createOrg(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewerId(ctx)

      const org = await createOrg(ctx.env.DB, {
        login: request.login,
        displayName: request.displayName || request.login,
        description: request.description,
        visibility: request.visibility === Visibility.PUBLIC ? 'public' : 'private',
        creatorId: viewer,
      })

      return create(CreateOrgResponseSchema, { org: toOrg(org) })
    },

    async getOrg(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.login)

      const role = await roleOf(ctx, org.id, ctx.viewer.id)
      // A private org is invisible to non-members, the same way a private repo
      // is: not-found rather than forbidden.
      if (org.visibility === 'private' && role === null && !ctx.viewer.isSiteAdmin) {
        throw ForgeError.notFound('Organization')
      }

      return create(GetOrgResponseSchema, {
        org: toOrg(org),
        viewerRole: toProtoRole(role),
      })
    },

    async listOrgs(request, context) {
      const ctx = contextFrom(context.values)

      // No user named means "orgs the caller belongs to", which needs a caller.
      const target = request.userLogin
        ? (await requireOwner(ctx.env.DB, request.userLogin)).id
        : requireViewerId(ctx)

      const rows = await ctx.env.DB.prepare(
        `SELECT o.* FROM owners o
         JOIN org_members m ON m.org_id = o.id
         WHERE m.user_id = ?1 AND o.kind = 'org'
           AND (o.visibility = 'public' OR ?2 = 1 OR EXISTS (
             SELECT 1 FROM org_members v WHERE v.org_id = o.id AND v.user_id = ?3
           ))
         ORDER BY o.login_lower`,
      )
        .bind(target, ctx.viewer.isSiteAdmin ? 1 : 0, ctx.viewer.id ?? '')
        .all<OwnerRow>()

      return create(ListOrgsResponseSchema, {
        orgs: (rows.results ?? []).map(toOrg),
        page: create(PageResponseSchema, {}),
      })
    },

    async updateOrg(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.login)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const sets: string[] = []
      const binds: unknown[] = [org.id]
      const set = (column: string, value: unknown) => {
        binds.push(value)
        sets.push(`${column} = ?${binds.length}`)
      }

      if (request.displayName !== undefined) set('display_name', request.displayName)
      if (request.description !== undefined) set('description', request.description)
      if (request.visibility !== undefined && request.visibility !== Visibility.UNSPECIFIED) {
        set('visibility', request.visibility === Visibility.PUBLIC ? 'public' : 'private')
      }

      if (sets.length > 0) {
        binds.push(Date.now())
        await ctx.env.DB.prepare(
          `UPDATE owners SET ${sets.join(', ')}, updated_at = ?${binds.length} WHERE id = ?1`,
        )
          .bind(...binds)
          .run()
      }

      return create(UpdateOrgResponseSchema, { org: toOrg(await requireOrg(ctx, request.login)) })
    },

    async deleteOrg(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.login)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      // Deleting an org would cascade its repos away, taking issues and history
      // with them. Requiring the repos be dealt with first makes that explicit
      // rather than a surprise.
      const repos = await ctx.env.DB.prepare(
        `SELECT count(*) AS count FROM repos WHERE owner_id = ?1`,
      )
        .bind(org.id)
        .first<{ count: number }>()

      if ((repos?.count ?? 0) > 0) {
        throw new ForgeError(
          'failed_precondition',
          `This organization still owns ${repos!.count} repositor${repos!.count === 1 ? 'y' : 'ies'}. Transfer or delete them first.`,
        )
      }

      await ctx.env.DB.prepare(`DELETE FROM owners WHERE id = ?1`).bind(org.id).run()
      return create(DeleteOrgResponseSchema, {})
    },

    async listOrgMembers(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.orgLogin)
      await requireVisible(ctx, org)

      const rows = await ctx.env.DB.prepare(
        `SELECT o.id, o.login, o.display_name, o.avatar_url, m.role
         FROM org_members m JOIN owners o ON o.id = m.user_id
         WHERE m.org_id = ?1 ORDER BY m.role DESC, o.login_lower`,
      )
        .bind(org.id)
        .all<{ id: string; login: string; display_name: string; avatar_url: string; role: string }>()

      return create(ListOrgMembersResponseSchema, {
        members: (rows.results ?? []).map((row) =>
          create(OrgMemberSchema, {
            user: create(UserSchema, {
              id: row.id,
              login: row.login,
              displayName: row.display_name || row.login,
              avatarUrl: row.avatar_url,
            }),
            role: row.role === 'owner' ? OrgRole.OWNER : OrgRole.MEMBER,
          }),
        ),
        page: create(PageResponseSchema, {}),
      })
    },

    async addOrgMember(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.orgLogin)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const user = await requireOwner(ctx.env.DB, request.userLogin)
      if (user.kind !== 'user') throw ForgeError.invalid('Only users can be organization members')

      const role = request.role === OrgRole.OWNER ? 'owner' : 'member'
      await ctx.env.DB.prepare(
        `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role`,
      )
        .bind(org.id, user.id, role, Date.now())
        .run()

      return create(AddOrgMemberResponseSchema, {
        member: create(OrgMemberSchema, {
          user: create(UserSchema, { id: user.id, login: user.login }),
          role: request.role === OrgRole.OWNER ? OrgRole.OWNER : OrgRole.MEMBER,
        }),
      })
    },

    async removeOrgMember(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.orgLogin)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const user = await requireOwner(ctx.env.DB, request.userLogin)

      // An org with no owners cannot be administered by anyone, and nothing else
      // in the system can restore one.
      const owners = await ctx.env.DB.prepare(
        `SELECT count(*) AS count FROM org_members WHERE org_id = ?1 AND role = 'owner'`,
      )
        .bind(org.id)
        .first<{ count: number }>()

      const removing = await ctx.env.DB.prepare(
        `SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2`,
      )
        .bind(org.id, user.id)
        .first<{ role: string }>()

      if (removing?.role === 'owner' && (owners?.count ?? 0) <= 1) {
        throw new ForgeError(
          'failed_precondition',
          'An organization must keep at least one owner. Promote someone else first.',
        )
      }

      await ctx.env.DB.prepare(`DELETE FROM org_members WHERE org_id = ?1 AND user_id = ?2`)
        .bind(org.id, user.id)
        .run()

      return create(RemoveOrgMemberResponseSchema, {})
    },

    async listTeams(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.orgLogin)
      // Team names and permissions describe who can reach what, so they are for
      // members only even when the org itself is public.
      await requireMember(ctx, org)

      const rows = await ctx.env.DB.prepare(
        `SELECT t.*,
           (SELECT count(*) FROM team_members WHERE team_id = t.id) AS member_count,
           (SELECT count(*) FROM team_repos WHERE team_id = t.id) AS repo_count
         FROM teams t WHERE t.org_id = ?1 ORDER BY t.name_lower`,
      )
        .bind(org.id)
        .all<TeamRow>()

      return create(ListTeamsResponseSchema, {
        teams: (rows.results ?? []).map((row) => toTeam(row, org.login)),
      })
    },

    async createTeam(request, context) {
      const ctx = contextFrom(context.values)
      const org = await requireOrg(ctx, request.orgLogin)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const permission = fromProtoPermission(request.permission)
      const id = newId()

      try {
        await ctx.env.DB.prepare(
          `INSERT INTO teams (id, org_id, name, name_lower, description, permission, includes_all_repos, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
          .bind(
            id,
            org.id,
            request.name,
            request.name.toLowerCase(),
            request.description,
            permission,
            request.includesAllRepos ? 1 : 0,
            Date.now(),
          )
          .run()
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
          throw new ForgeError('already_exists', `A team named "${request.name}" already exists`)
        }
        throw error
      }

      return create(CreateTeamResponseSchema, {
        team: create(TeamSchema, {
          id,
          orgLogin: org.login,
          name: request.name,
          description: request.description,
          permission: request.permission,
          includesAllRepos: request.includesAllRepos,
        }),
      })
    },

    async updateTeam(request, context) {
      const ctx = contextFrom(context.values)
      const { org, team } = await requireTeam(ctx, request.teamId)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const name = request.name ?? team.name
      const permission =
        request.permission !== undefined && request.permission !== Permission.UNSPECIFIED
          ? fromProtoPermission(request.permission)
          : team.permission

      await ctx.env.DB.prepare(
        `UPDATE teams SET name = ?2, name_lower = ?3, description = ?4, permission = ?5,
           includes_all_repos = ?6 WHERE id = ?1`,
      )
        .bind(
          team.id,
          name,
          name.toLowerCase(),
          request.description ?? team.description,
          permission,
          request.includesAllRepos !== undefined
            ? request.includesAllRepos
              ? 1
              : 0
            : team.includes_all_repos,
        )
        .run()

      const { team: updated } = await requireTeam(ctx, request.teamId)
      return create(UpdateTeamResponseSchema, { team: toTeam(updated, org.login) })
    },

    async deleteTeam(request, context) {
      const ctx = contextFrom(context.values)
      const { org, team } = await requireTeam(ctx, request.teamId)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      // team_members and team_repos cascade; the repos themselves are untouched.
      await ctx.env.DB.prepare(`DELETE FROM teams WHERE id = ?1`).bind(team.id).run()
      return create(DeleteTeamResponseSchema, {})
    },

    async setTeamMember(request, context) {
      const ctx = contextFrom(context.values)
      const { org, team } = await requireTeam(ctx, request.teamId)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const user = await requireOwner(ctx.env.DB, request.userLogin)

      if (request.member) {
        // A team grants access to org repos, so its members must be in the org.
        const membership = await roleOf(ctx, org.id, user.id)
        if (membership === null) {
          throw ForgeError.invalid(`"${user.login}" is not a member of "${org.login}"`)
        }
        await ctx.env.DB.prepare(
          `INSERT INTO team_members (team_id, user_id, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (team_id, user_id) DO NOTHING`,
        )
          .bind(team.id, user.id, Date.now())
          .run()
      } else {
        await ctx.env.DB.prepare(`DELETE FROM team_members WHERE team_id = ?1 AND user_id = ?2`)
          .bind(team.id, user.id)
          .run()
      }

      return create(SetTeamMemberResponseSchema, {})
    },

    async setTeamRepo(request, context) {
      const ctx = contextFrom(context.values)
      const { org, team } = await requireTeam(ctx, request.teamId)
      await requireOrgOwner(ctx.env.DB, org.id, ctx.viewer)

      const repo = await ctx.env.DB.prepare(
        `SELECT r.id FROM repos r JOIN owners o ON o.id = r.owner_id
         WHERE o.login_lower = ?1 AND r.name_lower = ?2`,
      )
        .bind(request.repoOwner.toLowerCase(), request.repoName.toLowerCase())
        .first<{ id: string }>()

      if (!repo) throw ForgeError.notFound('Repository')

      if (request.granted) {
        // Scoped to this org's repos: a team must not be able to grant itself
        // access to a repository owned by someone else.
        const owned = await ctx.env.DB.prepare(
          `SELECT 1 FROM repos WHERE id = ?1 AND owner_id = ?2`,
        )
          .bind(repo.id, org.id)
          .first()
        if (!owned) throw ForgeError.invalid('That repository does not belong to this organization')

        await ctx.env.DB.prepare(
          `INSERT INTO team_repos (team_id, repo_id, created_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (team_id, repo_id) DO NOTHING`,
        )
          .bind(team.id, repo.id, Date.now())
          .run()
      } else {
        await ctx.env.DB.prepare(`DELETE FROM team_repos WHERE team_id = ?1 AND repo_id = ?2`)
          .bind(team.id, repo.id)
          .run()
      }

      return create(SetTeamRepoResponseSchema, {})
    },
  })
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface TeamRow {
  id: string
  org_id: string
  name: string
  description: string
  permission: RbacPermission
  includes_all_repos: number
  member_count?: number
  repo_count?: number
}

function requireViewerId(ctx: RequestContext): string {
  if (!ctx.viewer.id) throw ForgeError.unauthenticated()
  return ctx.viewer.id
}

async function requireOrg(ctx: RequestContext, login: string): Promise<OwnerRow> {
  const owner = await requireOwner(ctx.env.DB, login)
  if (owner.kind !== 'org') throw ForgeError.notFound('Organization')
  return owner
}

async function roleOf(
  ctx: RequestContext,
  orgId: string,
  userId: string | null,
): Promise<'member' | 'owner' | null> {
  if (!userId) return null
  const row = await ctx.env.DB.prepare(
    `SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2`,
  )
    .bind(orgId, userId)
    .first<{ role: 'member' | 'owner' }>()
  return row?.role ?? null
}

async function requireVisible(ctx: RequestContext, org: OwnerRow): Promise<void> {
  if (org.visibility === 'public' || ctx.viewer.isSiteAdmin) return
  if ((await roleOf(ctx, org.id, ctx.viewer.id)) === null) {
    throw ForgeError.notFound('Organization')
  }
}

async function requireMember(ctx: RequestContext, org: OwnerRow): Promise<void> {
  if (ctx.viewer.isSiteAdmin) return
  if ((await roleOf(ctx, org.id, ctx.viewer.id)) === null) {
    throw ForgeError.notFound('Organization')
  }
}

async function requireTeam(
  ctx: RequestContext,
  teamId: string,
): Promise<{ org: OwnerRow; team: TeamRow }> {
  const team = await ctx.env.DB.prepare(
    `SELECT t.*,
       (SELECT count(*) FROM team_members WHERE team_id = t.id) AS member_count,
       (SELECT count(*) FROM team_repos WHERE team_id = t.id) AS repo_count
     FROM teams t WHERE t.id = ?1`,
  )
    .bind(teamId)
    .first<TeamRow>()
  if (!team) throw ForgeError.notFound('Team')

  const org = await ctx.env.DB.prepare(`SELECT * FROM owners WHERE id = ?1`)
    .bind(team.org_id)
    .first<OwnerRow>()
  if (!org) throw ForgeError.notFound('Organization')

  return { org, team }
}

function toOrg(row: OwnerRow) {
  return create(OrgSchema, {
    id: row.id,
    login: row.login,
    displayName: row.display_name || row.login,
    description: row.description,
    avatarUrl: row.avatar_url,
    visibility: row.visibility === 'public' ? Visibility.PUBLIC : Visibility.PRIVATE,
    createdAt: timestampFromDate(new Date(row.created_at)),
  })
}

function toTeam(row: TeamRow, orgLogin: string) {
  return create(TeamSchema, {
    id: row.id,
    orgLogin,
    name: row.name,
    description: row.description,
    permission: toProtoPermission(row.permission),
    includesAllRepos: row.includes_all_repos === 1,
    memberCount: row.member_count ?? 0,
    repoCount: row.repo_count ?? 0,
  })
}

function toProtoRole(role: 'member' | 'owner' | null) {
  if (role === 'owner') return OrgRole.OWNER
  if (role === 'member') return OrgRole.MEMBER
  return OrgRole.UNSPECIFIED
}

/** Teams cannot grant `none`; the level below read is simply not being a member. */
function fromProtoPermission(permission: Permission): RbacPermission {
  const name =
    {
      [Permission.READ]: 'read',
      [Permission.TRIAGE]: 'triage',
      [Permission.WRITE]: 'write',
      [Permission.MAINTAIN]: 'maintain',
      [Permission.ADMIN]: 'admin',
    }[permission as number] ?? 'read'

  if (!isPermission(name) || name === 'none') {
    throw ForgeError.invalid('A team needs a permission of read or higher')
  }
  return name
}

export type { HandlerContext }
