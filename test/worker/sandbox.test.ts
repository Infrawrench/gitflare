import { describe, expect, it } from 'vitest'
import { runPlanInSandbox } from '../../ci/sandbox-runner'
import { defineCI } from '../../packages/ci-config/src/index'
import { testEnv } from './helpers'

/**
 * The CI runner against a real Sandbox container.
 *
 * Everything else about the runner is covered with a faked container in
 * `test/unit/sandbox-runner.test.ts`. These tests exist for the part a fake
 * cannot answer: that commands actually execute, exit codes come back, and
 * output streams.
 *
 * Skipped by default, for two independent reasons found by trying to run them:
 *
 *  1. `@cloudflare/vitest-pool-workers` does not plumb the `containers` array
 *     through to workerd. A Sandbox-backed Durable Object here fails with
 *     "Containers have not been enabled for this Durable Object class",
 *     whatever the wrangler config says.
 *
 *  2. `cloudflare/sandbox` publishes a single-platform **amd64** image — no
 *     arm64 variant exists in any version, including 0.13.x. On Apple Silicon
 *     it runs under QEMU and is too slow to pass the SDK's own startup probe,
 *     which gives up after 8 attempts over ~141s.
 *
 * Use `ci/dev-harness.ts` with `wrangler dev` to exercise the runner against a
 * real container on an amd64 host, where containers are properly supported.
 * Set GITFLARE_SANDBOX_TESTS=1 to attempt these anyway.
 */

const context = {
  owner: 'astrid',
  repo: 'gitflare',
  sha: 'x',
  ref: 'refs/heads/main',
  branch: 'main',
  trigger: 'push' as const,
  isDefaultBranch: true,
}

// Container startup dominates; the commands themselves are trivial.
const TIMEOUT = 180_000

// Narrowed once here so each test can pass it without re-checking; the suite
// is skipped entirely when the binding is absent.
const sandboxBinding = testEnv.SANDBOX!

const enabled = process.env.GITFLARE_SANDBOX_TESTS === '1' && Boolean(testEnv.SANDBOX)

describe.skipIf(!enabled)('sandbox runner (real container)', () => {
  it(
    'runs a plan and reports success',
    async () => {
      const plan = defineCI(({ run }) => {
        const first = run('greet', 'echo hello-from-ci')
        first.run('second', 'echo second-step')
      }).build(context)

      const result = await runPlanInSandbox({
        sandboxBinding,
        runId: `test-success-${Date.now()}`,
        // A repo is not needed for commands that do not read one; skipping the
        // clone keeps this test about execution.
        checkout: { repoUrl: '' },
        plan,
      })

      expect(result.steps.map((step) => step.name)).toEqual(['greet', 'second'])
      expect(result.steps[0]!.stdout).toContain('hello-from-ci')
      expect(result.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'propagates a non-zero exit code and skips dependents',
    async () => {
      const plan = defineCI(({ run }) => {
        const failing = run('fail', 'exit 3')
        failing.run('never', 'echo should-not-run')
      }).build(context)

      const result = await runPlanInSandbox({
        sandboxBinding,
        runId: `test-failure-${Date.now()}`,
        checkout: { repoUrl: '' },
        plan,
      })

      expect(result.ok).toBe(false)
      expect(result.steps[0]!.exitCode).toBe(3)
      expect(result.steps[1]!.skipped).toBe(true)
      expect(result.steps[1]!.stdout).toBe('')
    },
    TIMEOUT,
  )

  it(
    'streams output to the sink while the command runs',
    async () => {
      const seen: string[] = []
      const plan = defineCI(({ run }) => {
        run('emit', 'for i in 1 2 3; do echo line-$i; done')
      }).build(context)

      const result = await runPlanInSandbox({
        sandboxBinding,
        runId: `test-stream-${Date.now()}`,
        checkout: { repoUrl: '' },
        plan,
        sink: { append: (_step, text) => void seen.push(text) },
      })

      expect(result.ok).toBe(true)
      const combined = seen.join('')
      expect(combined).toContain('line-1')
      expect(combined).toContain('line-3')
    },
    TIMEOUT,
  )

  it(
    'separates stderr from stdout',
    async () => {
      const plan = defineCI(({ run }) => {
        run('both', 'echo to-stdout; echo to-stderr >&2')
      }).build(context)

      const result = await runPlanInSandbox({
        sandboxBinding,
        runId: `test-streams-${Date.now()}`,
        checkout: { repoUrl: '' },
        plan,
      })

      expect(result.steps[0]!.stdout).toContain('to-stdout')
      expect(result.steps[0]!.stderr).toContain('to-stderr')
      expect(result.steps[0]!.stdout).not.toContain('to-stderr')
    },
    TIMEOUT,
  )
})
