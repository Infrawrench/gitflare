import { describe, expect, it } from 'vitest'
import {
  CONFIG_PATH,
  PLAN_BEGIN,
  PLAN_END,
  buildEmitCommand,
  parseEmittedPlan,
  readLog,
} from '../../ci/plan-emitter'

const context = {
  owner: 'astrid',
  repo: 'api',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
  branch: 'main',
  trigger: 'push' as const,
  isDefaultBranch: true,
}

function emitted(payload: string): string {
  return `bun install v1.2\nsome build noise\n${PLAN_BEGIN}${payload}${PLAN_END}\n`
}

describe('buildEmitCommand', () => {
  it('embeds the real ci-config source so the shim cannot drift', () => {
    const command = buildEmitCommand(context)
    // Proves the ?raw import resolved to the actual module, not a copy.
    expect(command).toContain('export function defineCI')
    expect(command).toContain('node_modules/@gitflare/ci-config')
  })

  it('short-circuits when the repo has no config', () => {
    const command = buildEmitCommand(context)
    expect(command).toContain(`if [ ! -f ${CONFIG_PATH} ]`)
    expect(command).toContain(`${PLAN_BEGIN}null${PLAN_END}`)
  })

  it('passes the commit context into the sandbox', () => {
    const command = buildEmitCommand(context)
    expect(command).toContain('"owner":"astrid"')
    expect(command).toContain('"isDefaultBranch":true')
  })

  it('quotes heredoc delimiters so the shell cannot expand the payload', () => {
    // Without the quotes, a $VAR or backtick in a user's config would be
    // substituted by the shell before bun ever saw it.
    const command = buildEmitCommand(context)
    expect(command).toContain("<<'GITFLARE_SHIM_EOF'")
    expect(command).toContain("<<'GITFLARE_EMIT_EOF'")
  })
})

describe('parseEmittedPlan', () => {
  it('extracts the plan from noisy stdout', () => {
    const plan = parseEmittedPlan(
      emitted(JSON.stringify({ version: 1, steps: [{ name: 'a', command: 'x', needs: [] }] })),
    )
    expect(plan?.steps).toEqual([{ name: 'a', command: 'x', needs: [] }])
  })

  it('treats a null payload as "no pipeline", not an error', () => {
    expect(parseEmittedPlan(emitted('null'))).toBeNull()
  })

  it('uses the last marker when the config printed one itself', () => {
    // A config that logs something resembling the sentinel must not be able to
    // spoof the real plan, which is always emitted last.
    const decoy = `${PLAN_BEGIN}{"version":1,"steps":[{"name":"decoy","command":"evil","needs":[]}]}${PLAN_END}`
    const real = JSON.stringify({ version: 1, steps: [{ name: 'real', command: 'ok', needs: [] }] })
    const plan = parseEmittedPlan(`${decoy}\n${PLAN_BEGIN}${real}${PLAN_END}`)
    expect(plan?.steps[0]!.name).toBe('real')
  })

  it('explains a config that forgot to default-export defineCI', () => {
    expect(() => parseEmittedPlan('bun ran but printed nothing')).toThrow(/did not emit a pipeline/)
  })

  it('rejects a truncated marker', () => {
    expect(() => parseEmittedPlan(`${PLAN_BEGIN}{"version":1`)).toThrow(/truncated/)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseEmittedPlan(emitted('{not json'))).toThrow(/not valid JSON/)
  })

  it('rejects a plan from an unrecognized version', () => {
    expect(() => parseEmittedPlan(emitted('{"version":99,"steps":[]}'))).toThrow(/unrecognized shape/)
  })
})

describe('readLog', () => {
  it('accepts a string', async () => {
    expect(await readLog('hello')).toBe('hello')
  })

  it('accepts a stream, which is how large logs arrive', async () => {
    const stream = new Response('streamed output').body!
    expect(await readLog(stream)).toBe('streamed output')
  })
})
