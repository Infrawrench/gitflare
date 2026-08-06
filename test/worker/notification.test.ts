import { beforeEach, describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import { createRepo, createUser, resetDatabase, testEnv } from './helpers'
import { generatePat } from '~/server/auth/tokens'
import { newId } from '~/server/ids'

/**
 * Notifications and activity feeds.
 *
 * Notifications are self-scoped, so the case that matters is whether one user
 * can read or mutate another's. Activity is the opposite problem: it is shared,
 * so the question is whether a private repo's activity stays out of a feed it
 * should not appear in.
 */

beforeEach(async () => {
  await resetDatabase()
})

async function tokenFor(userId: string): Promise<string> {
  const generated = await generatePat()
  await testEnv.DB.prepare(
    `INSERT INTO access_tokens (id, user_id, name, token_hash, prefix, scopes, created_at)
     VALUES (?1, ?2, 'test', ?3, ?4, '[]', ?5)`,
  )
    .bind(newId(), userId, generated.hash, generated.prefix, Date.now())
    .run()
  return generated.plaintext
}

/**
 * Note on zero values: proto3 JSON omits zero-valued scalars, so a count of 0
 * arrives as `undefined` over the wire. Generated clients materialize it back to
 * 0, so only raw-JSON assertions like these need to allow for it.
 */
async function rpc(method: string, body: unknown, token?: string): Promise<Record<string, never>> {
  const response = await SELF.fetch(
    `https://gitflare.test/api/forge.v1.NotificationService/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
  )
  return (await response.json()) as Record<string, never>
}

async function notify(userId: string, repoId: string, title: string): Promise<string> {
  const id = newId()
  await testEnv.DB.prepare(
    `INSERT INTO notifications (id, user_id, repo_id, subject_type, subject_id, subject_title, subject_ref, reason, unread, url, updated_at)
     VALUES (?1, ?2, ?3, 'issue', ?4, ?5, '1', 'author', 1, '/x', ?6)`,
  )
    .bind(id, userId, repoId, id, title, Date.now())
    .run()
  return id
}

async function addActivity(
  actorId: string,
  repoId: string,
  action: string,
  isPublic: boolean,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO activity (id, actor_id, repo_id, action, summary, url, is_public, created_at)
     VALUES (?1, ?2, ?3, ?4, ?4, '/x', ?5, ?6)`,
  )
    .bind(newId(), actorId, repoId, action, isPublic ? 1 : 0, Date.now())
    .run()
}

describe('notifications', () => {
  it('returns only the caller’s own notifications', async () => {
    const mine = await createUser('astrid')
    const theirs = await createUser('sam')
    const repo = await createRepo(mine, 'api', { visibility: 'public' })
    await notify(mine, repo, 'For me')
    await notify(theirs, repo, 'For them')

    const body = await rpc('ListNotifications', {}, await tokenFor(mine))
    const titles = (body.notifications as unknown as { subjectTitle: string }[]).map(
      (n) => n.subjectTitle,
    )
    expect(titles).toEqual(['For me'])
    expect(body.unreadCount).toBe(1)
  })

  it('refuses an anonymous caller', async () => {
    const body = await rpc('ListNotifications', {})
    expect(body.code).toBe('unauthenticated')
  })

  it('cannot mark someone else’s notification read', async () => {
    // The id is guessable in principle; scoping the UPDATE by user_id is the
    // only thing stopping a cross-inbox write.
    const mine = await createUser('astrid')
    const theirs = await createUser('sam')
    const repo = await createRepo(mine, 'api', { visibility: 'public' })
    const foreign = await notify(theirs, repo, 'Not yours')

    await rpc('MarkNotifications', { ids: [foreign] }, await tokenFor(mine))

    const row = await testEnv.DB.prepare(`SELECT unread FROM notifications WHERE id = ?1`)
      .bind(foreign)
      .first<{ unread: number }>()
    expect(row?.unread).toBe(1)
  })

  it('marks everything read and reports the new count', async () => {
    const user = await createUser('astrid')
    const repo = await createRepo(user, 'api', { visibility: 'public' })
    await notify(user, repo, 'One')
    await notify(user, repo, 'Two')

    const token = await tokenFor(user)
    const body = await rpc('MarkNotifications', { all: true }, token)
    expect(body.unreadCount ?? 0).toBe(0)

    const after = await rpc('ListNotifications', { unreadOnly: true }, token)
    expect(after.notifications ?? []).toHaveLength(0)
  })

  it('counts unread regardless of the filter in use', async () => {
    // The badge is a property of the user, not of the current view.
    const user = await createUser('astrid')
    const repo = await createRepo(user, 'api', { visibility: 'public' })
    await notify(user, repo, 'One')
    await notify(user, repo, 'Two')

    const body = await rpc('ListNotifications', { unreadOnly: false }, await tokenFor(user))
    expect(body.unreadCount).toBe(2)
  })
})

describe('activity', () => {
  it('shows public activity to anonymous callers', async () => {
    const user = await createUser('astrid')
    const repo = await createRepo(user, 'api', { visibility: 'public' })
    await addActivity(user, repo, 'push', true)

    const body = await rpc('ListActivity', {})
    expect(body.entries ?? []).toHaveLength(1)
  })

  it('hides private activity from anonymous callers', async () => {
    const user = await createUser('astrid')
    const repo = await createRepo(user, 'secret', { visibility: 'private' })
    await addActivity(user, repo, 'push', false)

    const body = await rpc('ListActivity', {})
    expect(body.entries ?? []).toHaveLength(0)
  })

  it('shows a repo owner their own private activity', async () => {
    const user = await createUser('astrid')
    const repo = await createRepo(user, 'secret', { visibility: 'private' })
    await addActivity(user, repo, 'push', false)

    const body = await rpc(
      'ListActivity',
      { repoFullName: 'astrid/secret' },
      await tokenFor(user),
    )
    expect(body.entries ?? []).toHaveLength(1)
  })

  it('hides another user’s private activity', async () => {
    const owner = await createUser('astrid')
    const outsider = await createUser('mallory')
    const repo = await createRepo(owner, 'secret', { visibility: 'private' })
    await addActivity(owner, repo, 'push', false)

    const body = await rpc(
      'ListActivity',
      { repoFullName: 'astrid/secret' },
      await tokenFor(outsider),
    )
    expect(body.entries ?? []).toHaveLength(0)
  })

  it('filters a feed to one repo', async () => {
    const user = await createUser('astrid')
    const a = await createRepo(user, 'alpha', { visibility: 'public' })
    const b = await createRepo(user, 'beta', { visibility: 'public' })
    await addActivity(user, a, 'push', true)
    await addActivity(user, b, 'fork', true)

    const body = await rpc('ListActivity', { repoFullName: 'astrid/alpha' })
    const actions = (body.entries as unknown as { action: string }[]).map((e) => e.action)
    expect(actions).toEqual(['push'])
  })
})
