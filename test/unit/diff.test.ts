import { describe, expect, it } from 'vitest'
import { DiffTooLargeError, diffLines, splitLines } from '~/server/diff/myers'
import { diffText, toUnifiedDiff } from '~/server/diff/hunks'

/** Compact rendering of an edit script, for readable assertions. */
function script(oldText: string, newText: string): string {
  return diffLines(splitLines(oldText), splitLines(newText))
    .map((edit) => (edit.op === 'equal' ? '=' : edit.op === 'insert' ? '+' : '-'))
    .join('')
}

describe('splitLines', () => {
  it('drops the empty element a trailing newline creates', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLines('a\nb')).toEqual(['a', 'b'])
  })

  it('treats empty text as no lines, not one empty line', () => {
    expect(splitLines('')).toEqual([])
  })

  it('keeps interior blank lines', () => {
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b'])
  })
})

describe('diffLines', () => {
  it('reports no changes for identical input', () => {
    expect(script('a\nb\nc\n', 'a\nb\nc\n')).toBe('===')
  })

  it('handles a pure insertion', () => {
    expect(script('a\nc\n', 'a\nb\nc\n')).toBe('=+=')
  })

  it('handles a pure deletion', () => {
    expect(script('a\nb\nc\n', 'a\nc\n')).toBe('=-=')
  })

  it('handles a replacement', () => {
    // A changed line is a delete plus an insert, in that order.
    expect(script('a\nb\nc\n', 'a\nX\nc\n')).toBe('=-+=')
  })

  it('handles an empty original', () => {
    expect(script('', 'a\nb\n')).toBe('++')
  })

  it('handles an emptied file', () => {
    expect(script('a\nb\n', '')).toBe('--')
  })

  it('finds the minimal script when lines repeat', () => {
    // Repeated lines are where a naive diff goes wrong, inventing changes that
    // are not there. Myers must still find a 1-edit answer.
    const edits = diffLines(splitLines('a\na\na\n'), splitLines('a\na\na\na\n'))
    expect(edits.filter((edit) => edit.op !== 'equal')).toHaveLength(1)
    expect(edits.filter((edit) => edit.op === 'equal')).toHaveLength(3)
  })

  it('produces line indices that address the right content', () => {
    const oldLines = splitLines('keep\nremove\n')
    const newLines = splitLines('keep\nadd\n')
    for (const edit of diffLines(oldLines, newLines)) {
      if (edit.op === 'delete') expect(oldLines[edit.oldIndex]).toBe('remove')
      if (edit.op === 'insert') expect(newLines[edit.newIndex]).toBe('add')
    }
  })

  it('refuses input above the size limit instead of burning CPU', () => {
    // Myers is O(ND); a huge rewritten file would otherwise stall the isolate.
    const huge = Array.from({ length: 30_000 }, (_, i) => `line ${i}`)
    expect(() => diffLines(huge, huge.map((line) => `${line}!`))).toThrow(DiffTooLargeError)
  })
})

describe('diffText hunks', () => {
  const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')

  it('emits no hunks when nothing changed', () => {
    const result = diffText(original, original)
    expect(result.hunks).toEqual([])
    expect(result.additions).toBe(0)
    expect(result.deletions).toBe(0)
  })

  it('surrounds a change with context and reports counts', () => {
    const changed = original.replace('line 10', 'LINE TEN')
    const result = diffText(changed === original ? original : original, changed)

    expect(result.additions).toBe(1)
    expect(result.deletions).toBe(1)
    expect(result.hunks).toHaveLength(1)

    const hunk = result.hunks[0]!
    // 3 lines of context either side of a one-line replacement.
    expect(hunk.lines.filter((line) => line.kind === 'context')).toHaveLength(6)
    expect(hunk.header).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/)
  })

  it('merges nearby changes into one hunk', () => {
    // Two edits four lines apart: their context windows touch, so splitting them
    // would duplicate the lines between.
    const changed = original.replace('line 10', 'X').replace('line 14', 'Y')
    const result = diffText(original, changed)
    expect(result.hunks).toHaveLength(1)
  })

  it('keeps distant changes in separate hunks', () => {
    const changed = original.replace('line 2', 'X').replace('line 19', 'Y')
    const result = diffText(original, changed)
    expect(result.hunks).toHaveLength(2)
  })

  it('numbers lines so each side addresses its own file', () => {
    const result = diffText('a\nb\nc\n', 'a\nB\nc\n')
    const lines = result.hunks[0]!.lines

    const deleted = lines.find((line) => line.kind === 'delete')!
    const added = lines.find((line) => line.kind === 'add')!
    // A deleted line has no position in the new file, and vice versa.
    expect(deleted.oldLine).toBe(2)
    expect(deleted.newLine).toBe(0)
    expect(added.oldLine).toBe(0)
    expect(added.newLine).toBe(2)
  })

  it('respects a custom context width', () => {
    const changed = original.replace('line 10', 'X')
    const narrow = diffText(original, changed, 1)
    expect(narrow.hunks[0]!.lines.filter((line) => line.kind === 'context')).toHaveLength(2)
  })

  it('treats a new file as all additions', () => {
    const result = diffText('', 'a\nb\n')
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(0)
    expect(result.hunks[0]!.lines.every((line) => line.kind === 'add')).toBe(true)
  })
})

describe('toUnifiedDiff', () => {
  it('renders patch text git would accept', () => {
    const patch = toUnifiedDiff('src/a.ts', null, diffText('a\nb\nc\n', 'a\nB\nc\n'))
    expect(patch).toContain('--- a/src/a.ts')
    expect(patch).toContain('+++ b/src/a.ts')
    expect(patch).toContain('-b')
    expect(patch).toContain('+B')
    expect(patch).toContain(' a')
    expect(patch.endsWith('\n')).toBe(true)
  })

  it('names the old path for a rename', () => {
    const patch = toUnifiedDiff('new.ts', 'old.ts', diffText('a\n', 'b\n'))
    expect(patch).toContain('--- a/old.ts')
    expect(patch).toContain('+++ b/new.ts')
  })

  it('renders nothing when there is no change', () => {
    expect(toUnifiedDiff('a.ts', null, diffText('a\n', 'a\n'))).toBe('')
  })
})
