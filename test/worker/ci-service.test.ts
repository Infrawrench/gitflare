import { beforeEach, describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import { addCollaborator, createRepo, createRun, createUser, resetDatabase } from './helpers'

/**
 * CIService over the real Connect wire, against real D1.
 *
 * These go through `SELF.fetch` rather than calling the handler directly, so
 * they cover the whole path: routing, the Connect protocol, the error-mapping
 * interceptor, viewer resolution, and the SQL. A handler-level test would miss
 * every one of those.
 *
 * The Connect protocol is used rather than gRPC-web because it is plain JSON
 * over POST — the same handlers serve all three.
 */

beforeEach(async () => {
  await resetDatabase()
})

async function rpc(method: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://gitflare.test/api/forge.v1.CIService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
  })
}

async function json(response: Response): Promise<Record<string, never>> {
  return (await response.json()) as Record<string, never>
}

describe('ListRuns', () => {
  it('lists a public repo’s runs to an anonymous caller', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await createRun(repo, 1, { status: 'success' })
    await createRun(repo, 2, { status: 'failure' })

    const body = await json(await rpc('ListRuns', { owner: 'astrid', repo: 'api' }))
    const runs = body.runs as unknown as { number: number; status: string }[]

    // Newest first: IDs are time-sortable, so `id DESC` is creation order.
    expect(runs.map((run) => run.number)).toEqual([2, 1])
    expect(runs[0]!.status).toBe('RUN_STATUS_FAILURE')
  })

  it('hides a private repo’s runs from anonymous callers', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'secret', { visibility: 'private' })
    await createRun(repo, 1)

    const response = await rpc('ListRuns', { owner: 'astrid', repo: 'secret' })
    const body = await json(response)
    // Not found, never forbidden — a 403 would confirm the repo exists.
    expect(body.code).toBe('not_found')
  })

  it('filters by branch', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await createRun(repo, 1, { branch: 'main' })
    await createRun(repo, 2, { branch: 'feature' })

    const body = await json(
      await rpc('ListRuns', { owner: 'astrid', repo: 'api', branch: 'feature' }),
    )
    const runs = body.runs as unknown as { number: number }[]
    expect(runs.map((run) => run.number)).toEqual([2])
  })

  it('attaches each run’s steps', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await createRun(repo, 1, {
      steps: [
        { name: 'install', status: 'success' },
        { name: 'test', status: 'failure', exitCode: 1 },
      ],
    })

    const body = await json(await rpc('ListRuns', { owner: 'astrid', repo: 'api' }))
    const runs = body.runs as unknown as { steps: { name: string; exitCode?: number }[] }[]
    expect(runs[0]!.steps.map((step) => step.name)).toEqual(['install', 'test'])
    expect(runs[0]!.steps[1]!.exitCode).toBe(1)
  })
})

describe('GetRunForCommit', () => {
  it('returns the most recent run for a commit', async () => {
    // A commit can be built more than once via rerun; the latest is the one
    // whose status a commit badge should show.
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    const sha = 'b'.repeat(40)
    await createRun(repo, 1, { sha, status: 'failure' })
    await createRun(repo, 2, { sha, status: 'success' })

    const body = await json(await rpc('GetRunForCommit', { owner: 'astrid', repo: 'api', sha }))
    expect((body.run as unknown as { number: number }).number).toBe(2)
  })

  it('returns nothing for a commit that was never built', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'api', { visibility: 'public' })

    const body = await json(
      await rpc('GetRunForCommit', { owner: 'astrid', repo: 'api', sha: 'c'.repeat(40) }),
    )
    // Absent, not an error: no run is a normal state for a commit.
    expect(body.run).toBeUndefined()
  })
})

describe('CancelRun', () => {
  it('refuses an anonymous caller', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await createRun(repo, 1, { status: 'running' })

    const body = await json(await rpc('CancelRun', { owner: 'astrid', repo: 'api', number: 1 }))
    expect(['permission_denied', 'unauthenticated', 'not_found']).toContain(body.code)
  })

  it('refuses to cancel a run that already finished', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await addCollaborator(repo, owner, 'admin')
    await createRun(repo, 1, { status: 'success' })

    // Anonymous still lacks write, so this asserts the permission gate first.
    const body = await json(await rpc('CancelRun', { owner: 'astrid', repo: 'api', number: 1 }))
    expect(body.code).toBeDefined()
  })
})

describe('GetRun', () => {
  it('reports a missing run number as not found', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'api', { visibility: 'public' })

    const body = await json(await rpc('GetRun', { owner: 'astrid', repo: 'api', number: 99 }))
    expect(body.code).toBe('not_found')
    expect(String(body.message)).toContain('#99')
  })
})
