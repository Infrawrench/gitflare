import { beforeEach, describe, expect, it } from 'vitest'
import { notifyThread, recordActivity, threadParticipants } from '~/server/events/notify'
import { createRepo, createUser, resetDatabase, testEnv } from './helpers'
import { newId } from '~/server/ids'

/**
 * Writing notifications and activity.
 *
 * The read side is covered in notification.test.ts. What matters here is who
 * gets written to: notifying the actor about their own action is the single
 * most common complaint about systems like this, and a busy thread that stacks
 * one row per comment makes an inbox useless.
 */

beforeEach(async () => {
  await resetDatabase()
})

function subject(repoId: string, id = 'issue-1') {
  return {
    repoId,
    type: 'issue' as const,
    id,
    title: 'A bug',
    ref: '1',
    url: '/astrid/api/issues/1',
  }
}

async function unreadFor(userId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT count(*) AS count FROM notifications WHERE user_id = ?1 AND unread = 1`,
  )
    .bind(userId)
    .first<{ count: number }>()
  return row?.count ?? 0
}

describe('notifyThread', () => {
  it('never notifies the actor about their own action', async () => {
    const actor = await createUser('astrid')
    const other = await createUser('sam')
    const repo = await createRepo(actor, 'api')

    await notifyThread(testEnv, {
      subject: subject(repo),
      actorId: actor,
      reason: 'comment',
      userIds: [actor, other],
    })

    expect(await unreadFor(actor)).toBe(0)
    expect(await unreadFor(other)).toBe(1)
  })

  it('collapses repeat events onto one row per thread', async () => {
    // Ten comments should leave one entry, not ten.
    const actor = await createUser('astrid')
    const watcher = await createUser('sam')
    const repo = await createRepo(actor, 'api')

    for (let i = 0; i < 5; i++) {
      await notifyThread(testEnv, {
        subject: subject(repo),
        actorId: actor,
        reason: 'comment',
        userIds: [watcher],
      })
    }

    const rows = await testEnv.DB.prepare(
      `SELECT count(*) AS count FROM notifications WHERE user_id = ?1`,
    )
      .bind(watcher)
      .first<{ count: number }>()
    expect(rows?.count).toBe(1)
  })

  it('marks a thread unread again when something new happens', async () => {
    const actor = await createUser('astrid')
    const watcher = await createUser('sam')
    const repo = await createRepo(actor, 'api')

    await notifyThread(testEnv, {
      subject: subject(repo),
      actorId: actor,
      reason: 'comment',
      userIds: [watcher],
    })
    await testEnv.DB.prepare(`UPDATE notifications SET unread = 0 WHERE user_id = ?1`)
      .bind(watcher)
      .run()

    await notifyThread(testEnv, {
      subject: subject(repo),
      actorId: actor,
      reason: 'comment',
      userIds: [watcher],
    })
    expect(await unreadFor(watcher)).toBe(1)
  })

  it('includes watchers when asked, and only then', async () => {
    const actor = await createUser('astrid')
    const watcher = await createUser('sam')
    const repo = await createRepo(actor, 'api')
    await testEnv.DB.prepare(
      `INSERT INTO watches (repo_id, user_id, created_at) VALUES (?1, ?2, ?3)`,
    )
      .bind(repo, watcher, Date.now())
      .run()

    await notifyThread(testEnv, {
      subject: subject(repo, 'no-watchers'),
      actorId: actor,
      reason: 'comment',
      userIds: [],
    })
    expect(await unreadFor(watcher)).toBe(0)

    await notifyThread(testEnv, {
      subject: subject(repo, 'with-watchers'),
      actorId: actor,
      reason: 'watching',
      userIds: [],
      includeWatchers: true,
    })
    expect(await unreadFor(watcher)).toBe(1)
  })

  it('writes nothing when every recipient is the actor', async () => {
    const actor = await createUser('astrid')
    const repo = await createRepo(actor, 'api')

    await notifyThread(testEnv, {
      subject: subject(repo),
      actorId: actor,
      reason: 'author',
      userIds: [actor],
    })
    expect(await unreadFor(actor)).toBe(0)
  })
})

describe('threadParticipants', () => {
  it('collects the author, assignees, and commenters without duplicates', async () => {
    const author = await createUser('astrid')
    const assignee = await createUser('sam')
    const commenter = await createUser('kit')
    const repo = await createRepo(author, 'api')
    const issueId = newId()

    await testEnv.DB.prepare(
      `INSERT INTO issues (id, repo_id, number, title, body, state, author_id, created_at, updated_at)
       VALUES (?1, ?2, 1, 'A bug', '', 'open', ?3, ?4, ?4)`,
    )
      .bind(issueId, repo, author, Date.now())
      .run()
    await testEnv.DB.prepare(
      `INSERT INTO issue_assignees (issue_id, user_id) VALUES (?1, ?2)`,
    )
      .bind(issueId, assignee)
      .run()
    // The author comments too — they must not appear twice.
    for (const userId of [commenter, author]) {
      await testEnv.DB.prepare(
        `INSERT INTO comments (id, issue_id, author_id, body, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'hi', ?4, ?4)`,
      )
        .bind(newId(), issueId, userId, Date.now())
        .run()
    }

    const participants = await threadParticipants(testEnv, issueId)
    expect(participants.sort()).toEqual([author, assignee, commenter].sort())
  })
})

describe('recordActivity', () => {
  it('stores the repo’s visibility on the row', async () => {
    // Copied at write time so a repo going private stops appearing in public
    // feeds without a backfill.
    const actor = await createUser('astrid')
    const repo = await createRepo(actor, 'api', { visibility: 'private' })

    await recordActivity(testEnv, {
      actorId: actor,
      repoId: repo,
      ownerId: actor,
      action: 'open_issue',
      summary: 'A bug',
      url: '/x',
      isPublic: false,
    })

    const row = await testEnv.DB.prepare(`SELECT is_public FROM activity WHERE repo_id = ?1`)
      .bind(repo)
      .first<{ is_public: number }>()
    expect(row?.is_public).toBe(0)
  })
})
