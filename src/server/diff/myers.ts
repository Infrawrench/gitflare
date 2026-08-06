/**
 * Line diffing.
 *
 * Implements Myers' O(ND) algorithm — the same one git uses by default — so the
 * hunks shown here match what a contributor sees in `git diff`. A cheaper
 * heuristic would disagree with git on exactly the ambiguous cases (moved
 * blocks, repeated lines) where reviewers are most likely to notice.
 *
 * This is the "record a trace, then backtrack" form from section 2b of the
 * paper, rather than the linear-space middle-snake variant. The middle-snake
 * version halves memory, but its recursion only terminates if every split
 * strictly shrinks the problem — a condition that is easy to get subtly wrong
 * and fails as unbounded recursion rather than a wrong answer. Since input is
 * already capped at MAX_DIFF_LINES and the common prefix and suffix are trimmed
 * before the search starts, the trace stays small for real files, and the
 * straightforwardly correct version is the better trade.
 */

export type Op = 'equal' | 'insert' | 'delete'

export interface Edit {
  op: Op
  /** Index into the old array; -1 for an insert. */
  oldIndex: number
  /** Index into the new array; -1 for a delete. */
  newIndex: number
}

/**
 * Beyond this many lines, diffing is abandoned rather than risking the isolate's
 * CPU budget. Myers is O(ND) — fine for ordinary source files, quadratic for a
 * large generated file that was rewritten wholesale.
 */
export const MAX_DIFF_LINES = 20_000

export class DiffTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiffTooLargeError'
  }
}

export function diffLines(oldLines: string[], newLines: string[]): Edit[] {
  const total = oldLines.length + newLines.length
  if (total > MAX_DIFF_LINES * 2) {
    throw new DiffTooLargeError(`File pair has ${total} lines, above the diff limit`)
  }

  // Trim the common prefix and suffix first. Most edits touch a small part of a
  // file, so this usually reduces the search to a few dozen lines and keeps the
  // recorded trace correspondingly small.
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const edits: Edit[] = []
  for (let i = 0; i < prefix; i++) {
    edits.push({ op: 'equal', oldIndex: i, newIndex: i })
  }

  edits.push(
    ...diffCore(
      oldLines.slice(prefix, oldLines.length - suffix),
      newLines.slice(prefix, newLines.length - suffix),
      prefix,
    ),
  )

  for (let i = 0; i < suffix; i++) {
    edits.push({
      op: 'equal',
      oldIndex: oldLines.length - suffix + i,
      newIndex: newLines.length - suffix + i,
    })
  }

  return edits
}

/**
 * Myers on the trimmed middle. `offset` maps local indices back to the caller's
 * coordinates so callers never see the trimming.
 */
function diffCore(a: string[], b: string[], offset: number): Edit[] {
  const n = a.length
  const m = b.length

  if (n === 0 && m === 0) return []
  if (n === 0) {
    return b.map((_, i) => ({ op: 'insert' as const, oldIndex: -1, newIndex: offset + i }))
  }
  if (m === 0) {
    return a.map((_, i) => ({ op: 'delete' as const, oldIndex: offset + i, newIndex: -1 }))
  }

  const max = n + m
  const size = 2 * max + 1
  const v = new Int32Array(size)
  // One snapshot of the frontier per edit distance; backtracking walks these in
  // reverse to recover the path.
  const trace: Int32Array[] = []

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())

    for (let k = -d; k <= d; k += 2) {
      const index = k + max
      // Move down (an insertion) when there is no leftward path to extend, or
      // when the downward one has advanced further.
      const down = k === -d || (k !== d && v[index - 1]! < v[index + 1]!)
      let x = down ? v[index + 1]! : v[index - 1]! + 1
      let y = x - k

      // Follow the diagonal: consecutive identical lines cost nothing.
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[index] = x

      if (x >= n && y >= m) {
        return backtrack(trace, a, b, n, m, max, offset)
      }
    }
  }

  // Unreachable: a path is always found by d = n + m.
  throw new DiffTooLargeError('Diff did not converge')
}

/**
 * Walks the recorded frontiers backwards from (n, m) to the origin, emitting
 * edits in reverse and then flipping them.
 */
function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  n: number,
  m: number,
  max: number,
  offset: number,
): Edit[] {
  const edits: Edit[] = []
  let x = n
  let y = m

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const v = trace[d]!
    const k = x - y
    const index = k + max

    const down = k === -d || (k !== d && v[index - 1]! < v[index + 1]!)
    const previousK = down ? k + 1 : k - 1
    const previousX = v[previousK + max]!
    const previousY = previousX - previousK

    // The diagonal run between the previous frontier point and here is unchanged.
    while (x > previousX && y > previousY) {
      x--
      y--
      edits.push({ op: 'equal', oldIndex: offset + x, newIndex: offset + y })
    }

    if (d === 0) break

    if (down) {
      y--
      edits.push({ op: 'insert', oldIndex: -1, newIndex: offset + y })
    } else {
      x--
      edits.push({ op: 'delete', oldIndex: offset + x, newIndex: -1 })
    }
  }

  return edits.reverse()
}

/** Splits text into lines, dropping the trailing empty element a final newline creates. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}
