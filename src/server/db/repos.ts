import { ForgeError } from '../errors'
import { resolvePermission, type Permission, type ResolvedPermission } from '../auth/rbac'

/**
 * Repo lookups, including the permission join.
 *
 * Resolving a repo and resolving who may touch it are deliberately one
 * operation: every caller needs both, and splitting them invites a code path
 * that loads a repo and forgets to check access.
 */

export interface RepoRow {
  id: string
  owner_id: string
  owner_login: string
  owner_kind: 'user' | 'org'
  name: string
  description: string
  visibility: 'public' | 'private'
  default_branch: string
  artifacts_name: string
  status: string
  is_fork: number
  parent_repo_id: string | null
  is_mirror: number
  archived: number
  has_wiki: number
  has_issues: number
  ci_enabled: number
  star_count: number
  fork_count: number
  created_at: number
  updated_at: number
  pushed_at: number | null
}

export interface RepoWithAccess {
  repo: RepoRow
  access: ResolvedPermission
}

const REPO_SELECT = `
  SELECT r.*, o.login AS owner_login, o.kind AS owner_kind
  FROM repos r
  JOIN owners o ON o.id = r.owner_id
`

/**
 * Loads a repo and the caller's permission on it.
 *
 * Returns null when the repo does not exist *or* the caller cannot see it —
 * the two are deliberately indistinguishable, so a 404 never confirms the
 * existence of a private repo to someone without access.
 */
export async function findRepoForViewer(
  db: D1Database,
  owner: string,
  name: string,
  viewer: { id: string | null; isSiteAdmin: boolean },
): Promise<RepoWithAccess | null> {
  const repo = await db
    .prepare(`${REPO_SELECT} WHERE o.login_lower = ?1 AND r.name_lower = ?2`)
    .bind(owner.toLowerCase(), name.toLowerCase())
    .first<RepoRow>()

  if (!repo) return null

  const access = await resolveAccess(db, repo, viewer)
  return access.permission === 'none' ? null : { repo, access }
}

/** Like findRepoForViewer, but throws the appropriate error instead of returning null. */
export async function requireRepo(
  db: D1Database,
  owner: string,
  name: string,
  viewer: { id: string | null; isSiteAdmin: boolean },
  required: Permission = 'read',
): Promise<RepoWithAccess> {
  const found = await findRepoForViewer(db, owner, name, viewer)
  if (!found) throw ForgeError.notFound('Repository')

  const { access } = found
  if (rankOf(access.permission) < rankOf(required)) {
    throw ForgeError.permissionDenied()
  }
  // Archived repos stay readable but reject every write, whatever the grant.
  if (rankOf(required) >= rankOf('write') && !access.canWrite) {
    throw new ForgeError(
      'failed_precondition',
      found.repo.archived
        ? 'This repository is archived. Unarchive it before making changes.'
        : 'You do not have write access to this repository.',
    )
  }
  return found
}

/**
 * Gathers every grant that could apply and resolves them together.
 *
 * The two queries are unconditional for a signed-in viewer rather than
 * short-circuited on the first hit, because the answer is the maximum across
 * all of them — see resolvePermission.
 */
async function resolveAccess(
  db: D1Database,
  repo: RepoRow,
  viewer: { id: string | null; isSiteAdmin: boolean },
): Promise<ResolvedPermission> {
  if (viewer.id === null || viewer.isSiteAdmin) {
    return resolvePermission({
      viewerId: viewer.id,
      isSiteAdmin: viewer.isSiteAdmin,
      repoVisibility: repo.visibility,
      repoArchived: repo.archived === 1,
      repoOwnerId: repo.owner_id,
      repoOwnerKind: repo.owner_kind,
      orgRole: null,
      collaborator: null,
      teams: [],
    })
  }

  const [collaborator, teams, orgMembership] = await Promise.all([
    db
      .prepare(`SELECT permission FROM repo_collaborators WHERE repo_id = ?1 AND user_id = ?2`)
      .bind(repo.id, viewer.id)
      .first<{ permission: Permission }>(),

    // A team reaches a repo either through an explicit team_repos grant or by
    // being marked includes_all_repos, which covers repos created after the team.
    db
      .prepare(
        `SELECT DISTINCT t.permission
         FROM teams t
         JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?2
         LEFT JOIN team_repos tr ON tr.team_id = t.id AND tr.repo_id = ?1
         WHERE t.org_id = ?3 AND (tr.repo_id IS NOT NULL OR t.includes_all_repos = 1)`,
      )
      .bind(repo.id, viewer.id, repo.owner_id)
      .all<{ permission: Permission }>(),

    repo.owner_kind === 'org'
      ? db
          .prepare(`SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2`)
          .bind(repo.owner_id, viewer.id)
          .first<{ role: 'member' | 'owner' }>()
      : Promise.resolve(null),
  ])

  return resolvePermission({
    viewerId: viewer.id,
    isSiteAdmin: viewer.isSiteAdmin,
    repoVisibility: repo.visibility,
    repoArchived: repo.archived === 1,
    repoOwnerId: repo.owner_id,
    repoOwnerKind: repo.owner_kind,
    orgRole: orgMembership?.role ?? null,
    collaborator: collaborator?.permission ?? null,
    teams: (teams.results ?? []).map((row) => row.permission),
  })
}

const RANKS: Record<Permission, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
}
function rankOf(permission: Permission): number {
  return RANKS[permission]
}

/**
 * Claims the next issue/pull number for a repo.
 *
 * `UPDATE ... RETURNING` is atomic in SQLite, so two concurrent issue creations
 * cannot be handed the same number. Reading then writing would race.
 */
export async function nextIssueNumber(db: D1Database, repoId: string): Promise<number> {
  const row = await db
    .prepare(`UPDATE repos SET next_number = next_number + 1 WHERE id = ?1 RETURNING next_number - 1 AS number`)
    .bind(repoId)
    .first<{ number: number }>()
  if (!row) throw ForgeError.notFound('Repository')
  return row.number
}

/** Same atomic claim, for CI run numbers. */
export async function nextRunNumber(db: D1Database, repoId: string): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE repos SET next_run_number = next_run_number + 1 WHERE id = ?1 RETURNING next_run_number - 1 AS number`,
    )
    .bind(repoId)
    .first<{ number: number }>()
  if (!row) throw ForgeError.notFound('Repository')
  return row.number
}

export async function findRepoByArtifactsName(
  db: D1Database,
  artifactsName: string,
): Promise<RepoRow | null> {
  return db
    .prepare(`${REPO_SELECT} WHERE r.artifacts_name = ?1`)
    .bind(artifactsName)
    .first<RepoRow>()
}

export async function touchPushed(db: D1Database, repoId: string, now = Date.now()): Promise<void> {
  await db
    .prepare(`UPDATE repos SET pushed_at = ?2, updated_at = ?2 WHERE id = ?1`)
    .bind(repoId, now)
    .run()
}
