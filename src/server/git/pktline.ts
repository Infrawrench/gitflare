/**
 * pkt-line framing, the length-prefixed envelope every git smart-HTTP payload
 * uses.
 *
 * A packet is four hex digits giving the total length *including* those four
 * bytes, followed by the payload. Three lengths are special and carry no
 * payload: "0000" flush, "0001" delimiter (protocol v2), "0002" response-end.
 *
 * We need this because neither the Artifacts binding nor its REST API exposes a
 * ref listing. The git protocol does — `GET /info/refs?service=git-upload-pack`
 * returns every branch and tag with its SHA — so refs are read by speaking git
 * to the Artifacts remote and parsing the advertisement here.
 */

export const FLUSH = '0000'

export interface PktLine {
  /** Payload bytes, or null for a flush/delimiter/response-end packet. */
  data: Uint8Array | null
  /** The special packet's length code, when `data` is null. */
  special?: 0 | 1 | 2
}

/**
 * Splits a complete pkt-line stream into packets.
 *
 * Throws on a malformed length prefix or a packet that runs past the end of the
 * buffer, rather than returning a partial parse — a truncated advertisement
 * would otherwise look like a repo that simply has fewer branches.
 */
export function decodePktLines(buffer: Uint8Array): PktLine[] {
  const lines: PktLine[] = []
  let offset = 0

  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) {
      throw new Error(`pkt-line: truncated length prefix at byte ${offset}`)
    }
    const header = latin1(buffer.subarray(offset, offset + 4))
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      throw new Error(`pkt-line: invalid length prefix ${JSON.stringify(header)} at byte ${offset}`)
    }
    const length = Number.parseInt(header, 16)
    offset += 4

    if (length === 0 || length === 1 || length === 2) {
      lines.push({ data: null, special: length as 0 | 1 | 2 })
      continue
    }
    if (length < 4) {
      throw new Error(`pkt-line: length ${length} is below the 4-byte header at byte ${offset - 4}`)
    }
    const payloadLength = length - 4
    if (offset + payloadLength > buffer.length) {
      throw new Error(`pkt-line: packet of ${payloadLength} bytes overruns the buffer`)
    }
    lines.push({ data: buffer.subarray(offset, offset + payloadLength) })
    offset += payloadLength
  }

  return lines
}

/** Frames a payload as a pkt-line. */
export function encodePktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  const length = bytes.length + 4
  if (length > 0xffff) {
    throw new Error(`pkt-line: payload of ${bytes.length} bytes exceeds the 65516-byte maximum`)
  }
  const out = new Uint8Array(length)
  out.set(new TextEncoder().encode(length.toString(16).padStart(4, '0')), 0)
  out.set(bytes, 4)
  return out
}

export function encodeFlush(): Uint8Array {
  return new TextEncoder().encode(FLUSH)
}

/**
 * Decodes as latin1 so each byte maps to exactly one character. Ref names are
 * conventionally UTF-8 but git does not require it, and a lossy UTF-8 decode
 * would corrupt an unusual name rather than round-trip it.
 */
function latin1(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

export { latin1 as decodeLatin1 }
