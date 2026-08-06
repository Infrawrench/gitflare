import { describe, expect, it } from 'vitest'
import { decodePktLines, encodePktLine } from '~/server/git/pktline'
import { parseRefAdvertisement, resolveRefs } from '~/server/git/refs'

const encoder = new TextEncoder()

/** Concatenates pre-framed pkt-line chunks into one advertisement body. */
function body(...chunks: (string | Uint8Array)[]): Uint8Array {
  const parts = chunks.map((chunk) => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk))
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const SHA_MAIN = 'a'.repeat(40)
const SHA_DEV = 'b'.repeat(40)
const SHA_TAG_OBJECT = 'c'.repeat(40)
const SHA_TAG_COMMIT = 'd'.repeat(40)

describe('pkt-line framing', () => {
  it('round-trips a payload through its length prefix', () => {
    const framed = encodePktLine('hello\n')
    // 6 payload bytes + 4 header bytes = 0x000a
    expect(new TextDecoder().decode(framed)).toBe('000ahello\n')
    const [line] = decodePktLines(framed)
    expect(new TextDecoder().decode(line!.data!)).toBe('hello\n')
  })

  it('reports flush, delimiter, and response-end as special packets', () => {
    const lines = decodePktLines(encoder.encode('000000010002'))
    expect(lines.map((line) => line.special)).toEqual([0, 1, 2])
    expect(lines.every((line) => line.data === null)).toBe(true)
  })

  it('rejects a truncated packet rather than silently returning fewer refs', () => {
    // Claims 20 bytes but supplies 4. Returning a partial parse here would look
    // like a repo with fewer branches than it really has.
    expect(() => decodePktLines(encoder.encode('0018abcd'))).toThrow(/overruns the buffer/)
  })

  it('rejects a non-hex length prefix', () => {
    expect(() => decodePktLines(encoder.encode('zzzzpayload'))).toThrow(/invalid length prefix/)
  })

  it('refuses to frame a payload larger than a packet can describe', () => {
    expect(() => encodePktLine(new Uint8Array(65_532))).toThrow(/exceeds the 65516-byte maximum/)
  })
})

describe('ref advertisement', () => {
  it('parses refs, capabilities, and the HEAD symref', () => {
    const advertisement = parseRefAdvertisement(
      body(
        encodePktLine('# service=git-upload-pack\n'),
        '0000',
        encodePktLine(
          `${SHA_MAIN} refs/heads/main\0multi_ack ofs-delta symref=HEAD:refs/heads/main agent=git/2.45\n`,
        ),
        encodePktLine(`${SHA_DEV} refs/heads/dev\n`),
        '0000',
      ),
    )

    expect(advertisement.headRef).toBe('refs/heads/main')
    expect(advertisement.capabilities).toContain('ofs-delta')
    expect(advertisement.refs).toEqual([
      { name: 'refs/heads/main', sha: SHA_MAIN },
      { name: 'refs/heads/dev', sha: SHA_DEV },
    ])
  })

  it('collapses an annotated tag onto the commit it peels to', () => {
    // An annotated tag is advertised twice; the UI wants the commit, not the
    // intermediate tag object.
    const resolved = resolveRefs(
      parseRefAdvertisement(
        body(
          encodePktLine('# service=git-upload-pack\n'),
          '0000',
          encodePktLine(`${SHA_MAIN} refs/heads/main\0symref=HEAD:refs/heads/main\n`),
          encodePktLine(`${SHA_TAG_OBJECT} refs/tags/v1.0.0\n`),
          encodePktLine(`${SHA_TAG_COMMIT} refs/tags/v1.0.0^{}\n`),
          '0000',
        ),
      ),
    )

    expect(resolved.tags).toEqual([{ name: 'v1.0.0', sha: SHA_TAG_COMMIT }])
    expect(resolved.branches).toEqual([{ name: 'main', sha: SHA_MAIN }])
    expect(resolved.headBranch).toBe('main')
  })

  it('prefers the peeled SHA even when it is advertised first', () => {
    const resolved = resolveRefs(
      parseRefAdvertisement(
        body(
          encodePktLine('# service=git-upload-pack\n'),
          '0000',
          encodePktLine(`${SHA_TAG_COMMIT} refs/tags/v2^{}\0agent=git/2.45\n`),
          encodePktLine(`${SHA_TAG_OBJECT} refs/tags/v2\n`),
          '0000',
        ),
      ),
    )
    expect(resolved.tags).toEqual([{ name: 'v2', sha: SHA_TAG_COMMIT }])
  })

  it('treats an empty repo as having no refs', () => {
    // A repo with no commits advertises only a zero-SHA capability carrier.
    const resolved = resolveRefs(
      parseRefAdvertisement(
        body(
          encodePktLine('# service=git-upload-pack\n'),
          '0000',
          encodePktLine(`${'0'.repeat(40)} capabilities^{}\0multi_ack agent=git/2.45\n`),
          '0000',
        ),
      ),
    )
    expect(resolved.branches).toEqual([])
    expect(resolved.tags).toEqual([])
    expect(resolved.headBranch).toBeNull()
  })
})
