import type { CiParams, CiRunnerResult, CloudflareArtifacts } from '@cloudflare/ci'
import type { PlanStep } from '../packages/ci-config/src/index'
import type { CiEnv } from './env'

/**
 * Mirrors Workflow progress into D1.
 *
 * The Workflow is the source of truth for execution; these rows exist so the UI
 * can list and filter runs without querying the Workflows API on every page
 * load. Every write here is called from inside a `step.do()`, so it must be
 * idempotent — Workflows can replay a step after a failure or hibernation.
 */

export interface StartedRun {
  runId: string
  repoId: string
  number: number
}

export async function startRun(
  env: CiEnv,
  params: CiParams<CloudflareArtifacts>,
  instanceId: string,
): Promise<StartedRun | null> {
  const artifactsName = `${params.owner.toLowerCase()}--${params.repo.toLowerCase()}`

  const repo = await env.DB.prepare(
    `SELECT id, ci_enabled FROM repos WHERE artifacts_name = ?1`,
  )
    .bind(artifactsName)
    .first<{ id: string; ci_enabled: number }>()

  // A repo can exist in Artifacts without a Gitflare row, or have CI turned off.
  if (!repo || repo.ci_enabled !== 1) return null

  // The Workflow instance id is derived from the source commit, so a redelivered
  // push event replays into the same row instead of creating a duplicate run.
  const existing = await env.DB.prepare(
    `SELECT id, number FROM ci_runs WHERE workflow_instance_id = ?1`,
  )
    .bind(instanceId)
    .first<{ id: string; number: number }>()

  if (existing) {
    return { runId: existing.id, repoId: repo.id, number: existing.number }
  }

  const numbered = await env.DB.prepare(
    `UPDATE repos SET next_run_number = next_run_number + 1
     WHERE id = ?1 RETURNING next_run_number - 1 AS number`,
  )
    .bind(repo.id)
    .first<{ number: number }>()

  const number = numbered?.number ?? 1
  const runId = crypto.randomUUID()
  const now = Date.now()

  await env.DB.prepare(
    `INSERT INTO ci_runs (
       id, repo_id, number, workflow_instance_id, status, trigger, ref, branch, tag,
       sha, before_sha, commit_message, created_at, started_at
     ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
     ON CONFLICT (workflow_instance_id) DO NOTHING`,
  )
    .bind(
      runId,
      repo.id,
      number,
      instanceId,
      params.trigger === 'tag' ? 'tag' : 'push',
      params.ref,
      params.branch ?? null,
      params.tag ?? null,
      params.sha,
      params.beforeSha ?? '',
      params.headCommitMessage ?? '',
      now,
    )
    .run()

  // Re-read rather than trusting the insert: a concurrent replay may have won
  // the ON CONFLICT race, in which case its id is the real one.
  const stored = await env.DB.prepare(
    `SELECT id, number FROM ci_runs WHERE workflow_instance_id = ?1`,
  )
    .bind(instanceId)
    .first<{ id: string; number: number }>()

  return stored ? { runId: stored.id, repoId: repo.id, number: stored.number } : null
}

export const recordStep = {
  /** Writes the plan's steps as queued rows so the UI can show the shape up front. */
  async declare(env: CiEnv, runId: string, steps: PlanStep[]): Promise<void> {
    if (steps.length === 0) return
    await env.DB.batch(
      steps.map((step, index) =>
        env.DB.prepare(
          `INSERT INTO ci_steps (id, run_id, name, command, status, needs, ordinal)
           VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6)
           ON CONFLICT (run_id, name) DO UPDATE SET
             command = excluded.command,
             needs = excluded.needs,
             ordinal = excluded.ordinal`,
        ).bind(
          crypto.randomUUID(),
          runId,
          step.name,
          step.command,
          JSON.stringify(step.needs),
          index,
        ),
      ),
    )
  },

  async finish(
    env: CiEnv,
    runId: string,
    name: string,
    result: CiRunnerResult,
  ): Promise<void> {
    const succeeded = result.exitCode === 0
    // A cache pointer means the snapshot was restored and the command skipped.
    const cached = succeeded && result.cachePointer !== undefined

    await env.DB.prepare(
      `UPDATE ci_steps
       SET status = ?3, exit_code = ?4, cache_hit = ?5, finished_at = ?6
       WHERE run_id = ?1 AND name = ?2`,
    )
      .bind(
        runId,
        name,
        cached ? 'cached' : succeeded ? 'success' : 'failure',
        result.exitCode,
        cached ? 1 : 0,
        Date.now(),
      )
      .run()
  },
}

export async function finishRun(
  env: CiEnv,
  runId: string,
  status: 'success' | 'failure' | 'cancelled',
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ci_runs SET status = ?2, finished_at = ?3, error = COALESCE(?4, error)
     WHERE id = ?1`,
  )
    .bind(runId, status, Date.now(), error ?? null)
    .run()

  // Any step still queued when the run ends never got to start.
  await env.DB.prepare(
    `UPDATE ci_steps SET status = 'cancelled', finished_at = ?2
     WHERE run_id = ?1 AND status IN ('queued', 'running')`,
  )
    .bind(runId, Date.now())
    .run()
}
