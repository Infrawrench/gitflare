import { getSandbox, parseSSEStream, type ExecEvent, type Sandbox } from '@cloudflare/sandbox'
import { planWaves, type BuildContext, type Plan, type PlanStep } from '../packages/ci-config/src/index'
import { buildEmitCommand, parseEmittedPlan } from './plan-emitter'

/**
 * Runs a repo's CI plan directly on a Sandbox container.
 *
 * This exists alongside the `@cloudflare/ci` Workflow, not instead of it, and
 * the split is deliberate:
 *
 *   GitflareCI (ci/index.ts)  durable — every step is a retried Workflow step
 *                             with snapshot caching between runners. Requires
 *                             Artifacts, because @cloudflare/ci's `exports` map
 *                             hides SourceControlProvider and hard-codes it.
 *
 *   this module               direct — one container, live output, no Workflow.
 *                             Requires only a git URL, so it works against any
 *                             remote and is not blocked by the Artifacts beta.
 *
 * The Sandbox SDK went GA in April 2026, so this path is actually reachable
 * today, which the Workflow path is not. It is also what makes real streaming
 * logs possible: `execStream` yields stdout and stderr as they are produced,
 * where the Workflow path only surfaces a step's output once the step finishes.
 *
 * ## Running untrusted code
 *
 * A pipeline is written by whoever can push to the repo, so every command here
 * is hostile input. The container is the security boundary: process, filesystem,
 * and network isolation, with CPU and memory bounds. Nothing from this module
 * runs in the Worker isolate, which is the part that holds D1 and the Artifacts
 * binding. The credentials handed to a step are also scoped — a checkout token
 * is read-only and expires in an hour, and deploy credentials are injected only
 * into steps that ask for them.
 */

export interface CheckoutSpec {
  /** Any git URL the container can reach, including Gitflare's own HTTPS proxy. */
  repoUrl: string
  branch?: string
  /** Commit to check out after cloning, so a run is pinned to one revision. */
  sha?: string
  /**
   * Bearer token for the clone. Passed through `http.extraHeader` rather than
   * embedded in the URL, so it stays out of `ps` output and git's own logs.
   */
  token?: string
}

export interface StepResult {
  name: string
  exitCode: number
  stdout: string
  stderr: string
  startedAt: number
  finishedAt: number
  /** True when a dependency failed and this step was never started. */
  skipped: boolean
}

export interface RunResult {
  ok: boolean
  steps: StepResult[]
  error?: string
}

/** Where log lines are delivered as they arrive. */
export interface LogSink {
  append(stepName: string, text: string, isStderr: boolean): void | Promise<void>
}

/** The stub `getSandbox` returns, named so helpers can be typed without `any`. */
type SandboxStub = ReturnType<typeof getSandbox>

export interface SandboxRunnerOptions {
  sandboxBinding: DurableObjectNamespace<Sandbox>
  /** Stable per-run id, so a retry reuses the same container. */
  runId: string
  /**
   * Omitted to run a plan without a working copy. Useful for pipelines that
   * only shell out to external tools, and for exercising the runner itself.
   */
  checkout?: CheckoutSpec
  /**
   * Either a plan already built, or instructions to evaluate the repo's own
   * `.gitflare/ci.ts` after checkout. The second form is what a push trigger
   * uses: the config is untrusted, so it is executed in the container that was
   * just cloned into, never in the Worker isolate.
   */
  plan: Plan | { fromRepo: BuildContext }
  sink?: LogSink
  /** Injected into every step. Secrets belong in `PlanStep.secrets` instead. */
  env?: Record<string, string>
  /** Per-command ceiling. The container is torn down regardless when the run ends. */
  stepTimeoutMs?: number
  /** How long to wait for a cold container before failing the run. */
  readyTimeoutMs?: number
}

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60 * 1000
const WORKDIR = '/workspace/repo'

/** How long to wait for a cold container before giving up. */
const READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 500

/**
 * Waits for the container to accept commands.
 *
 * A cold start takes tens of seconds, and until it finishes every call fails
 * with "Container is starting. Please retry in a moment." Without this, the
 * first step of every cold run fails for a reason that has nothing to do with
 * the pipeline — which is exactly what happened the first time this ran against
 * a real container.
 */
async function waitForReady(sandbox: SandboxStub, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      // `exec` rather than a liveness ping: this proves the container can
      // actually run a command, which is what every step needs next.
      await sandbox.exec('true', { timeout: 10_000 })
      return
    } catch (error) {
      lastError = error
      // Only the startup race is worth retrying; a misconfigured binding would
      // otherwise spin here for the full two minutes.
      if (!isStarting(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
  }

  throw new Error(`Container did not become ready within ${timeoutMs}ms: ${message(lastError)}`)
}

function isStarting(error: unknown): boolean {
  return /container is starting|not ready|starting up/i.test(message(error))
}

export async function runPlanInSandbox(options: SandboxRunnerOptions): Promise<RunResult> {
  const sandbox = getSandbox(options.sandboxBinding, options.runId)
  const steps: StepResult[] = []

  try {
    await waitForReady(sandbox, options.readyTimeoutMs ?? READY_TIMEOUT_MS)
  } catch (error) {
    return { ok: false, steps, error: `Sandbox unavailable: ${message(error)}` }
  }

  if (options.checkout?.repoUrl) {
    try {
      await checkout(sandbox, options.checkout)
    } catch (error) {
      return { ok: false, steps, error: `Checkout failed: ${message(error)}` }
    }
  }

  if (options.env) await sandbox.setEnvVars(options.env)

  let plan: Plan
  try {
    plan = await resolvePlan(sandbox, options)
  } catch (error) {
    return { ok: false, steps, error: message(error) }
  }

  // A repo with no config has no pipeline. That is not a failure.
  if (plan.steps.length === 0) return { ok: true, steps }

  const waves = planWaves(plan)
  const failed = new Set<string>()

  for (const wave of waves) {
    // Steps in a wave have no dependency on each other, so they start together.
    const results = await Promise.all(
      wave.map((step) => runStep(sandbox, step, options, failed)),
    )
    for (const result of results) {
      steps.push(result)
      if (result.exitCode !== 0) failed.add(result.name)
    }
  }

  const failure = steps.find((step) => step.exitCode !== 0 && !step.skipped)
  return {
    ok: failure === undefined,
    steps,
    ...(failure ? { error: `Step "${failure.name}" exited with code ${failure.exitCode}` } : {}),
  }
}

/**
 * Clones the repo into the container.
 *
 * `sandbox.gitCheckout()` exists but takes no credentials, so an authenticated
 * clone has to go through `git` directly. The token is passed with
 * `-c http.extraHeader`, never in the URL: a URL-embedded credential shows up in
 * `ps`, in `.git/config`, and in any error message git prints about the remote.
 */
async function checkout(sandbox: SandboxStub, spec: CheckoutSpec): Promise<void> {
  const { repoUrl, branch, sha, token } = spec

  const args = [
    'git',
    ...(token ? [`-c`, `http.extraHeader="Authorization: Bearer ${token}"`] : []),
    'clone',
    // A CI run only needs the tip commit unless it is pinned to an older one;
    // full history on a large repo is mostly download time.
    ...(sha ? [] : ['--depth', '1']),
    // Quoted like every other interpolated value: a branch name is attacker-
    // controlled, and an unquoted one is a shell injection into the container.
    ...(branch ? ['--branch', quote(branch)] : []),
    quote(repoUrl),
    WORKDIR,
  ]

  const cloned = await sandbox.exec(args.join(' '), { timeout: 120_000 })
  if (cloned.exitCode !== 0) {
    // Redacted: git echoes the failing command, which includes the header.
    throw new Error(redact(cloned.stderr || 'git clone failed', token))
  }

  if (sha) {
    // Pin the run to one revision. Without this, a push landing mid-run would
    // silently change what is being tested.
    const checkedOut = await sandbox.exec(`git checkout --detach ${quote(sha)}`, {
      cwd: WORKDIR,
      timeout: 60_000,
    })
    if (checkedOut.exitCode !== 0) {
      throw new Error(`could not check out ${sha}: ${redact(checkedOut.stderr, token)}`)
    }
  }
}

/**
 * Produces the plan to run.
 *
 * When the caller asked for the repo's own config, it is evaluated by a command
 * in the container rather than imported here — importing a contributor's
 * TypeScript into the Worker would be remote code execution against the control
 * plane, with D1 and the Artifacts binding in scope. Only JSON comes back.
 */
async function resolvePlan(sandbox: SandboxStub, options: SandboxRunnerOptions): Promise<Plan> {
  if (!('fromRepo' in options.plan)) return options.plan

  const result = await sandbox.exec(buildEmitCommand(options.plan.fromRepo), {
    cwd: WORKDIR,
    timeout: 120_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(`Could not evaluate .gitflare/ci.ts: ${result.stderr || result.stdout}`)
  }

  // A missing config yields null, which is "no pipeline" rather than an error.
  return parseEmittedPlan(result.stdout) ?? { version: 1, steps: [] }
}

/** Single-quotes a value for the shell, so a crafted branch name cannot inject. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function redact(text: string, token?: string): string {
  return token ? text.replaceAll(token, '***') : text
}

async function runStep(
  sandbox: SandboxStub,
  step: PlanStep,
  options: SandboxRunnerOptions,
  failed: Set<string>,
): Promise<StepResult> {
  const startedAt = Date.now()

  // A step whose dependency failed is skipped rather than run against a
  // half-built workspace — unless it opted into running anyway, which is how
  // cleanup and reporting steps work.
  const blocked = step.needs.some((need) => failed.has(need))
  if (blocked && !step.always) {
    return {
      name: step.name,
      exitCode: -1,
      stdout: '',
      stderr: '',
      startedAt,
      finishedAt: startedAt,
      skipped: true,
    }
  }

  const stream = await sandbox.execStream(step.command, {
    // Without a checkout there is no repo directory to run in.
    cwd: options.checkout?.repoUrl
      ? step.cwd
        ? `${WORKDIR}/${step.cwd}`
        : WORKDIR
      : step.cwd,
    timeout: step.timeoutMs ?? options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    ...(step.env ? { env: step.env } : {}),
  })

  let stdout = ''
  let stderr = ''
  let exitCode = 0

  // Output is forwarded to the sink as it arrives, which is the whole point of
  // streaming — a ten-minute build should not show a blank log for ten minutes.
  for await (const event of parseSSEStream<ExecEvent>(stream)) {
    switch (event.type) {
      case 'stdout': {
        // `data` is optional on the wire; an empty frame carries no output.
        const text = event.data ?? ''
        stdout += text
        if (text) await options.sink?.append(step.name, text, false)
        break
      }
      case 'stderr': {
        const text = event.data ?? ''
        stderr += text
        if (text) await options.sink?.append(step.name, text, true)
        break
      }
      case 'complete':
        exitCode = event.exitCode ?? 0
        break
      case 'error':
        // A transport failure is a step failure; there is no partial success to
        // salvage, and reporting 0 here would mark a broken run green.
        exitCode = exitCode || 1
        stderr += event.error ?? 'stream error'
        await options.sink?.append(step.name, `\n${event.error ?? 'stream error'}\n`, true)
        break
    }
  }

  return {
    name: step.name,
    exitCode,
    stdout,
    stderr,
    startedAt,
    finishedAt: Date.now(),
    skipped: false,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { WORKDIR }
