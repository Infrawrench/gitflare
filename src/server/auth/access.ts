/**
 * Cloudflare Access JWT verification.
 *
 * Access terminates authentication at the edge and forwards a signed assertion
 * in the `Cf-Access-Jwt-Assertion` header. Trusting that header without checking
 * the signature would be an open door: anyone who can reach the origin directly
 * could set it themselves. So the token is verified in full here — signature,
 * issuer, audience, and expiry — before any identity is derived from it.
 *
 * Access applications require a zone you own; they cannot be attached to a
 * workers.dev subdomain. When ACCESS_TEAM_DOMAIN or ACCESS_AUD is unset the
 * caller falls back to local dev sessions instead (see session.ts).
 */

export interface AccessIdentity {
  /** Stable per-user subject claim. Stored as `users.access_sub`. */
  sub: string
  email: string
  /** Present for service-token calls, which have no email. */
  commonName: string | null
}

interface AccessJwtPayload {
  aud?: string | string[]
  email?: string
  sub?: string
  iss?: string
  exp?: number
  nbf?: number
  iat?: number
  common_name?: string
}

interface Jwk {
  kid: string
  kty: string
  alg?: string
  n: string
  e: string
}

const JWKS_CACHE_KEY = 'access:jwks'
const JWKS_CACHE_TTL_SECONDS = 3600
/** Tolerance for clock drift between Access and the Worker, in seconds. */
const CLOCK_SKEW_SECONDS = 60

export class AccessVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccessVerificationError'
  }
}

export interface AccessConfig {
  teamDomain: string
  aud: string
  cache: KVNamespace
}

/**
 * Verifies an Access assertion and returns the identity it carries.
 * Throws AccessVerificationError on any failure; callers treat that as
 * "not signed in" rather than surfacing the reason to the client.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig): Promise<AccessIdentity> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessVerificationError('Malformed JWT')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  const header = decodeJson<{ kid?: string; alg?: string }>(headerPart)
  // Access signs with RS256. Pinning the algorithm blocks the classic
  // "alg: none" and HMAC-confusion downgrades, where an attacker re-signs the
  // token using the public key as an HMAC secret.
  if (header.alg !== 'RS256') {
    throw new AccessVerificationError(`Unexpected JWT algorithm ${header.alg ?? 'none'}`)
  }
  if (!header.kid) throw new AccessVerificationError('JWT is missing a key id')

  const key = await resolveKey(header.kid, config)
  const signature = base64UrlToBytes(signaturePart)
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`)

  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    signature as BufferSource,
    signed as BufferSource,
  )
  if (!valid) throw new AccessVerificationError('JWT signature does not verify')

  const payload = decodeJson<AccessJwtPayload>(payloadPart)
  assertClaims(payload, config)

  if (!payload.sub && !payload.common_name) {
    throw new AccessVerificationError('JWT carries neither a subject nor a service-token name')
  }

  return {
    // Service tokens have no `sub`; key them by common name so they map to a
    // stable identity too.
    sub: payload.sub || `service:${payload.common_name}`,
    email: payload.email ?? '',
    commonName: payload.common_name ?? null,
  }
}

function assertClaims(payload: AccessJwtPayload, config: AccessConfig): void {
  const expectedIssuer = `https://${config.teamDomain}`
  if (payload.iss !== expectedIssuer) {
    throw new AccessVerificationError(`JWT issuer ${payload.iss ?? '(none)'} is not ${expectedIssuer}`)
  }

  // A token minted for a different Access application must not be accepted here,
  // or any app on the same team could be used to impersonate a user.
  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  if (!audiences.includes(config.aud)) {
    throw new AccessVerificationError('JWT audience does not match this application')
  }

  const now = Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || now > payload.exp + CLOCK_SKEW_SECONDS) {
    throw new AccessVerificationError('JWT has expired')
  }
  if (typeof payload.nbf === 'number' && now + CLOCK_SKEW_SECONDS < payload.nbf) {
    throw new AccessVerificationError('JWT is not valid yet')
  }
}

/**
 * Looks up a signing key by id, refreshing the cached JWKS on a miss.
 *
 * The refresh-on-unknown-kid path matters: Access rotates signing keys, and a
 * cache that only expired on TTL would reject every request for up to an hour
 * after a rotation.
 */
async function resolveKey(kid: string, config: AccessConfig): Promise<CryptoKey> {
  const cached = await config.cache.get<Jwk[]>(JWKS_CACHE_KEY, 'json')
  const hit = cached?.find((key) => key.kid === kid)
  if (hit) return importJwk(hit)

  const fresh = await fetchJwks(config)
  await config.cache.put(JWKS_CACHE_KEY, JSON.stringify(fresh), {
    expirationTtl: JWKS_CACHE_TTL_SECONDS,
  })

  const key = fresh.find((entry) => entry.kid === kid)
  if (!key) throw new AccessVerificationError(`No Access signing key matches kid ${kid}`)
  return importJwk(key)
}

async function fetchJwks(config: AccessConfig): Promise<Jwk[]> {
  const response = await fetch(`https://${config.teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) {
    throw new AccessVerificationError(`Could not fetch Access JWKS (${response.status})`)
  }
  const body = (await response.json()) as { keys?: Jwk[] }
  if (!body.keys?.length) throw new AccessVerificationError('Access JWKS is empty')
  return body.keys
}

function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

function decodeJson<T>(part: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as T
  } catch {
    throw new AccessVerificationError('JWT segment is not valid JSON')
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
