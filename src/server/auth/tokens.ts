/**
 * Personal access tokens and session cookies.
 *
 * Both are high-entropy random strings that we generate, so they are hashed with
 * a single SHA-256 rather than a password KDF. Stretching exists to slow down
 * guessing a low-entropy human-chosen secret; against 256 bits of CSPRNG output
 * it buys nothing and would only add latency to every git request.
 *
 * Only the hash is stored. A database leak therefore yields nothing replayable.
 */

const PAT_PREFIX = 'gitflare_pat_'
const SESSION_BYTES = 32
const PAT_BYTES = 32

export interface GeneratedToken {
  /** Returned to the user exactly once. */
  plaintext: string
  hash: string
  /** Leading characters, stored so the UI can distinguish tokens. */
  prefix: string
}

export async function generatePat(): Promise<GeneratedToken> {
  const plaintext = PAT_PREFIX + randomBase64Url(PAT_BYTES)
  return {
    plaintext,
    hash: await hashToken(plaintext),
    prefix: plaintext.slice(0, PAT_PREFIX.length + 8),
  }
}

export async function generateSessionToken(): Promise<{ plaintext: string; hash: string }> {
  const plaintext = randomBase64Url(SESSION_BYTES)
  return { plaintext, hash: await hashToken(plaintext) }
}

export async function hashToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext))
  return toHex(new Uint8Array(digest))
}

export function looksLikePat(value: string): boolean {
  return value.startsWith(PAT_PREFIX)
}

/**
 * Constant-time string comparison.
 *
 * Lookups are by hash so the database index does the matching, but anywhere a
 * secret is compared in application code this is used instead of `===` to avoid
 * leaking a prefix through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Parses an HTTP Basic credential.
 *
 * Git sends the PAT as the password and ignores the username, so any username
 * is accepted. Returns null rather than throwing on malformed input, since a
 * missing or broken header is an ordinary unauthenticated request.
 */
export function parseBasicAuth(header: string | null): { username: string; password: string } | null {
  if (!header?.toLowerCase().startsWith('basic ')) return null
  let decoded: string
  try {
    decoded = atob(header.slice(6).trim())
  } catch {
    return null
  }
  const separator = decoded.indexOf(':')
  if (separator === -1) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

/** Extracts a bearer token from an Authorization header. */
export function parseBearer(header: string | null): string | null {
  if (!header?.toLowerCase().startsWith('bearer ')) return null
  const value = header.slice(7).trim()
  return value === '' ? null : value
}
