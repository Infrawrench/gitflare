/**
 * `@gitflare/ci-config` — the API a repo's `.gitflare/ci.ts` imports.
 *
 * Pipelines are written as TypeScript rather than YAML, but they are not
 * *executed* as arbitrary code by the forge. Running a contributor's script
 * inside the Worker isolate would be remote code execution against the control
 * plane, so instead this module builds a declarative plan: calling `run()`
 * records a node, it does not spawn anything.
 *
 * The plan is serialized in a sandbox (see `emitPlan`) and handed to the
 * Workflow, which replays it through `@cloudflare/ci`'s `ci.runner()`. Every
 * command still executes as a durable, retried Workflow step — the TypeScript
 * only decides the shape of the graph.
 *
 *   export default defineCI(({ run, parallel }) => {
 *     const deps = run('install', 'bun install --frozen-lockfile', {
 *       cache: ['package.json', 'bun.lock'],
 *     })
 *     return parallel(
 *       deps.run('lint', 'bun run lint'),
 *       deps.run('test', 'bun run test'),
 *     )
 *   })
 */

export interface StepOptions {
  /**
   * Paths whose git blob SHAs key this step's snapshot cache. An unchanged key
   * restores the previous workspace and skips the command entirely.
   */
  cache?: string[]
  /** Working directory, relative to the checkout root. */
  cwd?: string
  env?: Record<string, string>
  /** Worker secret names to inject into the command environment. */
  secrets?: string[]
  /**
   * Injects Cloudflare deployment credentials. Scoped per step so that build and
   * test commands never see a token that can deploy.
   */
  cloudflareCredentials?: boolean | { accountId: string }
  /** Injects a repo-scoped Artifacts token as ARTIFACTS_REMOTE / ARTIFACTS_TOKEN. */
  sourceControlCredentials?: boolean
  timeoutMs?: number
  retries?: number
  /** Run this step even when a dependency failed — for cleanup or reporting. */
  always?: boolean
}

export interface PlanStep extends StepOptions {
  name: string
  command: string
  /** Names of steps that must finish first. Empty means it can start immediately. */
  needs: string[]
}

export interface Plan {
  version: 1
  steps: PlanStep[]
}

/**
 * A recorded step. Chaining `.run()` off one declares a dependency, which is how
 * the graph is built without a separate `needs:` bookkeeping list.
 */
export interface StepHandle {
  readonly name: string
  run(name: string, command: string, options?: StepOptions): StepHandle
}

export interface CIContext {
  /** Declares a step with no dependencies. */
  run(name: string, command: string, options?: StepOptions): StepHandle
  /**
   * Groups steps that may run concurrently. Purely for readability — steps with
   * no dependency between them are already eligible to run in parallel.
   */
  parallel(...handles: StepHandle[]): StepHandle[]
  /** Metadata about the commit under test. */
  readonly context: BuildContext
}

export interface BuildContext {
  owner: string
  repo: string
  sha: string
  ref: string
  branch?: string
  tag?: string
  trigger: 'push' | 'tag' | 'manual'
  /** True when the push targeted the repo's default branch. */
  isDefaultBranch: boolean
}

export type PipelineFn = (ci: CIContext) => unknown

export interface CIDefinition {
  readonly __gitflareCI: 1
  build(context: BuildContext): Plan
}

class PlanBuilder {
  readonly steps: PlanStep[] = []
  private readonly used = new Set<string>()

  add(name: string, command: string, needs: string[], options: StepOptions): StepHandle {
    if (name.trim() === '') throw new Error('CI step name must not be empty')
    // Step names become Workflow step identifiers, which must be deterministic
    // and unique — Workflows uses them to match a replayed step to its result.
    if (this.used.has(name)) throw new Error(`Duplicate CI step name: ${name}`)
    this.used.add(name)

    this.steps.push({ ...options, name, command, needs })
    return this.handle(name)
  }

  private handle(name: string): StepHandle {
    const builder = this
    return {
      name,
      run(next: string, command: string, options: StepOptions = {}) {
        return builder.add(next, command, [name], options)
      },
    }
  }
}

export function defineCI(pipeline: PipelineFn): CIDefinition {
  return {
    __gitflareCI: 1,
    build(context: BuildContext): Plan {
      const builder = new PlanBuilder()
      const ci: CIContext = {
        context,
        run: (name, command, options = {}) => builder.add(name, command, [], options),
        parallel: (...handles) => handles,
      }
      pipeline(ci)
      return { version: 1, steps: builder.steps }
    },
  }
}

export function isCIDefinition(value: unknown): value is CIDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __gitflareCI?: unknown }).__gitflareCI === 1 &&
    typeof (value as { build?: unknown }).build === 'function'
  )
}

/**
 * Validates a plan and returns it in dependency order.
 *
 * Rejects unknown dependencies and cycles. Both would otherwise surface as a
 * Workflow that hangs or silently skips steps, which is far harder to diagnose
 * than a failure at plan time.
 */
export function topoSort(plan: Plan): PlanStep[] {
  const byName = new Map(plan.steps.map((step) => [step.name, step]))

  for (const step of plan.steps) {
    for (const need of step.needs) {
      if (!byName.has(need)) {
        throw new Error(`CI step "${step.name}" depends on unknown step "${need}"`)
      }
    }
  }

  const ordered: PlanStep[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (step: PlanStep, trail: string[]): void => {
    const status = state.get(step.name)
    if (status === 'done') return
    if (status === 'visiting') {
      throw new Error(`CI step dependency cycle: ${[...trail, step.name].join(' -> ')}`)
    }
    state.set(step.name, 'visiting')
    for (const need of step.needs) {
      visit(byName.get(need)!, [...trail, step.name])
    }
    state.set(step.name, 'done')
    ordered.push(step)
  }

  for (const step of plan.steps) visit(step, [])
  return ordered
}

/**
 * Groups a plan into waves of steps that can run concurrently: everything in
 * wave N depends only on steps in earlier waves. The Workflow awaits each wave
 * with Promise.all.
 */
export function planWaves(plan: Plan): PlanStep[][] {
  const ordered = topoSort(plan)
  const depth = new Map<string, number>()
  const waves: PlanStep[][] = []

  for (const step of ordered) {
    const level = step.needs.reduce((max, need) => Math.max(max, (depth.get(need) ?? 0) + 1), 0)
    depth.set(step.name, level)
    ;(waves[level] ??= []).push(step)
  }

  return waves
}
