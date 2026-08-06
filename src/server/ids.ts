/**
 * Lexicographically sortable IDs: 10 characters of millisecond timestamp in
 * Crockford base32, then 16 characters of randomness (ULID layout).
 *
 * Sorting by ID therefore sorts by creation time, which lets pagination use a
 * plain `WHERE id < ?` cursor without a secondary index on created_at.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

function encodeTime(now: number): string {
  let out = ''
  let value = now
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    out = ALPHABET[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_CHARS)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) {
    // 256 is not a multiple of 32, but the low 5 bits of a uniform byte are
    // themselves uniform, so masking introduces no bias.
    out += ALPHABET[byte & 0x1f]
  }
  return out
}

export function newId(now = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/** Milliseconds encoded in an ID, or null if it is not one of ours. */
export function idTime(id: string): number | null {
  if (id.length !== TIME_CHARS + RANDOM_CHARS) return null
  let value = 0
  for (let i = 0; i < TIME_CHARS; i++) {
    const index = ALPHABET.indexOf(id[i]!)
    if (index < 0) return null
    value = value * 32 + index
  }
  return value
}
