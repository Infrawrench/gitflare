import {
  CIWorkflow,
  cloudflareArtifacts,
  isCiRunnerFailure,
  type CiContext,
  type CiParams,
  type CiRunnerResult,
  type CloudflareArtifacts,
} from '@cloudflare/ci'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import type { BuildContext, PlanStep } from '../packages/ci-config/src/index'
import { planWaves } from '../packages/ci-config/src/index'
import { buildEmitCommand, parseEmittedPlan, readLog } from './plan-emitter'
import type { CiEnv } from './env'
import { runPipeline, type StartRunInput } from './pipeline'
import { finishRun, recordStep, startRun } from './record'

// The Sandbox durable object @cloudflare/ci runs commands in. Re-exported
// because wrangler.ci.jsonc binds SANDBOX to this class name.
export { CiSandbox } from '@cloudflare/ci/worker'

/**
 * The CI pipeline for every repo in the namespace.
 *
 * Cloudflare Workflows invokes this on each `cf.artifacts.repo.pushed` event
 * (see the `triggers.events` block in wrangler.ci.jsonc). `@cloudflare/ci` turns
 * every `ci.runner()` call into a durable, retried Workflow step backed by a
 * Sandbox container, and chains each runner's workspace snapshot to the next.
 *
 * The pipeline's *shape* comes from the repo's own `.gitflare/ci.ts`, evaluated
 * in a sandbox rather than in this isolate. See plan-emitter.ts for why.
 */
export class GitflareCI extends CIWorkflow<CloudflareArtifacts, CiEnv> {
  /**
   * Scopes this Workflow to our namespace. Without the filter, a push to any
   * Artifacts repo on the account would start a Gitflare pipeline.
   */
  static override getProvider() {
    return cloudflareArtifacts({ owner: 'gitflare' })
  }

  protected async pipeline(
    event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const params = event.payload
    const context = toBuildContext(params)

    const run = await step.do('record-run', () =>
      startRun(this.env, params, event.instanceId),
    )
    // A repo can exist in Artifacts without a Gitflare row (created out of band).
    // Nothing to report against, so there is nothing useful to run.
    if (!run) return

    let plan
    try {
      plan = await this.emitPlan(ci, context)
    } catch (error) {
      await step.do('record-plan-failure', () =>
        finishRun(this.env, run.runId, 'failure', describe(error)),
      )
      throw error
    }

    if (!plan || plan.steps.length === 0) {
      // No .gitflare/ci.ts, or one that declared nothing. Not a failure.
      await step.do('record-no-pipeline', () => finishRun(this.env, run.runId, 'success'))
      return
    }

    await step.do('record-steps', () => recordStep.declare(this.env, run.runId, plan.steps))

    try {
      await this.execute(ci, step, run.runId, plan.steps)
    } catch (error) {
      await step.do('record-failure', () =>
        finishRun(this.env, run.runId, 'failure', isCiRunnerFailure(error) ? undefined : describe(error)),
      )
      throw error
    }

    await step.do('record-success', () => finishRun(this.env, run.runId, 'success'))
  }

  /**
   * Runs the repo's config in a sandbox and parses the plan it prints.
   *
   * This is itself a `ci.runner()` call, so it gets the source checkout, the
   * retry policy, and the isolation of any other step for free.
   */
  private async emitPlan(ci: CiContext, context: BuildContext) {
    const result = await ci.runner({
      name: 'gitflare:plan',
      command: buildEmitCommand(context),
      // The plan depends only on the config file, so a push that leaves it
      // untouched reuses the previous evaluation.
      cache: { inputs: ['.gitflare/ci.ts'] },
      config: { retries: { limit: 1, delay: 5_000 }, timeout: 120_000 },
    })
    return parseEmittedPlan(await readLog(result.logs.stdout))
  }

  /**
   * Replays the plan through real runners, one wave at a time.
   *
   * Steps within a wave have no dependency on each other and are started
   * together; the wave boundary is where `Promise.all` waits. Chaining a runner
   * off its dependency's result is what makes the dependent step restore the
   * workspace snapshot the first one produced.
   */
  private async execute(
    ci: CiContext,
    step: WorkflowStep,
    runId: string,
    steps: PlanStep[],
  ): Promise<void> {
    const waves = planWaves({ version: 1, steps })
    const results = new Map<string, CiRunnerResult>()

    for (const wave of waves) {
      const settled = await Promise.all(
        wave.map(async (planStep) => {
          const result = await this.runStep(ci, planStep, results)
          await step.do(`record:${planStep.name}`, () =>
            recordStep.finish(this.env, runId, planStep.name, result),
          )
          return [planStep.name, result] as const
        }),
      )
      for (const [name, result] of settled) results.set(name, result)
    }
  }

  private runStep(
    ci: CiContext,
    planStep: PlanStep,
    results: Map<string, CiRunnerResult>,
  ): Promise<CiRunnerResult> {
    const options = {
      name: planStep.name,
      command: planStep.command,
      ...(planStep.cwd === undefined ? {} : { cwd: planStep.cwd }),
      ...(planStep.env === undefined ? {} : { env: planStep.env }),
      ...(planStep.secrets === undefined ? {} : { secrets: planStep.secrets }),
      ...(planStep.cache === undefined ? {} : { cache: { inputs: planStep.cache } }),
      ...(planStep.cloudflareCredentials === undefined
        ? {}
        : { cloudflareCredentials: planStep.cloudflareCredentials }),
      ...(planStep.sourceControlCredentials === undefined
        ? {}
        : { sourceControlCredentials: planStep.sourceControlCredentials }),
      config: {
        ...(planStep.timeoutMs === undefined ? {} : { timeout: planStep.timeoutMs }),
        ...(planStep.retries === undefined
          ? {}
          : { retries: { limit: planStep.retries, delay: 15_000, backoff: 'linear' as const } }),
      },
    }

    // Chaining off the first dependency inherits its workspace snapshot. A step
    // with several dependencies still only restores one workspace — the others
    // are ordering constraints, which is why a fan-in step should re-derive
    // anything it needs rather than assume every input is present.
    const parent = planStep.needs[0]
    const chained = parent ? results.get(parent) : undefined
    return chained ? chained.runner(options) : ci.runner(options)
}
}

function toBuildContext(params: CiParams<CloudflareArtifacts>): BuildContext {
  return {
    owner: params.owner,
    repo: params.repo,
    sha: params.sha,
    ref: params.ref,
    ...(params.branch === undefined ? {} : { branch: params.branch }),
    ...(params.tag === undefined ? {} : { tag: params.tag }),
    trigger: params.trigger === 'tag' ? 'tag' : 'push',
    // Resolved against the recorded default branch when the run is created;
    // the event itself does not carry it.
    isDefaultBranch: false,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default {
  /**
   * Entrypoint for the sandbox path.
   *
   * The Workflow path is driven by the `cf.artifacts.repo.pushed` trigger and
   * needs no HTTP. This handler exists for the direct path, which the main
   * Worker starts over its service binding — for a rerun, or for any repo whose
   * source is not Artifacts.
   *
   * The run is started with `waitUntil` rather than awaited: a pipeline takes
   * minutes and the caller only needs to know it was accepted.
   */
  async fetch(request: Request, env: CiEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/run') {
      return new Response('gitflare-ci: POST /run to start a pipeline\n', {
        status: url.pathname === '/run' ? 405 : 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    let input: StartRunInput
    try {
      input = (await request.json()) as StartRunInput
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 })
    }
    if (!input.runId || !input.repoUrl || !input.context) {
      return Response.json({ error: 'runId, repoUrl, and context are required' }, { status: 400 })
    }

    ctx.waitUntil(
      runPipeline(env, input).catch(async (error: unknown) => {
        // A crash before the pipeline records its own outcome would leave the
        // run stuck on "running" forever.
        await env.DB.prepare(
          `UPDATE ci_runs SET status = 'failure', finished_at = ?2, error = ?3
           WHERE id = ?1 AND status NOT IN ('success', 'failure', 'cancelled')`,
        )
          .bind(input.runId, Date.now(), error instanceof Error ? error.message : String(error))
          .run()
      }),
    )

    return Response.json({ accepted: true, runId: input.runId }, { status: 202 })
  },
}
