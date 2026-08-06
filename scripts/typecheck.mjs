#!/usr/bin/env node
/**
 * Typecheck gate.
 *
 * `@cloudflare/ci` publishes its `src/*.ts` instead of built declarations, so
 * tsc pulls the dependency's source into our program and reports its diagnostics
 * as if they were ours. `skipLibCheck` does not help — it only covers `.d.ts`.
 *
 * Rather than relaxing our own compiler options to accommodate someone else's
 * code (which is what `exactOptionalPropertyTypes: false` already cost us), this
 * runs tsc normally and fails only on diagnostics in files we actually own.
 * Dependency diagnostics are counted and summarized so they stay visible.
 */

import { spawnSync } from 'node:child_process'

const result = spawnSync(
  'node',
  ['./node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'],
  { encoding: 'utf8' },
)

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
const lines = output.split('\n').filter((line) => line.trim() !== '')

const isDependency = (line) => line.startsWith('node_modules/') || line.includes('/node_modules/')
// Continuation lines are indented and belong to whichever diagnostic preceded them.
const diagnostics = []
for (const line of lines) {
  if (/^\s/.test(line) && diagnostics.length > 0) {
    diagnostics[diagnostics.length - 1].lines.push(line)
  } else {
    diagnostics.push({ head: line, lines: [line], dependency: isDependency(line) })
  }
}

const ours = diagnostics.filter((d) => !d.dependency)
const theirs = diagnostics.filter((d) => d.dependency)

for (const diagnostic of ours) console.log(diagnostic.lines.join('\n'))

if (theirs.length > 0) {
  const files = [...new Set(theirs.map((d) => d.head.split('(')[0]))]
  console.log(
    `\n${theirs.length} diagnostic(s) ignored in dependency source we cannot edit ` +
      `(${files.length} file(s), e.g. ${files[0]}).`,
  )
}

if (ours.length > 0) {
  console.error(`\n${ours.length} type error(s).`)
  process.exit(1)
}

console.log(`No type errors in project sources.`)
