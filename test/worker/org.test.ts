import { beforeEach, describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import { addOrgMember, createOrg, createRepo, createUser, resetDatabase, testEnv } from './helpers'
import { generatePat } from '~/server/auth/tokens'

/**
 * Organizations and teams over the Connect wire.
 *
 * The interesting cases are the ones that would quietly break the permission
 * model: an org losing its last owner (nothing else can restore one), a team
 * reaching a repo in another org, and a team gaining a member who is not in the
 * org at all.
 */

beforeEach(async () => {
  await resetDatabase()
})

/** Issues a PAT for a user so requests can be made as them. */
async function tokenFor(userId: string): Promise<string> {
  const generated = await generatePat()
  await testEnv.DB.prepare(
    `INSERT INTO access_tokens (id, user_id, name, token_hash, prefix, scopes, created_at)
     VALUES (?1, ?2, 'test', ?3, ?4, '[]', ?5)`,
  )
    .bind(`t${userId}`, userId, generated.hash, generated.prefix, Date.now())
    .run()
  return generated.plaintext
}

async function rpc(method: string, body: unknown, token?: string): Promise<Record<string, never>> {
  const response = await SELF.fetch(`https://gitflare.test/api/forge.v1.OrgService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return (await response.json()) as Record<string, never>
}

describe('membership', () => {
  it('refuses to remove the last owner', async () => {
    // Nothing else in the system can restore an owner, so an org with none is
    // permanently unadministerable.
    const user = await createUser('astrid')
    const org = await createOrg('acme')
    await addOrgMember(org, user, 'owner')
    const token = await tokenFor(user)

    const body = await rpc(
      'RemoveOrgMember',
      { orgLogin: 'acme', userLogin: 'astrid' },
      token,
    )
    expect(body.code).toBe('failed_precondition')
    expect(String(body.message)).toContain('at least one owner')
  })

  it('allows removing an owner when another remains', async () => {
    const first = await createUser('astrid')
    const second = await createUser('sam')
    const org = await createOrg('acme')
    await addOrgMember(org, first, 'owner')
    await addOrgMember(org, second, 'owner')

    const body = await rpc(
      'RemoveOrgMember',
      { orgLogin: 'acme', userLogin: 'sam' },
      await tokenFor(first),
    )
    expect(body.code).toBeUndefined()
  })

  it('lets a plain member remove nobody', async () => {
    const owner = await createUser('astrid')
    const member = await createUser('sam')
    const org = await createOrg('acme')
    await addOrgMember(org, owner, 'owner')
    await addOrgMember(org, member, 'member')

    const body = await rpc(
      'RemoveOrgMember',
      { orgLogin: 'acme', userLogin: 'astrid' },
      await tokenFor(member),
    )
    expect(body.code).toBe('permission_denied')
  })
})

describe('teams', () => {
  it('refuses a team member who is not in the org', async () => {
    // A team grants access to org repos; letting an outsider join one would be
    // a way around org membership entirely.
    const owner = await createUser('astrid')
    await createUser('outsider')
    const org = await createOrg('acme')
    await addOrgMember(org, owner, 'owner')
    const token = await tokenFor(owner)

    const created = await rpc(
      'CreateTeam',
      { orgLogin: 'acme', name: 'backend', permission: 'PERMISSION_WRITE' },
      token,
    )
    const teamId = (created.team as unknown as { id: string }).id

    const body = await rpc(
      'SetTeamMember',
      { teamId, userLogin: 'outsider', member: true },
      token,
    )
    expect(body.code).toBe('invalid_argument')
    expect(String(body.message)).toContain('not a member')
  })

  it('refuses to grant a team a repo from another organization', async () => {
    const owner = await createUser('astrid')
    const orgA = await createOrg('acme')
    const orgB = await createOrg('other')
    await addOrgMember(orgA, owner, 'owner')
    await createRepo(orgB, 'not-ours')
    const token = await tokenFor(owner)

    const created = await rpc(
      'CreateTeam',
      { orgLogin: 'acme', name: 'backend', permission: 'PERMISSION_ADMIN' },
      token,
    )
    const teamId = (created.team as unknown as { id: string }).id

    const body = await rpc(
      'SetTeamRepo',
      { teamId, repoOwner: 'other', repoName: 'not-ours', granted: true },
      token,
    )
    expect(body.code).toBe('invalid_argument')
  })

  it('rejects a duplicate team name in the same org', async () => {
    const owner = await createUser('astrid')
    const org = await createOrg('acme')
    await addOrgMember(org, owner, 'owner')
    const token = await tokenFor(owner)

    const create = { orgLogin: 'acme', name: 'backend', permission: 'PERMISSION_READ' }
    expect((await rpc('CreateTeam', create, token)).code).toBeUndefined()
    expect((await rpc('CreateTeam', create, token)).code).toBe('already_exists')
  })

  it('hides team names from non-members even in a public org', async () => {
    // Team names and permissions describe who can reach what.
    const owner = await createUser('astrid')
    const outsider = await createUser('mallory')
    const org = await createOrg('acme')
    await addOrgMember(org, owner, 'owner')
    await testEnv.DB.prepare(`UPDATE owners SET visibility = 'public' WHERE id = ?1`)
      .bind(org)
      .run()

    const body = await rpc('ListTeams', { orgLogin: 'acme' }, await tokenFor(outsider))
    expect(body.code).toBe('not_found')
  })
})

describe('organizations', () => {
  it('refuses to delete an org that still owns repos', async () => {
    // Deleting would cascade the repos away, taking issues and history with them.
    const owner = await createUser('astrid')
    const org = await createOrg('acme')
    await addOrgMember(org, owner, 'owner')
    await createRepo(org, 'service')

    const body = await rpc('DeleteOrg', { login: 'acme' }, await tokenFor(owner))
    expect(body.code).toBe('failed_precondition')
    expect(String(body.message)).toContain('repositor')
  })

  it('reports a private org as not found to outsiders', async () => {
    const owner = await createUser('astrid')
    const outsider = await createUser('mallory')
    const org = await createOrg('acme')
    await addOrgMember(org, owner, 'owner')
    // The helper leaves orgs public, matching the column default.
    await testEnv.DB.prepare(`UPDATE owners SET visibility = 'private' WHERE id = ?1`)
      .bind(org)
      .run()

    const body = await rpc('GetOrg', { login: 'acme' }, await tokenFor(outsider))
    expect(body.code).toBe('not_found')
  })

  it('makes the creator an owner', async () => {
    // Otherwise the org would be unadministerable from the moment it exists.
    const user = await createUser('astrid')
    const token = await tokenFor(user)

    expect((await rpc('CreateOrg', { login: 'acme', displayName: 'Acme' }, token)).code).toBeUndefined()

    const body = await rpc('GetOrg', { login: 'acme' }, token)
    expect(body.viewerRole).toBe('ORG_ROLE_OWNER')
  })

  it('rejects an org login that collides with a user', async () => {
    const user = await createUser('astrid')
    const body = await rpc('CreateOrg', { login: 'astrid' }, await tokenFor(user))
    expect(body.code).toBe('already_exists')
  })
})
