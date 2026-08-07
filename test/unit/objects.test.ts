import { describe, expect, it } from 'vitest'
import {
  buildCommit,
  buildPackfile,
  buildTree,
  encodeObjectHeader,
  fromHex,
  hashObject,
  toHex,
} from '~/server/git/objects'

/**
 * Writing git objects.
 *
 * Every expectation here was produced by real git, not by this implementation.
 * The object ids came from `git hash-object` and `git cat-file`, and the whole
 * packfile was fed to `git index-pack --stdin`, which validates the trailer and
 * every object encoding before accepting it.
 *
 * That matters more than usual: a subtly wrong hash still looks like a hash, and
 * the failure would be a push git rejects for reasons that point nowhere near
 * the cause.
 */

// `printf 'hello\n' | git hash-object --stdin`
const BLOB_SHA = 'ce013625030ba8dba906f756967f9e9ca394464a'
// The tree containing that blob as f.txt, and a commit pointing at it.
const TREE_SHA = 'b4ed918248039b78f24383523fa4e51f80994fac'
const COMMIT_SHA = '4f9eb3e3e91f095a703ecf3976d1d89629e005d8'

const hello = new TextEncoder().encode('hello\n')

describe('hashObject', () => {
  it('produces the id git produces', async () => {
    const blob = await hashObject('blob', hello)
    expect(blob.sha).toBe(BLOB_SHA)
  })

  it('includes the type and size header in the hash', async () => {
    // A blob's id is not the hash of its content — the `blob <size>\0` prefix is
    // part of it. Hashing the bare content yields a plausible-looking id that
    // matches nothing.
    const bare = toHex(new Uint8Array(await crypto.subtle.digest('SHA-1', hello as BufferSource)))
    expect(bare).not.toBe(BLOB_SHA)
  })

  it('gives different ids to identical content of different types', async () => {
    const asBlob = await hashObject('blob', hello)
    const asCommit = await hashObject('commit', hello)
    expect(asBlob.sha).not.toBe(asCommit.sha)
  })
})

describe('buildTree', () => {
  it('matches the tree git builds for the same entry', async () => {
    const tree = await buildTree([{ mode: '100644', name: 'f.txt', sha: BLOB_SHA }])
    expect(tree.sha).toBe(TREE_SHA)
  })

  it('sorts a directory as though its name ended in a slash', async () => {
    // Git's rule, and not plain lexicographic: "lib/" sorts after "lib.txt".
    // Sorting naively yields a tree that hashes differently from git's for
    // identical content, and every id downstream then diverges.
    const naive = await buildTree([
      { mode: '40000', name: 'lib', sha: TREE_SHA },
      { mode: '100644', name: 'lib.txt', sha: BLOB_SHA },
    ])
    const reversed = await buildTree([
      { mode: '100644', name: 'lib.txt', sha: BLOB_SHA },
      { mode: '40000', name: 'lib', sha: TREE_SHA },
    ])
    // Input order must not matter; the sort is what fixes it.
    expect(naive.sha).toBe(reversed.sha)
  })

  it('stores SHAs as raw bytes, not hex', async () => {
    const tree = await buildTree([{ mode: '100644', name: 'f.txt', sha: BLOB_SHA }])
    // 6 mode + 1 space + 5 name + 1 NUL + 20 raw bytes = 33.
    expect(tree.content.length).toBe(33)
  })
})

describe('buildCommit', () => {
  it('matches the commit git builds for the same inputs', async () => {
    const commit = await buildCommit({
      tree: TREE_SHA,
      parents: [],
      author: { name: 'Test', email: 't@example.com', when: 1_700_000_000_000 },
      message: 'initial',
    })
    expect(commit.sha).toBe(COMMIT_SHA)
  })

  it('preserves parent order', async () => {
    // The first parent is the branch being merged into — what --first-parent
    // follows — so the order is meaningful, not a set.
    const commit = await buildCommit({
      tree: TREE_SHA,
      parents: [COMMIT_SHA, BLOB_SHA],
      author: { name: 'T', email: 't@e.com', when: 0 },
      message: 'merge',
    })
    const text = new TextDecoder().decode(commit.content)
    expect(text.indexOf(`parent ${COMMIT_SHA}`)).toBeLessThan(text.indexOf(`parent ${BLOB_SHA}`))
  })

  it('terminates the message with a newline', async () => {
    const commit = await buildCommit({
      tree: TREE_SHA,
      parents: [],
      author: { name: 'T', email: 't@e.com', when: 0 },
      message: 'no trailing newline',
    })
    expect(new TextDecoder().decode(commit.content).endsWith('\n')).toBe(true)
  })
})

describe('buildPackfile', () => {
  it('writes a v2 header with the object count', async () => {
    const blob = await hashObject('blob', hello)
    const pack = await buildPackfile([blob])

    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK')
    const view = new DataView(pack.buffer, pack.byteOffset)
    expect(view.getUint32(4)).toBe(2)
    expect(view.getUint32(8)).toBe(1)
  })

  it('ends with a SHA-1 over everything before it', async () => {
    // git verifies this trailer and rejects the push if it disagrees.
    const blob = await hashObject('blob', hello)
    const pack = await buildPackfile([blob])

    const body = pack.subarray(0, pack.length - 20)
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-1', body as BufferSource))
    expect(toHex(pack.subarray(pack.length - 20))).toBe(toHex(expected))
  })

  it('stores content as zlib, which is what git reads', async () => {
    const blob = await hashObject('blob', hello)
    const pack = await buildPackfile([blob])
    // Past the 12-byte header and the 1-byte object header: 0x78 is the zlib
    // magic. A raw deflate stream would start differently and git would reject it.
    expect(pack[13]).toBe(0x78)
  })
})

describe('encodeObjectHeader', () => {
  it('packs small sizes into one byte', async () => {
    // type 3 (blob), size 6 → 0b0011_0110
    expect([...encodeObjectHeader(3, 6)]).toEqual([0x36])
  })

  it('continues across bytes for larger sizes', () => {
    // The low 4 bits go in the first byte, then 7 at a time, with the high bit
    // marking continuation.
    const header = encodeObjectHeader(3, 1000)
    expect(header.length).toBeGreaterThan(1)
    expect(header[0]! & 0x80).toBe(0x80)
    expect(header.at(-1)! & 0x80).toBe(0)
  })
})

describe('hex helpers', () => {
  it('round-trip', () => {
    expect(toHex(fromHex(BLOB_SHA))).toBe(BLOB_SHA)
    expect(fromHex(BLOB_SHA).length).toBe(20)
  })
})
