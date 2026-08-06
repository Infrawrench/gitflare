import type { BuildContext } from '../packages/ci-config/src/index'
import type { CiEnv } from './env'
import { DurableObjectLogSink } from './log-sink'
import { runPlanInSandbox } from './sandbox-runner'
import { notifyThread } from '../src/server/events/notify'

/**
 * Runs a repo's pipeline for one commit, start to finish.
 *
 * This is the sandbox path wired up: clone, evaluate the repo's own
 * `.gitflare/ci.ts` inside the container, run the resulting plan, stream output
 * into the log Durable Object, and record progress in D1.
 *
 * The Workflow path in `index.ts` does the same job with durable retries and
 * snapshot caching, but only against Artifacts. This one works with any git URL,
 * which is what makes it runnable today — see the comparison table in the README.
 */

export interface StartRunInput {
  runId: string
  repoId: string
  /** Git URL the container will clone. Gitflare's own HTTPS proxy works here. */
  repoUrl: string
  /** Short-lived read token for the clone, if the repo is not public. */
  token?: string
  context: BuildContext
}

export async function runPipeline(env: CiEnv, input: StartRunInput): Promise<void> {
  const logs = env.CI_LOGS.get(env.CI_LOGS.idFromName(input.runId))
  const sink = new DurableObjectLogSink(logs as never)

  await markRunning(env, input.runId)

  const result = await runPlanInSandbox({
    sandboxBinding: env.SANDBOX as never,
    runId: input.runId,
    checkout: {
      repoUrl: input.repoUrl,
      ...(input.context.branch ? { branch: input.context.branch } : {}),
      sha: input.context.sha,
      ...(input.token ? { token: input.token } : {}),
    },
    // Evaluated in the container after checkout, never imported here.
    plan: { fromRepo: input.context },
    sink,
    env: {
      CI: 'true',
      GITFLARE_CI: 'true',
      GITFLARE_REPO: `${input.context.owner}/${input.context.repo}`,
      GITFLARE_SHA: input.context.sha,
      GITFLARE_REF: input.context.ref,
    },
  })

  // Steps are recorded after the fact rather than as they finish: the runner
  // returns the full set, and one batch is cheaper than a write per step. Live
  // progress is what the log stream is for.
  await recordSteps(env, input.runId, result.steps)
  await finishRun(env, input.runId, result.ok ? 'success' : 'failure', result.error)

  // Flushes anything buffered and tells streaming clients the run is over.
  await sink.finish(result.ok ? 'success' : 'failure')

  // Only failures notify. A green build is the expected outcome, and telling
  // someone about every one trains them to ignore the channel entirely.
  if (!result.ok) await notifyRunFailure(env, input)
}

async function markRunning(env: CiEnv, runId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ci_runs SET status = 'running', started_at = COALESCE(started_at, ?2) WHERE id = ?1`,
  )
    .bind(runId, Date.now())
    .run()
}

async function recordSteps(
  env: CiEnv,
  runId: string,
  steps: { name: string; exitCode: number; skipped: boolean; startedAt: number; finishedAt: number }[],
): Promise<void> {
  if (steps.length === 0) return

  await env.DB.batch(
    steps.map((step, index) =>
      env.DB.prepare(
        `INSERT INTO ci_steps (id, run_id, name, command, status, exit_code, needs, ordinal, started_at, finished_at)
         VALUES (?1, ?2, ?3, '', ?4, ?5, '[]', ?6, ?7, ?8)
         ON CONFLICT (run_id, name) DO UPDATE SET
           status = excluded.status,
           exit_code = excluded.exit_code,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at`,
      ).bind(
        crypto.randomUUID(),
        runId,
        step.name,
        step.skipped ? 'cancelled' : step.exitCode === 0 ? 'success' : 'failure',
        step.exitCode,
        index,
        step.startedAt,
        step.finishedAt,
      ),
    ),
  )
}

async function finishRun(
  env: CiEnv,
  runId: string,
  status: 'success' | 'failure',
  error?: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ci_runs SET status = ?2, finished_at = ?3, error = ?4 WHERE id = ?1`,
  )
    .bind(runId, status, Date.now(), error ?? '')
    .run()
}

/**
 * Tells the person who pushed that their build broke.
 *
 * Best-effort: the run is already recorded, and failing to notify must not turn
 * a reported failure into an unreported one.
 */
async function notifyRunFailure(env: CiEnv, input: StartRunInput): Promise<void> {
  try {
    const run = await env.DB.prepare(
      `SELECT r.id, r.number, r.repo_id, r.actor_id, o.login AS owner_login, repo.name AS repo_name
       FROM ci_runs r
       JOIN repos repo ON repo.id = r.repo_id
       JOIN owners o ON o.id = repo.owner_id
       WHERE r.id = ?1`,
    )
      .bind(input.runId)
      .first<{
        id: string
        number: number
        repo_id: string
        actor_id: string | null
        owner_login: string
        repo_name: string
      }>()

    if (!run?.actor_id) return

    await notifyThread(env as never, {
      subject: {
        repoId: run.repo_id,
        type: 'ci_run',
        id: run.id,
        title: `Pipeline #${run.number} failed`,
        ref: String(run.number),
        url: `/${run.owner_login}/${run.repo_name}/ci/${run.number}`,
      },
      // The actor is normally excluded from their own notifications, but a
      // broken build is precisely the case where they are the audience — so
      // they are named as the recipient with a different actor.
      actorId: '',
      reason: 'ci_failure',
      userIds: [run.actor_id],
    })
  } catch {
    // Nothing useful to do; the failure is already recorded on the run.
  }
}
