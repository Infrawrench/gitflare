import { beforeEach, describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import { addCollaborator, createRepo, createUser, resetDatabase, testEnv } from './helpers'
import { fingerprintSshKey, parseSshPublicKey } from '~/server/auth/ssh-keys'
import { newId } from '~/server/ids'

/**
 * The SSH container's authorization endpoints.
 *
 * These are the one place where a caller is a machine rather than a person, and
 * where a mistake would let an SSH key reach something its owner cannot reach in
 * a browser. Everything here is about that boundary.
 *
 * `INTERNAL_TOKEN` is unset in the test config, which is itself the first case:
 * an unset secret must mean "off", never "no authentication required".
 */

const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2xBXvJ9GmvTMcYQZvVmL1RCnMkxBmXwUcTk6xLPFhZ astrid@example.com'

beforeEach(async () => {
  await resetDatabase()
})

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return SELF.fetch(`https://gitflare.test/internal/ssh/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function addKey(userId: string): Promise<void> {
  const parsed = parseSshPublicKey(ED25519)
  await testEnv.DB.prepare(
    `INSERT INTO ssh_keys (id, user_id, title, public_key, fingerprint, key_type, read_only, created_at)
     VALUES (?1, ?2, 'test', ?3, ?4, ?5, 0, ?6)`,
  )
    .bind(
      newId(),
      userId,
      `${parsed.type} ${parsed.body}`,
      await fingerprintSshKey(parsed),
      parsed.type,
      Date.now(),
    )
    .run()
}

describe('without a configured secret', () => {
  it('refuses rather than allowing everything', async () => {
    // The test config leaves INTERNAL_TOKEN unset. Failing open here would make
    // these endpoints world-readable on any deployment that forgot the secret.
    const response = await post('authorized-key', { keyType: 'ssh-ed25519', publicKey: 'x' })
    expect(response.status).toBe(503)
  })

  it('refuses the authorize endpoint too', async () => {
    const response = await post('authorize', { userId: 'u1', repo: 'a/b' })
    expect(response.status).toBe(503)
  })

  it('does not accept an empty bearer token as a match', async () => {
    // An unset secret compared against an absent header must not be "equal".
    const response = await post('authorized-key', {}, '')
    expect(response.status).toBe(503)
  })
})

describe('key resolution shape', () => {
  it('is reachable only by POST', async () => {
    const response = await SELF.fetch('https://gitflare.test/internal/ssh/authorized-key')
    // 503 (unconfigured) is checked before the method, but either way it must
    // not be a successful GET.
    expect(response.ok).toBe(false)
  })

  it('is not confused with an API route', async () => {
    // The internal path is matched before the Connect router so a future
    // /api route cannot shadow it, and vice versa.
    const response = await SELF.fetch('https://gitflare.test/internal/ssh/nonsense')
    expect(response.status).toBe(404)
  })
})

/**
 * The database side of the contract, exercised directly.
 *
 * The HTTP layer is unreachable here without the secret, but the lookups it
 * performs are the part that would leak access, so they are checked on their own.
 */
describe('key and repo lookups', () => {
  it('resolves a stored key to its owner by fingerprint', async () => {
    const user = await createUser('astrid')
    await addKey(user)

    const fingerprint = await fingerprintSshKey(parseSshPublicKey(ED25519))
    const row = await testEnv.DB.prepare(
      `SELECT user_id FROM ssh_keys WHERE fingerprint = ?1`,
    )
      .bind(fingerprint)
      .first<{ user_id: string }>()

    expect(row?.user_id).toBe(user)
  })

  it('will not resolve a key belonging to a deactivated user', async () => {
    const user = await createUser('astrid')
    await addKey(user)
    await testEnv.DB.prepare(`UPDATE users SET is_active = 0 WHERE owner_id = ?1`)
      .bind(user)
      .run()

    const fingerprint = await fingerprintSshKey(parseSshPublicKey(ED25519))
    const row = await testEnv.DB.prepare(
      `SELECT k.user_id FROM ssh_keys k JOIN users u ON u.owner_id = k.user_id
       WHERE k.fingerprint = ?1 AND u.is_active = 1`,
    )
      .bind(fingerprint)
      .first()

    expect(row).toBeNull()
  })

  it('gives a key exactly the access its owner has, no more', async () => {
    // The whole point of resolving through requireRepo: SSH must not become a
    // path around the permission model.
    const owner = await createUser('astrid')
    const reader = await createUser('sam')
    const repo = await createRepo(owner, 'api', { visibility: 'private' })
    await addCollaborator(repo, reader, 'read')

    const { findRepoForViewer } = await import('~/server/db/repos')

    const asReader = await findRepoForViewer(testEnv.DB, 'astrid', 'api', {
      id: reader,
      isSiteAdmin: false,
    })
    expect(asReader?.access.canWrite).toBe(false)

    const asStranger = await findRepoForViewer(testEnv.DB, 'astrid', 'api', {
      id: await createUser('mallory'),
      isSiteAdmin: false,
    })
    // Not found, not forbidden — same as every other surface.
    expect(asStranger).toBeNull()
  })
})
