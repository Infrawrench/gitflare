/**
 * Permission resolution.
 *
 * A caller's permission on a repo is the *maximum* of every grant that applies
 * to them, never the first one found. Ordering matters: a user can be both an
 * org owner and a member of a read-only team, and taking the first match would
 * silently demote them.
 */

export const PERMISSIONS = ['none', 'read', 'triage', 'write', 'maintain', 'admin'] as const
export type Permission = (typeof PERMISSIONS)[number]

const RANK: Record<Permission, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
}

export function rank(permission: Permission): number {
  return RANK[permission]
}

export function atLeast(actual: Permission, required: Permission): boolean {
  return RANK[actual] >= RANK[required]
}

export function highest(...permissions: Permission[]): Permission {
  return permissions.reduce((best, next) => (RANK[next] > RANK[best] ? next : best), 'none')
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}

/** Every grant that could apply, gathered by the caller before resolving. */
export interface PermissionInputs {
  /** Null for an anonymous request. */
  viewerId: string | null
  /** Site administrators bypass every per-repo grant. */
  isSiteAdmin: boolean
  repoVisibility: 'public' | 'private'
  repoArchived: boolean
  /** Owner of the repo — a user id, or an org id. */
  repoOwnerId: string
  repoOwnerKind: 'user' | 'org'
  /** Set when the repo belongs to an org the viewer is a member of. */
  orgRole: 'member' | 'owner' | null
  /** Direct collaborator grant, if any. */
  collaborator: Permission | null
  /** Permissions from every team the viewer belongs to that covers this repo. */
  teams: Permission[]
}

export interface ResolvedPermission {
  permission: Permission
  /**
   * Archived repos are readable but frozen. This is kept separate from
   * `permission` so the UI can still show an admin their settings page while
   * every write path refuses.
   */
  canWrite: boolean
}

export function resolvePermission(inputs: PermissionInputs): ResolvedPermission {
  const permission = gather(inputs)
  return {
    permission,
    canWrite: !inputs.repoArchived && atLeast(permission, 'write'),
  }
}

function gather(inputs: PermissionInputs): Permission {
  if (inputs.isSiteAdmin) return 'admin'

  // A personal repo's owner always has full control over it.
  if (
    inputs.viewerId !== null &&
    inputs.repoOwnerKind === 'user' &&
    inputs.repoOwnerId === inputs.viewerId
  ) {
    return 'admin'
  }

  // Org owners administer every repo in the org.
  if (inputs.orgRole === 'owner') return 'admin'

  const grants: Permission[] = []
  // Anyone, signed in or not, can read a public repo.
  if (inputs.repoVisibility === 'public') grants.push('read')
  if (inputs.viewerId !== null) {
    if (inputs.collaborator) grants.push(inputs.collaborator)
    grants.push(...inputs.teams)
  }

  return highest(...grants)
}

/**
 * Whether a repo is visible at all. Distinguished from a permission check so
 * callers can return 404 rather than 403 for a private repo — a 403 would
 * confirm the repo exists to someone who should not know that.
 */
export function canSee(inputs: PermissionInputs): boolean {
  return atLeast(gather(inputs), 'read')
}
