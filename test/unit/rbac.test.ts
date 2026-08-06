import { describe, expect, it } from 'vitest'
import {
  atLeast,
  canSee,
  highest,
  resolvePermission,
  type PermissionInputs,
} from '~/server/auth/rbac'

function inputs(overrides: Partial<PermissionInputs> = {}): PermissionInputs {
  return {
    viewerId: 'u1',
    isSiteAdmin: false,
    repoVisibility: 'private',
    repoArchived: false,
    repoOwnerId: 'owner1',
    repoOwnerKind: 'org',
    orgRole: null,
    collaborator: null,
    teams: [],
    ...overrides,
  }
}

describe('permission ordering', () => {
  it('ranks levels so a numeric comparison is meaningful', () => {
    expect(atLeast('admin', 'write')).toBe(true)
    expect(atLeast('triage', 'write')).toBe(false)
    expect(atLeast('write', 'write')).toBe(true)
  })

  it('takes the maximum, not the last value', () => {
    expect(highest('read', 'admin', 'triage')).toBe('admin')
    expect(highest()).toBe('none')
  })
})

describe('resolvePermission', () => {
  it('gives a user admin over their own repo', () => {
    const result = resolvePermission(
      inputs({ repoOwnerKind: 'user', repoOwnerId: 'u1' }),
    )
    expect(result.permission).toBe('admin')
  })

  it('does not give a user admin over someone else’s personal repo', () => {
    const result = resolvePermission(
      inputs({ repoOwnerKind: 'user', repoOwnerId: 'u2' }),
    )
    expect(result.permission).toBe('none')
  })

  it('gives org owners admin over org repos', () => {
    expect(resolvePermission(inputs({ orgRole: 'owner' })).permission).toBe('admin')
  })

  it('does not let a read-only team demote an org owner', () => {
    // The ordering bug this guards against: resolving to the first matching
    // grant would return 'read' here instead of 'admin'.
    const result = resolvePermission(inputs({ orgRole: 'owner', teams: ['read'] }))
    expect(result.permission).toBe('admin')
  })

  it('takes the strongest grant across teams and direct collaboration', () => {
    const result = resolvePermission(
      inputs({ orgRole: 'member', collaborator: 'triage', teams: ['read', 'maintain'] }),
    )
    expect(result.permission).toBe('maintain')
  })

  it('grants read on a public repo to anonymous callers', () => {
    const result = resolvePermission(
      inputs({ viewerId: null, repoVisibility: 'public' }),
    )
    expect(result.permission).toBe('read')
    expect(result.canWrite).toBe(false)
  })

  it('grants nothing on a private repo to anonymous callers', () => {
    const result = resolvePermission(inputs({ viewerId: null }))
    expect(result.permission).toBe('none')
    expect(canSee(inputs({ viewerId: null }))).toBe(false)
  })

  it('ignores collaborator and team grants when unauthenticated', () => {
    // Guards against a caller passing stale grants alongside a null viewer.
    const result = resolvePermission(
      inputs({ viewerId: null, collaborator: 'admin', teams: ['admin'] }),
    )
    expect(result.permission).toBe('none')
  })

  it('lets site admins through regardless of repo grants', () => {
    const result = resolvePermission(inputs({ isSiteAdmin: true, viewerId: 'u9' }))
    expect(result.permission).toBe('admin')
  })

  it('keeps admin but refuses writes on an archived repo', () => {
    const result = resolvePermission(
      inputs({ repoArchived: true, repoOwnerKind: 'user', repoOwnerId: 'u1' }),
    )
    expect(result.permission).toBe('admin')
    expect(result.canWrite).toBe(false)
  })

  it('treats a public archived repo as readable', () => {
    expect(canSee(inputs({ repoVisibility: 'public', repoArchived: true }))).toBe(true)
  })
})
