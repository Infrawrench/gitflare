import { ForgeError } from '../errors'

/**
 * OpenSSH public key parsing and fingerprinting.
 *
 * Keys are validated on the way in rather than stored verbatim. A malformed key
 * accepted here would sit in the table looking fine and fail at connection time,
 * long after the user could connect the two events.
 */

export interface ParsedSshKey {
  /** Algorithm name, e.g. "ssh-ed25519". */
  type: string
  /** Base64 key blob, without the type prefix or comment. */
  body: string
  comment: string
}

/**
 * Algorithms accepted, in the order most people should prefer them.
 *
 * DSA is excluded: it is limited to 1024-bit keys, and OpenSSH has disabled it
 * by default. `ssh-rsa` here names the key type, not the deprecated SHA-1
 * signature algorithm, which is negotiated separately.
 */
const ALLOWED_TYPES = new Set([
  'ssh-ed25519',
  'sk-ssh-ed25519@openssh.com',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-rsa',
])

export function parseSshPublicKey(input: string): ParsedSshKey {
  const trimmed = input.trim()
  if (trimmed === '') throw ForgeError.invalid('Public key is empty')

  // Checked before the multi-line test, because a private key is itself
  // multi-line — reporting "paste a single key" here would bury the one message
  // that should make someone rotate what they just leaked.
  if (/PRIVATE KEY/i.test(trimmed)) {
    throw ForgeError.invalid(
      'That looks like a private key. Paste the .pub file instead, and rotate this key — it has been exposed.',
    )
  }
  if (trimmed.includes('\n')) {
    throw ForgeError.invalid('Paste a single public key, not a file with several')
  }

  const [type, body, ...commentParts] = trimmed.split(/\s+/)
  if (!type || !body) throw ForgeError.invalid('Public key must be "<type> <base64> [comment]"')
  if (!ALLOWED_TYPES.has(type)) {
    throw ForgeError.invalid(`Unsupported key type "${type}"`)
  }

  const decoded = decodeBase64(body)
  if (!decoded) throw ForgeError.invalid('Public key body is not valid base64')

  // The blob's first field is the algorithm name; if it disagrees with the
  // prefix the key is malformed or has been tampered with.
  const embedded = readSshString(decoded, 0)
  if (!embedded || embedded.value !== type) {
    throw ForgeError.invalid('Public key body does not match its declared type')
  }

  return { type, body, comment: commentParts.join(' ') }
}

/**
 * SHA256 fingerprint in OpenSSH's format — base64, no padding, `SHA256:`
 * prefixed. Matches `ssh-keygen -lf` so users can compare by eye, and matches
 * what sshd hands to AuthorizedKeysCommand.
 */
export async function fingerprintSshKey(key: ParsedSshKey): Promise<string> {
  const blob = decodeBase64(key.body)
  if (!blob) throw ForgeError.invalid('Public key body is not valid base64')

  const digest = await crypto.subtle.digest('SHA-256', blob as BufferSource)
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return `SHA256:${btoa(binary).replace(/=+$/, '')}`
}

/** Reads a length-prefixed string from an SSH wire-format blob. */
function readSshString(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset + 4 > bytes.length) return null
  const length =
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  const start = offset + 4
  if (start + length > bytes.length) return null

  let value = ''
  for (let i = start; i < start + length; i++) value += String.fromCharCode(bytes[i]!)
  return { value, next: start + length }
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}
