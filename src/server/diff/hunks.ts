import { diffLines, splitLines, type Edit } from './myers'

/**
 * Groups an edit script into hunks — the `@@ -a,b +c,d @@` sections git shows.
 *
 * A hunk is a run of changes plus a few lines of context either side. Runs whose
 * context windows touch are merged, otherwise a function with two nearby edits
 * would render as two hunks with a duplicated line between them.
 */

export type LineKind = 'context' | 'add' | 'delete'

export interface DiffLine {
  kind: LineKind
  content: string
  /** 1-based line number on the old side; 0 where the line does not exist there. */
  oldLine: number
  /** 1-based line number on the new side; 0 where the line does not exist there. */
  newLine: number
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The `@@ … @@` header git would print. */
  header: string
  lines: DiffLine[]
}

export interface FileDiffResult {
  hunks: Hunk[]
  additions: number
  deletions: number
}

export const DEFAULT_CONTEXT = 3

export function diffText(
  oldText: string,
  newText: string,
  contextLines = DEFAULT_CONTEXT,
): FileDiffResult {
  return buildHunks(diffLines(splitLines(oldText), splitLines(newText)), splitLines(oldText), splitLines(newText), contextLines)
}

function buildHunks(
  edits: Edit[],
  oldLines: string[],
  newLines: string[],
  contextLines: number,
): FileDiffResult {
  let additions = 0
  let deletions = 0
  for (const edit of edits) {
    if (edit.op === 'insert') additions++
    else if (edit.op === 'delete') deletions++
  }

  if (additions === 0 && deletions === 0) {
    return { hunks: [], additions: 0, deletions: 0 }
  }

  // Indices of every changed edit, used to decide which context to keep.
  const changed: number[] = []
  edits.forEach((edit, index) => {
    if (edit.op !== 'equal') changed.push(index)
  })

  // Merge change runs whose context windows overlap or abut.
  const ranges: { start: number; end: number }[] = []
  for (const index of changed) {
    const start = Math.max(0, index - contextLines)
    const end = Math.min(edits.length - 1, index + contextLines)
    const last = ranges.at(-1)
    // `<= last.end + 1` rather than `<= last.end`: adjacent windows share no
    // line but would still render as two hunks split mid-context.
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      ranges.push({ start, end })
    }
  }

  const hunks = ranges.map((range) => {
    const lines: DiffLine[] = []
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0

    for (let i = range.start; i <= range.end; i++) {
      const edit = edits[i]!
      const oldLine = edit.oldIndex >= 0 ? edit.oldIndex + 1 : 0
      const newLine = edit.newIndex >= 0 ? edit.newIndex + 1 : 0

      if (oldStart === 0 && oldLine > 0) oldStart = oldLine
      if (newStart === 0 && newLine > 0) newStart = newLine

      if (edit.op === 'equal') {
        lines.push({ kind: 'context', content: oldLines[edit.oldIndex]!, oldLine, newLine })
        oldCount++
        newCount++
      } else if (edit.op === 'delete') {
        lines.push({ kind: 'delete', content: oldLines[edit.oldIndex]!, oldLine, newLine: 0 })
        oldCount++
      } else {
        lines.push({ kind: 'add', content: newLines[edit.newIndex]!, oldLine: 0, newLine })
        newCount++
      }
    }

    // A hunk that only adds lines has no old-side position of its own; git
    // reports the line it was inserted after, which is 0 for a new file.
    if (oldStart === 0) oldStart = oldCount === 0 ? 0 : 1
    if (newStart === 0) newStart = newCount === 0 ? 0 : 1

    return {
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      lines,
    }
  })

  return { hunks, additions, deletions }
}

/** Renders hunks as unified diff text, for `.patch` endpoints and copy-paste. */
export function toUnifiedDiff(path: string, previousPath: string | null, result: FileDiffResult): string {
  if (result.hunks.length === 0) return ''

  const from = previousPath ?? path
  const out = [`--- a/${from}`, `+++ b/${path}`]

  for (const hunk of result.hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'delete' ? '-' : ' '
      out.push(prefix + line.content)
    }
  }

  return `${out.join('\n')}\n`
}
