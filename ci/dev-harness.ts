import { runPlanInSandbox } from './sandbox-runner'
import { defineCI, type Plan } from '../packages/ci-config/src/index'
import { GitflareSandbox } from '../src/server/ci/sandbox'

/**
 * Local verification harness for the Sandbox CI runner.
 *
 * `@cloudflare/vitest-pool-workers` does not plumb the `containers` array
 * through to workerd — a Sandbox-backed Durable Object there fails with
 * "Containers have not been enabled for this Durable Object class" — so the
 * runner cannot be covered by the normal integration suite. `wrangler dev`
 * does support containers, so this exposes the runner over HTTP to be exercised
 * against a real container.
 *
 * Run with:
 *   wrangler dev --config wrangler.sandbox.jsonc
 *   curl -X POST localhost:8787 -d '{"steps":[{"name":"a","command":"echo hi","needs":[]}]}'
 *
 * Not deployed and not referenced by the application. See ci/sandbox-runner.ts
 * for the module under test.
 */

interface HarnessEnv {
  SANDBOX: DurableObjectNamespace<GitflareSandbox>
}

export { GitflareSandbox }

export default {
  async fetch(request: Request, env: HarnessEnv): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST a {"steps":[...]} plan, or {"demo":true}\n', { status: 405 })
    }

    const body = (await request.json().catch(() => ({}))) as {
      steps?: Plan['steps']
      demo?: boolean
      repoUrl?: string
      branch?: string
    }

    const plan: Plan = body.demo
      ? demoPlan()
      : { version: 1, steps: body.steps ?? [] }

    const logs: string[] = []
    const started = Date.now()

    const result = await runPlanInSandbox({
      sandboxBinding: env.SANDBOX,
      runId: `harness-${started}`,
      ...(body.repoUrl
        ? { checkout: { repoUrl: body.repoUrl, ...(body.branch ? { branch: body.branch } : {}) } }
        : {}),
      plan,
      sink: {
        append: (step, text, isStderr) => {
          logs.push(`[${step}${isStderr ? ':err' : ''}] ${text.trimEnd()}`)
        },
      },
    })

    return Response.json({
      ok: result.ok,
      error: result.error,
      elapsedMs: Date.now() - started,
      steps: result.steps.map((step) => ({
        name: step.name,
        exitCode: step.exitCode,
        skipped: step.skipped,
        stdout: step.stdout.trimEnd(),
        stderr: step.stderr.trimEnd(),
        durationMs: step.finishedAt - step.startedAt,
      })),
      // Proves output arrived incrementally rather than only at completion.
      streamed: logs,
    })
  },
}

/** Exercises ordering, parallelism, failure propagation, and both streams. */
function demoPlan(): Plan {
  return defineCI(({ run, parallel }) => {
    const setup = run('setup', 'echo setting-up && mkdir -p /tmp/demo')
    parallel(
      setup.run('stdout-and-stderr', 'echo to-stdout; echo to-stderr >&2'),
      setup.run('counts', 'for i in 1 2 3; do echo line-$i; done'),
      setup.run('tooling', 'node --version && git --version'),
    )
  }).build({
    owner: 'astrid',
    repo: 'gitflare',
    sha: 'harness',
    ref: 'refs/heads/main',
    branch: 'main',
    trigger: 'manual',
    isDefaultBranch: true,
  })
}
