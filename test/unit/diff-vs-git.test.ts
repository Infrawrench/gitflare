import { describe, expect, it } from 'vitest'
import { diffText, toUnifiedDiff } from '~/server/diff/hunks'

/**
 * Agreement with real git.
 *
 * The whole reason for implementing Myers rather than a cheaper heuristic is
 * that the hunks a reviewer sees here should match what they see locally. These
 * expectations are the verbatim output of `git diff --unified=3` on the same
 * inputs, captured from a real repository — not what this implementation
 * happens to produce.
 */

const BEFORE = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf\nhotel\nindia\njuliet\n'
const AFTER = 'alpha\nBRAVO\ncharlie\ndelta\necho\nfoxtrot\nNEWLINE\ngolf\nhotel\njuliet\n'

// git diff --unified=3, body only (headers stripped).
const GIT_OUTPUT = `@@ -1,10 +1,10 @@
 alpha
-bravo
+BRAVO
 charlie
 delta
 echo
 foxtrot
+NEWLINE
 golf
 hotel
-india
 juliet`

function bodyOf(patch: string): string {
  // Drop the ---/+++ header lines; git's own output was captured the same way.
  return patch
    .split('\n')
    .filter((line) => !line.startsWith('---') && !line.startsWith('+++'))
    .join('\n')
    .trimEnd()
}

describe('agreement with git diff', () => {
  it('reproduces git’s hunk for a mixed edit, replacement, insertion, and deletion', () => {
    const patch = toUnifiedDiff('f.txt', null, diffText(BEFORE, AFTER))
    expect(bodyOf(patch)).toBe(GIT_OUTPUT)
  })

  it('matches git’s header arithmetic', () => {
    const result = diffText(BEFORE, AFTER)
    expect(result.hunks).toHaveLength(1)
    // Both sides are 10 lines: one replaced, one added, one removed.
    expect(result.hunks[0]!.header).toBe('@@ -1,10 +1,10 @@')
    expect(result.additions).toBe(2)
    expect(result.deletions).toBe(2)
  })

  it('orders a replacement as delete-then-insert, like git', () => {
    const patch = toUnifiedDiff('f.txt', null, diffText(BEFORE, AFTER))
    const lines = patch.split('\n')
    expect(lines.indexOf('-bravo')).toBeLessThan(lines.indexOf('+BRAVO'))
  })
})
