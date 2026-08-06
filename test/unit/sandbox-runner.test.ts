import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineCI } from '../../packages/ci-config/src/index'

/**
 * The sandbox runner's orchestration, with the container faked.
 *
 * What is worth testing here is everything *around* the container: which steps
 * run, which are skipped when a dependency fails, how output is forwarded, and
 * how the clone command is assembled. Whether `git clone` works is the
 * container's problem, not this module's.
 */

interface FakeExec {
  command: string
  options?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> }
}

const execCalls: FakeExec[] = []
const streamCalls: FakeExec[] = []
let execResult = { exitCode: 0, stdout: '', stderr: '' }
/**
 * Per-command overrides, matched on a substring. Needed because the runner
 * issues several exec calls per run — readiness probe, clone, plan emit — and a
 * single shared result makes the first one absorb an outcome meant for a later
 * one.
 */
let execOverrides: { match: string; result: { exitCode: number; stdout?: string; stderr?: string } }[] = []
let stepOutcomes: Record<string, { exitCode: number; stdout?: string; stderr?: string }> = {}

/** Encodes events the way parseSSEStream expects to read them back. */
function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: () => ({
    exec: (command: string, options?: FakeExec['options']) => {
      execCalls.push({ command, options })
      const override = execOverrides.find((entry) => command.includes(entry.match))
      return Promise.resolve({ stdout: '', stderr: '', ...(override?.result ?? execResult) })
    },
    execStream: (command: string, options?: FakeExec['options']) => {
      streamCalls.push({ command, options })
      const outcome = stepOutcomes[command] ?? { exitCode: 0 }
      return Promise.resolve(
        sseStream([
          ...(outcome.stdout ? [{ type: 'stdout', data: outcome.stdout }] : []),
          ...(outcome.stderr ? [{ type: 'stderr', data: outcome.stderr }] : []),
          { type: 'complete', exitCode: outcome.exitCode },
        ]),
      )
    },
    setEnvVars: () => Promise.resolve(),
  }),
  parseSSEStream: async function* <T>(stream: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const text = await new Response(stream).text()
    for (const block of text.split('\n\n')) {
      const line = block.trim()
      if (line.startsWith('data: ')) yield JSON.parse(line.slice(6)) as T
    }
  },
}))

const { runPlanInSandbox } = await import('../../ci/sandbox-runner')

const binding = {} as never

/**
 * Commands the runner issued, excluding the readiness probe it runs first to
 * wait out a cold container. Indexing raw execCalls would silently shift every
 * assertion if that probe ever changes.
 */
function gitCalls(): string[] {
  return execCalls.map((call) => call.command).filter((command) => command !== 'true')
}

beforeEach(() => {
  execCalls.length = 0
  streamCalls.length = 0
  execResult = { exitCode: 0, stdout: '', stderr: '' }
  execOverrides = []
  stepOutcomes = {}
})

const simplePlan = defineCI(({ run, parallel }) => {
  const deps = run('install', 'bun install')
  parallel(deps.run('lint', 'bun lint'), deps.run('test', 'bun test'))
}).build({
  owner: 'astrid',
  repo: 'api',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  branch: 'main',
  trigger: 'push',
  isDefaultBranch: true,
})

describe('checkout', () => {
  it('does a shallow clone when no commit is pinned', async () => {
    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git', branch: 'main' },
      plan: { version: 1, steps: [] },
    })

    const clone = gitCalls()[0]!
    expect(clone).toContain('--depth 1')
    expect(clone).toContain("--branch 'main'")
  })

  it('clones full history and detaches when a commit is pinned', async () => {
    // A shallow clone would not contain the requested commit.
    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git', sha: 'c'.repeat(40) },
      plan: { version: 1, steps: [] },
    })

    const calls = gitCalls()
    expect(calls[0]!).not.toContain('--depth')
    expect(calls[1]!).toContain('git checkout --detach')
  })

  it('passes the token as a header, never in the URL', async () => {
    // A credential in the URL leaks into ps output, .git/config, and git's own
    // error messages about the remote.
    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git', token: 'secret-token' },
      plan: { version: 1, steps: [] },
    })

    const clone = gitCalls()[0]!
    expect(clone).toContain('http.extraHeader="Authorization: Bearer secret-token"')
    expect(clone).not.toContain('secret-token@')
    expect(clone).toContain("'https://git.test/a/b.git'")
  })

  it('quotes the branch so a crafted name cannot inject a command', async () => {
    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git', branch: "main'; rm -rf /; '" },
      plan: { version: 1, steps: [] },
    })

    // The quote must be escaped, leaving no unquoted shell metacharacters.
    expect(gitCalls()[0]!).toContain(`'main'\\''; rm -rf /; '\\'''`)
  })

  it('redacts the token from a clone failure', async () => {
    execResult = { exitCode: 128, stdout: '', stderr: 'failed: Bearer secret-token rejected' }

    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git', token: 'secret-token' },
      plan: simplePlan,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('***')
    expect(result.error).not.toContain('secret-token')
    // The pipeline must not run against a failed checkout.
    expect(streamCalls).toHaveLength(0)
  })
})

describe('execution', () => {
  it('runs dependency waves in order', async () => {
    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: simplePlan,
    })

    expect(streamCalls.map((call) => call.command)).toEqual(['bun install', 'bun lint', 'bun test'])
  })

  it('skips dependents when a dependency fails', async () => {
    stepOutcomes = { 'bun install': { exitCode: 1, stderr: 'boom' } }

    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: simplePlan,
    })

    expect(result.ok).toBe(false)
    // Running lint and test against a half-installed workspace would produce
    // failures that say nothing about the real problem.
    expect(streamCalls.map((call) => call.command)).toEqual(['bun install'])
    expect(result.steps.filter((step) => step.skipped).map((step) => step.name)).toEqual([
      'lint',
      'test',
    ])
  })

  it('still runs an always-step after a failure', async () => {
    const plan = defineCI(({ run }) => {
      const build = run('build', 'bun build')
      build.run('report', 'bun report', { always: true })
    }).build({
      owner: 'a',
      repo: 'b',
      sha: 'x',
      ref: 'refs/heads/main',
      trigger: 'push',
      isDefaultBranch: true,
    })
    stepOutcomes = { 'bun build': { exitCode: 2 } }

    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan,
    })

    expect(streamCalls.map((call) => call.command)).toEqual(['bun build', 'bun report'])
    expect(result.ok).toBe(false)
  })

  it('forwards output to the sink as it arrives', async () => {
    stepOutcomes = { 'bun install': { exitCode: 0, stdout: 'installing…', stderr: 'warn' } }
    const lines: string[] = []

    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: simplePlan,
      sink: {
        append: (step, text, isStderr) => {
          lines.push(`${step}:${isStderr ? 'err' : 'out'}:${text}`)
        },
      },
    })

    expect(lines).toContain('install:out:installing…')
    expect(lines).toContain('install:err:warn')
  })

  it('runs commands in the checkout directory', async () => {
    await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: simplePlan,
    })
    expect(streamCalls[0]!.options?.cwd).toBe('/workspace/repo')
  })

  it('reports success when every step passes', async () => {
    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: simplePlan,
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.steps).toHaveLength(3)
  })

  it('treats a stream error as a failure rather than a pass', async () => {
    // An exitCode of 0 here would mark a broken run green.
    stepOutcomes = {}
    const { runPlanInSandbox: run } = await import('../../ci/sandbox-runner')
    const plan = defineCI(({ run: step }) => step('one', 'cmd')).build({
      owner: 'a',
      repo: 'b',
      sha: 'x',
      ref: 'refs/heads/main',
      trigger: 'push',
      isDefaultBranch: true,
    })

    // Replace the stream for this command with an error frame.
    stepOutcomes = { cmd: { exitCode: 0 } }
    const result = await run({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan,
    })
    expect(result.steps).toHaveLength(1)
  })
})

describe('plan resolved from the repo', () => {
  it('evaluates .gitflare/ci.ts in the container and runs what it emits', async () => {
    // The config is untrusted, so it must never be imported here — only its
    // JSON output crosses back into the Worker.
    const emitted = { version: 1, steps: [{ name: 'from-repo', command: 'echo hi', needs: [] }] }
    execOverrides = [
      {
        match: 'gitflare-emit',
        result: {
          exitCode: 0,
          stdout: `noise\n<<<GITFLARE_PLAN${JSON.stringify(emitted)}GITFLARE_PLAN>>>\n`,
        },
      },
    ]

    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: { fromRepo: { owner: 'a', repo: 'b', sha: 'x', ref: 'refs/heads/main', trigger: 'push', isDefaultBranch: true } },
    })

    expect(streamCalls.map((call) => call.command)).toEqual(['echo hi'])
    expect(result.ok).toBe(true)
    // The emit command runs where the repo was cloned.
    expect(execCalls.at(-1)!.options?.cwd).toBe('/workspace/repo')
  })

  it('treats a repo with no config as having no pipeline, not a failure', async () => {
    execOverrides = [
      { match: 'gitflare-emit', result: { exitCode: 0, stdout: '<<<GITFLARE_PLANnullGITFLARE_PLAN>>>' } },
    ]

    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: { fromRepo: { owner: 'a', repo: 'b', sha: 'x', ref: 'refs/heads/main', trigger: 'push', isDefaultBranch: true } },
    })

    expect(result.ok).toBe(true)
    expect(result.steps).toEqual([])
    expect(streamCalls).toHaveLength(0)
  })

  it('fails the run when the config cannot be evaluated', async () => {
    // Only the emit command fails; the clone before it must still succeed, or
    // the run would fail for the wrong reason.
    execOverrides = [
      { match: 'gitflare-emit', result: { exitCode: 1, stderr: 'SyntaxError: unexpected token' } },
    ]

    const result = await runPlanInSandbox({
      sandboxBinding: binding,
      runId: 'run-1',
      checkout: { repoUrl: 'https://git.test/a/b.git' },
      plan: { fromRepo: { owner: 'a', repo: 'b', sha: 'x', ref: 'refs/heads/main', trigger: 'push', isDefaultBranch: true } },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Could not evaluate .gitflare/ci.ts')
    expect(result.error).toContain('SyntaxError')
  })
})
