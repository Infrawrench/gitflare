import { describe, expect, it } from 'vitest'
import {
  buildReceivePackRequest,
  canFastForward,
  emptyPackfile,
  parseReceivePackResponse,
  ZERO_SHA,
} from '~/server/git/receive-pack'
import { decodePktLines, encodePktLine } from '~/server/git/pktline'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

function body(...chunks: string[]): Uint8Array {
  const parts = chunks.map((chunk) => encodePktLine(chunk))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Verbatim output of `printf '' | git pack-objects --stdout`, captured from a
 * real repository. If our pack does not match this exactly, git will reject the
 * push — the trailer is a checksum it verifies.
 */
const GIT_EMPTY_PACK = '5041434b0000000200000000029d08823bd8a8eab510ad6ac75c823cfd3ed31e'

describe('emptyPackfile', () => {
  it('matches the empty pack real git produces, byte for byte', async () => {
    const pack = await emptyPackfile()
    const hex = [...pack].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    expect(hex).toBe(GIT_EMPTY_PACK)
  })

  it('is a valid v2 pack header with zero objects and a real checksum', async () => {
    const pack = await emptyPackfile()
    expect(pack).toHaveLength(32)

    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK')
    const view = new DataView(pack.buffer, pack.byteOffset)
    expect(view.getUint32(4)).toBe(2)
    expect(view.getUint32(8)).toBe(0)

    // The trailer must be the SHA-1 of the header, not padding — git verifies it.
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-1', pack.subarray(0, 12) as BufferSource),
    )
    expect([...pack.subarray(12)]).toEqual([...expected])
  })
})

describe('buildReceivePackRequest', () => {
  it('frames one update command, a flush, and the empty pack', async () => {
    const request = await buildReceivePackRequest({
      ref: 'refs/heads/main',
      oldSha: A,
      newSha: B,
    })

    // The pack is the trailing 32 bytes; everything before it is pkt-line.
    const packStart = request.length - 32
    expect(new TextDecoder().decode(request.subarray(packStart, packStart + 4))).toBe('PACK')

    const lines = decodePktLines(request.subarray(0, packStart))
    const command = new TextDecoder().decode(lines[0]!.data!)
    expect(command).toBe(`${A} ${B} refs/heads/main\0report-status\n`)
    // A flush must separate the commands from the pack.
    expect(lines[1]!.data).toBeNull()
  })

  it('sends the expected old SHA so a concurrent push is not clobbered', async () => {
    // This compare-and-swap is the only thing stopping a merge from overwriting
    // a commit that landed while the pull request page was open.
    const request = await buildReceivePackRequest({ ref: 'refs/heads/main', oldSha: A, newSha: B })
    const command = new TextDecoder().decode(
      decodePktLines(request.subarray(0, request.length - 32))[0]!.data!,
    )
    expect(command.startsWith(A)).toBe(true)
  })
})

describe('parseReceivePackResponse', () => {
  it('accepts a successful report', () => {
    expect(parseReceivePackResponse(body('unpack ok\n', 'ok refs/heads/main\n'))).toEqual({ ok: true })
  })

  it('reports a rejected ref update', () => {
    // The transport succeeded and HTTP was 200; the update still failed.
    const result = parseReceivePackResponse(
      body('unpack ok\n', 'ng refs/heads/main non-fast-forward\n'),
    )
    expect(result.ok).toBe(false)
    expect(result.error).toBe('non-fast-forward')
  })

  it('reports an unpack failure', () => {
    const result = parseReceivePackResponse(body('unpack index-pack failed\n'))
    expect(result.ok).toBe(false)
    expect(result.error).toBe('index-pack failed')
  })

  it('refuses to call a report with no ref status a success', () => {
    // Silence is not consent: without a per-ref line nothing confirms the move.
    const result = parseReceivePackResponse(body('unpack ok\n'))
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not confirm/)
  })

  it('refuses an empty report', () => {
    expect(parseReceivePackResponse(new Uint8Array(0)).ok).toBe(false)
  })
})

describe('canFastForward', () => {
  it('is true when base is an ancestor of head', () => {
    expect(canFastForward(A, B, [B, 'c'.repeat(40), A])).toBe(true)
  })

  it('is false when the branches have diverged', () => {
    // Base is not in head's history, so merging would need a new commit object —
    // which cannot be created through the Artifacts API.
    expect(canFastForward(A, B, [B, 'c'.repeat(40)])).toBe(false)
  })

  it('is false when there is nothing to merge', () => {
    expect(canFastForward(A, A, [A])).toBe(false)
  })

  it('is true when creating the branch', () => {
    expect(canFastForward(ZERO_SHA, B, [])).toBe(true)
  })
})
