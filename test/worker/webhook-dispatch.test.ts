import { beforeEach, describe, expect, it } from 'vitest'
import { dispatchEvent } from '~/server/events/webhooks'
import { createOrg, createRepo, createUser, resetDatabase, testEnv } from './helpers'
import { newId } from '~/server/ids'

/**
 * Event fan-out.
 *
 * The delivery itself is covered by the signature tests; what matters here is
 * which hooks get selected. Getting this wrong is quiet in both directions — a
 * missed hook looks like a flaky integration, and an over-matched one leaks
 * repository activity to a subscriber who never asked for it.
 *
 * Queue sends are captured rather than really enqueued, so the assertions are
 * about the selection, not the transport.
 */

interface Sent {
  body: { webhookId: string; event: string }
}

let sent: Sent[] = []

/** Env with the queue binding replaced by a recorder. */
function envWithCapture() {
  return {
    ...testEnv,
    WEBHOOKS: {
      send: (body: Sent['body']) => {
        sent.push({ body })
        return Promise.resolve()
      },
      sendBatch: (messages: Sent[]) => {
        sent.push(...messages)
        return Promise.resolve()
      },
    },
  } as unknown as typeof testEnv
}

async function addHook(
  scope: { repoId?: string; ownerId?: string },
  events: string[],
  options: { active?: boolean } = {},
): Promise<string> {
  const id = newId()
  await testEnv.DB.prepare(
    `INSERT INTO webhooks (id, repo_id, owner_id, url, content_type, secret, events, active, created_at)
     VALUES (?1, ?2, ?3, 'https://example.test/hook', 'application/json', '', ?4, ?5, ?6)`,
  )
    .bind(
      id,
      scope.repoId ?? null,
      scope.ownerId ?? null,
      JSON.stringify(events),
      options.active === false ? 0 : 1,
      Date.now(),
    )
    .run()
  return id
}

beforeEach(async () => {
  await resetDatabase()
  sent = []
})

describe('dispatchEvent', () => {
  it('sends to a repo hook that subscribes to the event', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api')
    const hook = await addHook({ repoId: repo }, ['issues'])

    await dispatchEvent(envWithCapture(), {
      repoId: repo,
      ownerId: owner,
      event: 'issues',
      payload: {},
    })

    expect(sent.map((message) => message.body.webhookId)).toEqual([hook])
  })

  it('does not send to a hook subscribed to other events', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api')
    await addHook({ repoId: repo }, ['push', 'release'])

    await dispatchEvent(envWithCapture(), {
      repoId: repo,
      ownerId: owner,
      event: 'issues',
      payload: {},
    })

    expect(sent).toHaveLength(0)
  })

  it('includes owner-level hooks, which fire for every repo', async () => {
    const org = await createOrg('acme')
    const repo = await createRepo(org, 'service')
    const repoHook = await addHook({ repoId: repo }, ['issues'])
    const orgHook = await addHook({ ownerId: org }, ['issues'])

    await dispatchEvent(envWithCapture(), {
      repoId: repo,
      ownerId: org,
      event: 'issues',
      payload: {},
    })

    expect(sent.map((message) => message.body.webhookId).sort()).toEqual([repoHook, orgHook].sort())
  })

  it('skips inactive hooks', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api')
    await addHook({ repoId: repo }, ['issues'], { active: false })

    await dispatchEvent(envWithCapture(), {
      repoId: repo,
      ownerId: owner,
      event: 'issues',
      payload: {},
    })

    expect(sent).toHaveLength(0)
  })

  it('does not send another repo’s hooks', async () => {
    const owner = await createUser('astrid')
    const mine = await createRepo(owner, 'mine')
    const other = await createRepo(owner, 'other')
    await addHook({ repoId: other }, ['issues'])

    await dispatchEvent(envWithCapture(), {
      repoId: mine,
      ownerId: owner,
      event: 'issues',
      payload: {},
    })

    expect(sent).toHaveLength(0)
  })

  it('treats a malformed subscription list as no subscription', async () => {
    // Failing closed: a corrupt row must not turn into "fires for everything".
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api')
    const id = newId()
    await testEnv.DB.prepare(
      `INSERT INTO webhooks (id, repo_id, url, content_type, secret, events, active, created_at)
       VALUES (?1, ?2, 'https://example.test/hook', 'application/json', '', 'not json', 1, ?3)`,
    )
      .bind(id, repo, Date.now())
      .run()

    await dispatchEvent(envWithCapture(), {
      repoId: repo,
      ownerId: owner,
      event: 'issues',
      payload: {},
    })

    expect(sent).toHaveLength(0)
  })

  it('sends nothing, and touches no queue, when there are no hooks', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api')

    await dispatchEvent(envWithCapture(), {
      repoId: repo,
      ownerId: owner,
      event: 'issues',
      payload: {},
    })

    expect(sent).toHaveLength(0)
  })
})
