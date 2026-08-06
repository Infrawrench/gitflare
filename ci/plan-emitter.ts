import ciConfigSource from '../packages/ci-config/src/index.ts?raw'
import type { BuildContext, Plan } from '../packages/ci-config/src/index'

/**
 * Evaluating a repo's `.gitflare/ci.ts`.
 *
 * The config is TypeScript written by whoever can push to the repo, so it is
 * untrusted. It is never imported into the Worker — that would be arbitrary code
 * execution against the control plane, with the Artifacts binding and D1 in
 * scope. Instead it runs inside the same Sandbox container that runs the build,
 * where the blast radius is one disposable VM, and all that comes back is JSON.
 *
 * The `?raw` import keeps `@gitflare/ci-config` single-sourced: the shim written
 * into the sandbox is compiled from the same file users import, so the two
 * cannot drift.
 */

export const PLAN_BEGIN = '<<<GITFLARE_PLAN'
export const PLAN_END = 'GITFLARE_PLAN>>>'

export const CONFIG_PATH = '.gitflare/ci.ts'

/**
 * Shell command that evaluates the repo's config and prints its plan.
 *
 * The config resolves `@gitflare/ci-config` from a shim dropped into
 * node_modules, so a repo does not have to install anything to describe a
 * pipeline. A real installed copy would shadow the shim, which is fine — the
 * API is the same file.
 */
export function buildEmitCommand(context: BuildContext): string {
  const shimDir = 'node_modules/@gitflare/ci-config'
  // Single-quoted heredoc delimiters, so nothing inside is expanded by the shell.
  return [
    `if [ ! -f ${CONFIG_PATH} ]; then echo "${PLAN_BEGIN}null${PLAN_END}"; exit 0; fi`,
    `mkdir -p ${shimDir}`,
    `cat > ${shimDir}/index.ts <<'GITFLARE_SHIM_EOF'\n${ciConfigSource}\nGITFLARE_SHIM_EOF`,
    `cat > ${shimDir}/package.json <<'GITFLARE_PKG_EOF'\n${JSON.stringify(
      { name: '@gitflare/ci-config', version: '0.0.0', type: 'module', main: 'index.ts' },
      null,
      2,
    )}\nGITFLARE_PKG_EOF`,
    `cat > .gitflare-emit.ts <<'GITFLARE_EMIT_EOF'\n${emitterSource(context)}\nGITFLARE_EMIT_EOF`,
    `bun .gitflare-emit.ts`,
  ].join(' && ')
}

function emitterSource(context: BuildContext): string {
  return `
import definition from './${CONFIG_PATH}'
import { isCIDefinition, topoSort } from '@gitflare/ci-config'

const context = ${JSON.stringify(context)}

if (!isCIDefinition(definition)) {
  console.error('${CONFIG_PATH} must "export default defineCI(...)"')
  process.exit(1)
}

const plan = definition.build(context)
// Validate here, in the sandbox, so a cycle or a bad dependency fails with a
// clear message instead of producing a Workflow that stalls.
topoSort(plan)
console.log('${PLAN_BEGIN}' + JSON.stringify(plan) + '${PLAN_END}')
`.trim()
}

/**
 * Extracts the plan from a runner's stdout.
 *
 * Sentinels are used rather than parsing the whole stream because the config may
 * legitimately print its own diagnostics, and `bun` writes install noise to the
 * same stream.
 *
 * Returns null when the repo has no config, which is not an error — it just has
 * no pipeline.
 */
export function parseEmittedPlan(stdout: string): Plan | null {
  const start = stdout.lastIndexOf(PLAN_BEGIN)
  if (start === -1) {
    throw new Error(
      `${CONFIG_PATH} did not emit a pipeline. Ensure it has a default export created with defineCI().`,
    )
  }
  const from = start + PLAN_BEGIN.length
  const end = stdout.indexOf(PLAN_END, from)
  if (end === -1) throw new Error('CI plan output was truncated')

  const payload = stdout.slice(from, end).trim()
  if (payload === 'null') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    throw new Error(`CI plan was not valid JSON: ${(error as Error).message}`)
  }

  const plan = parsed as Plan
  if (plan?.version !== 1 || !Array.isArray(plan.steps)) {
    throw new Error('CI plan has an unrecognized shape')
  }
  return plan
}

/** Runner logs arrive as either a string or a stream, depending on size. */
export async function readLog(log: string | ReadableStream<Uint8Array>): Promise<string> {
  if (typeof log === 'string') return log
  return new Response(log).text()
}
