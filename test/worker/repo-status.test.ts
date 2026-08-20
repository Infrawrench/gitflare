import { beforeEach, describe, expect, it } from 'vitest'
import { findRepoForViewer } from '~/server/db/repos'
import type { Env } from '~/server/env'
import { reconcileRepoStatus } from '~/server/repo-status'
import { createRepo, createUser, resetDatabase, testEnv } from './helpers'

/**
 * Settling a pending import or fork.
 *
 * `ImportRepo` returns while the clone is still running, and Artifacts never
 * calls back, so this read-time reconciliation is the only thing that ever
 * writes 'ready'. Without it an imported repo is refused by every git route
 * forever, which is exactly the bug these cover.
 */
beforeEach(async () => {
  await resetDatabase()
})

/** Stands in for the Artifacts binding: `get` is all `tryGetRepo` calls. */
function envWith(get: (name: string) => unknown): Env {
  return {
    ...testEnv,
    ARTIFACTS: { get: async (name: string) => get(name) },
  } as unknown as Env
}

async function pendingRepo(status: string) {
  const owner = await createUser('astrid')
  const id = await createRepo(owner, 'gitflare', { visibility: 'public' })
  await testEnv.DB.prepare(`UPDATE repos SET status = ?2 WHERE id = ?1`).bind(id, status).run()

  const found = await findRepoForViewer(testEnv.DB, 'astrid', 'gitflare', {
    id: owner,
    isSiteAdmin: false,
  })
  return found!.repo
}

async function statusOf(id: string): Promise<string> {
  const row = await testEnv.DB.prepare(`SELECT status FROM repos WHERE id = ?1`)
    .bind(id)
    .first<{ status: string }>()
  return row!.status
}

describe('reconcileRepoStatus', () => {
  it('promotes an import whose objects have landed', async () => {
    const repo = await pendingRepo('importing')

    const settled = await reconcileRepoStatus(envWith(() => ({ name: repo.artifacts_name })), repo)

    expect(settled.status).toBe('ready')
    // Persisted, not just returned — the next request must not have to ask again.
    expect(await statusOf(repo.id)).toBe('ready')
  })

  it('promotes a pending fork the same way', async () => {
    const repo = await pendingRepo('forking')
    const settled = await reconcileRepoStatus(envWith(() => ({ name: repo.artifacts_name })), repo)
    expect(settled.status).toBe('ready')
  })

  it('leaves a repo alone while the job is still running', async () => {
    const repo = await pendingRepo('importing')

    // Artifacts raises IMPORT_IN_PROGRESS, which `tryGetRepo` maps to null.
    // `isArtifactsError` keys off the name, so the fake has to carry it.
    const inProgress = () => {
      throw Object.assign(new Error('import in progress'), {
        name: 'ArtifactsError',
        code: 'IMPORT_IN_PROGRESS',
      })
    }
    const settled = await reconcileRepoStatus(envWith(inProgress), repo)

    expect(settled.status).toBe('importing')
    expect(await statusOf(repo.id)).toBe('importing')
  })

  it('does not touch Artifacts for a repo that is already ready', async () => {
    const repo = await pendingRepo('ready')
    let asked = false
    const settled = await reconcileRepoStatus(
      envWith(() => {
        asked = true
        return {}
      }),
      repo,
    )

    expect(asked).toBe(false)
    expect(settled).toBe(repo)
  })

  it('passes the repo through untouched when the binding is absent', async () => {
    // wrangler.dev.jsonc omits the binding; a metadata read must not fail there.
    const repo = await pendingRepo('importing')
    const settled = await reconcileRepoStatus(
      { ...testEnv, ARTIFACTS: undefined } as unknown as Env,
      repo,
    )
    expect(settled.status).toBe('importing')
  })
})
