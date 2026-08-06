import { beforeEach, describe, expect, it } from 'vitest'
import { findRepoForViewer, requireRepo } from '~/server/db/repos'
import { ForgeError } from '~/server/errors'
import {
  addCollaborator,
  addOrgMember,
  addTeamMember,
  addTeamRepo,
  createOrg,
  createRepo,
  createTeam,
  createUser,
  resetDatabase,
  testEnv,
} from './helpers'

/**
 * Permission resolution against a real D1 database.
 *
 * The unit tests in `rbac.test.ts` cover the pure resolver: given a set of
 * grants, which wins. These cover the part that can only fail in SQL — whether
 * `resolveAccess` actually *finds* those grants across the collaborator, team,
 * and org-membership joins. A mistake there is a security bug that a
 * resolver-level test cannot see, because the resolver would be handed an empty
 * list and correctly answer "no access".
 */

// The schema is applied once by setup.ts; each test starts from empty tables.
beforeEach(async () => {
  await resetDatabase()
})

const anonymous = { id: null, isSiteAdmin: false }
const asUser = (id: string) => ({ id, isSiteAdmin: false })

describe('visibility', () => {
  it('hides a private repo from anonymous callers', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'secret', { visibility: 'private' })

    // Null, not a permission of "none": callers must not be able to tell a
    // private repo apart from one that does not exist.
    expect(await findRepoForViewer(testEnv.DB, 'astrid', 'secret', anonymous)).toBeNull()
  })

  it('shows a public repo to anonymous callers as read-only', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'open', { visibility: 'public' })

    const found = await findRepoForViewer(testEnv.DB, 'astrid', 'open', anonymous)
    expect(found?.access.permission).toBe('read')
    expect(found?.access.canWrite).toBe(false)
  })

  it('resolves owner and repo names case-insensitively', async () => {
    const owner = await createUser('Astrid')
    await createRepo(owner, 'GitFlare', { visibility: 'public' })

    const found = await findRepoForViewer(testEnv.DB, 'ASTRID', 'gitflare', anonymous)
    expect(found?.repo.name).toBe('GitFlare')
  })
})

describe('direct ownership', () => {
  it('gives a user admin on their own private repo', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'mine')

    const found = await findRepoForViewer(testEnv.DB, 'astrid', 'mine', asUser(owner))
    expect(found?.access.permission).toBe('admin')
  })

  it('does not leak another user’s private repo', async () => {
    const owner = await createUser('astrid')
    const other = await createUser('mallory')
    await createRepo(owner, 'mine')

    expect(await findRepoForViewer(testEnv.DB, 'astrid', 'mine', asUser(other))).toBeNull()
  })
})

describe('collaborators', () => {
  it('grants the collaborator’s permission', async () => {
    const owner = await createUser('astrid')
    const collaborator = await createUser('sam')
    const repo = await createRepo(owner, 'api')
    await addCollaborator(repo, collaborator, 'write')

    const found = await findRepoForViewer(testEnv.DB, 'astrid', 'api', asUser(collaborator))
    expect(found?.access.permission).toBe('write')
    expect(found?.access.canWrite).toBe(true)
  })

  it('does not grant a collaborator on a different repo', async () => {
    // Guards against a join that forgets to filter by repo_id.
    const owner = await createUser('astrid')
    const collaborator = await createUser('sam')
    const granted = await createRepo(owner, 'granted')
    await createRepo(owner, 'other')
    await addCollaborator(granted, collaborator, 'admin')

    expect(await findRepoForViewer(testEnv.DB, 'astrid', 'other', asUser(collaborator))).toBeNull()
  })
})

describe('organizations and teams', () => {
  it('gives org owners admin on every repo in the org', async () => {
    const org = await createOrg('acme')
    const user = await createUser('astrid')
    await addOrgMember(org, user, 'owner')
    await createRepo(org, 'service')

    const found = await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(user))
    expect(found?.access.permission).toBe('admin')
  })

  it('gives a plain org member nothing without a team or collaborator grant', async () => {
    const org = await createOrg('acme')
    const user = await createUser('astrid')
    await addOrgMember(org, user, 'member')
    await createRepo(org, 'service', { visibility: 'private' })

    expect(await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(user))).toBeNull()
  })

  it('grants team permission on an explicitly assigned repo', async () => {
    const org = await createOrg('acme')
    const user = await createUser('astrid')
    await addOrgMember(org, user, 'member')
    const repo = await createRepo(org, 'service')
    const team = await createTeam(org, 'backend', 'maintain')
    await addTeamMember(team, user)
    await addTeamRepo(team, repo)

    const found = await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(user))
    expect(found?.access.permission).toBe('maintain')
  })

  it('grants an includes_all_repos team access without a team_repos row', async () => {
    // This is the branch that covers repos created after the team existed.
    const org = await createOrg('acme')
    const user = await createUser('astrid')
    await addOrgMember(org, user, 'member')
    await createRepo(org, 'created-later')
    const team = await createTeam(org, 'everyone', 'write', { allRepos: true })
    await addTeamMember(team, user)

    const found = await findRepoForViewer(testEnv.DB, 'acme', 'created-later', asUser(user))
    expect(found?.access.permission).toBe('write')
  })

  it('does not grant access through a team the user is not in', async () => {
    const org = await createOrg('acme')
    const outsider = await createUser('mallory')
    await addOrgMember(org, outsider, 'member')
    const repo = await createRepo(org, 'service')
    const team = await createTeam(org, 'backend', 'admin')
    await addTeamRepo(team, repo)

    expect(await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(outsider))).toBeNull()
  })

  it('does not leak a team from another organization', async () => {
    // The team query filters on org_id; without it, a team in any org that
    // happened to reference this repo would grant access.
    const orgA = await createOrg('acme')
    const orgB = await createOrg('other')
    const user = await createUser('mallory')
    const repo = await createRepo(orgA, 'service')

    const foreignTeam = await createTeam(orgB, 'sneaky', 'admin')
    await addTeamMember(foreignTeam, user)
    await addTeamRepo(foreignTeam, repo)

    expect(await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(user))).toBeNull()
  })

  it('takes the strongest grant when several apply', async () => {
    const org = await createOrg('acme')
    const user = await createUser('astrid')
    await addOrgMember(org, user, 'member')
    const repo = await createRepo(org, 'service')

    await addCollaborator(repo, user, 'read')
    const weak = await createTeam(org, 'readers', 'triage')
    const strong = await createTeam(org, 'admins', 'maintain')
    for (const team of [weak, strong]) {
      await addTeamMember(team, user)
      await addTeamRepo(team, repo)
    }

    const found = await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(user))
    expect(found?.access.permission).toBe('maintain')
  })

  it('does not let a read-only team demote an org owner', async () => {
    const org = await createOrg('acme')
    const user = await createUser('astrid')
    await addOrgMember(org, user, 'owner')
    const repo = await createRepo(org, 'service')
    const team = await createTeam(org, 'readers', 'read')
    await addTeamMember(team, user)
    await addTeamRepo(team, repo)

    const found = await findRepoForViewer(testEnv.DB, 'acme', 'service', asUser(user))
    expect(found?.access.permission).toBe('admin')
  })
})

describe('site administrators', () => {
  it('can see any private repo', async () => {
    const owner = await createUser('astrid')
    const admin = await createUser('root', { isAdmin: true })
    await createRepo(owner, 'secret')

    const found = await findRepoForViewer(testEnv.DB, 'astrid', 'secret', {
      id: admin,
      isSiteAdmin: true,
    })
    expect(found?.access.permission).toBe('admin')
  })
})

describe('requireRepo', () => {
  it('reports a hidden repo as not found rather than forbidden', async () => {
    const owner = await createUser('astrid')
    const other = await createUser('mallory')
    await createRepo(owner, 'secret')

    await expect(
      requireRepo(testEnv.DB, 'astrid', 'secret', asUser(other)),
    ).rejects.toMatchObject({ kind: 'not_found' })
  })

  it('refuses a write when the caller only has read', async () => {
    const owner = await createUser('astrid')
    const reader = await createUser('sam')
    const repo = await createRepo(owner, 'api')
    await addCollaborator(repo, reader, 'read')

    await expect(
      requireRepo(testEnv.DB, 'astrid', 'api', asUser(reader), 'write'),
    ).rejects.toBeInstanceOf(ForgeError)
  })

  it('refuses writes to an archived repo even for its owner', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'frozen', { archived: true })

    // Still admin — the settings page must remain reachable — but not writable.
    const found = await requireRepo(testEnv.DB, 'astrid', 'frozen', asUser(owner))
    expect(found.access.permission).toBe('admin')
    expect(found.access.canWrite).toBe(false)

    await expect(
      requireRepo(testEnv.DB, 'astrid', 'frozen', asUser(owner), 'write'),
    ).rejects.toMatchObject({ kind: 'failed_precondition' })
  })
})
