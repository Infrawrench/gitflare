import { ForgeError } from '../errors'
import { assertLogin } from '../artifacts/names'
import { newId } from '../ids'

/**
 * Owner lookups. Users and orgs share the `owners` table so that `owner/repo`
 * resolves with one query and foreign keys have a single ID space.
 */

export interface OwnerRow {
  id: string
  login: string
  kind: 'user' | 'org'
  display_name: string
  description: string
  avatar_url: string
  visibility: 'public' | 'private'
  created_at: number
}

export async function findOwner(db: D1Database, login: string): Promise<OwnerRow | null> {
  return db
    .prepare(`SELECT * FROM owners WHERE login_lower = ?1`)
    .bind(login.toLowerCase())
    .first<OwnerRow>()
}

export async function requireOwner(db: D1Database, login: string): Promise<OwnerRow> {
  const owner = await findOwner(db, login)
  if (!owner) throw ForgeError.notFound(`"${login}"`)
  return owner
}

export interface UserRow extends OwnerRow {
  email: string
  is_admin: number
}

export async function findUser(db: D1Database, login: string): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT o.*, u.email, u.is_admin
       FROM owners o JOIN users u ON u.owner_id = o.id
       WHERE o.login_lower = ?1`,
    )
    .bind(login.toLowerCase())
    .first<UserRow>()
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT o.*, u.email, u.is_admin
       FROM owners o JOIN users u ON u.owner_id = o.id
       WHERE o.id = ?1`,
    )
    .bind(id)
    .first<UserRow>()
}

/**
 * Resolves the owner a repo should be created under, and checks the caller may
 * do it.
 *
 * Creating under a user means being that user. Creating under an org means
 * being a member of it — org owners obviously, but plain members too, matching
 * how Gitea and GitHub let members create repos unless restricted.
 */
export async function resolveCreateTarget(
  db: D1Database,
  requestedOwner: string,
  viewer: { id: string; login: string },
): Promise<OwnerRow> {
  const login = requestedOwner || viewer.login
  const owner = await requireOwner(db, login)

  if (owner.kind === 'user') {
    if (owner.id !== viewer.id) {
      throw ForgeError.permissionDenied('You can only create repositories under your own account')
    }
    return owner
  }

  const membership = await db
    .prepare(`SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2`)
    .bind(owner.id, viewer.id)
    .first<{ role: string }>()

  if (!membership) {
    throw ForgeError.permissionDenied(`You are not a member of "${owner.login}"`)
  }
  return owner
}

export async function createOrg(
  db: D1Database,
  input: {
    login: string
    displayName: string
    description: string
    visibility: 'public' | 'private'
    creatorId: string
  },
): Promise<OwnerRow> {
  assertLogin(input.login)

  const taken = await db
    .prepare(`SELECT 1 FROM owners WHERE login_lower = ?1`)
    .bind(input.login.toLowerCase())
    .first()
  if (taken) throw new ForgeError('already_exists', `"${input.login}" is already taken`)

  const id = newId()
  const now = Date.now()

  await db.batch([
    db
      .prepare(
        `INSERT INTO owners (id, login, login_lower, kind, display_name, description, visibility, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'org', ?4, ?5, ?6, ?7, ?7)`,
      )
      .bind(id, input.login, input.login.toLowerCase(), input.displayName, input.description, input.visibility, now),
    // The creator becomes an owner, otherwise the org would be unadministerable.
    db
      .prepare(`INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?1, ?2, 'owner', ?3)`)
      .bind(id, input.creatorId, now),
  ])

  return {
    id,
    login: input.login,
    kind: 'org',
    display_name: input.displayName,
    description: input.description,
    avatar_url: '',
    visibility: input.visibility,
    created_at: now,
  }
}

/** Org owners may administer the org itself; members may not. */
export async function requireOrgOwner(
  db: D1Database,
  orgId: string,
  viewer: { id: string | null; isSiteAdmin: boolean },
): Promise<void> {
  if (viewer.isSiteAdmin) return
  if (!viewer.id) throw ForgeError.unauthenticated()

  const membership = await db
    .prepare(`SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2`)
    .bind(orgId, viewer.id)
    .first<{ role: string }>()

  if (membership?.role !== 'owner') {
    throw ForgeError.permissionDenied('Only organization owners can do that')
  }
}
