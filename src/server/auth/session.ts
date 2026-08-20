import type { Env } from '../env'
import { newId } from '../ids'
import { generateSessionToken, hashToken } from './tokens'
import { SESSION_COOKIE } from './context'

/**
 * Browser sessions.
 *
 * Only the SHA-256 of the cookie value is stored, so a database leak yields
 * nothing replayable — the same reason personal access tokens are hashed. The
 * plaintext exists exactly once, in the Set-Cookie header that creates it.
 *
 * Sessions are issued by the sign-in routes (see dev-login.ts) and read by
 * resolveViewer(). Cloudflare Access does not use them: it carries its own
 * cookie and forwards a signed assertion instead.
 */

/** Session lifetime. Short enough that an abandoned dev session expires. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface IssuedSession {
  plaintext: string
  expiresAt: number
}

export async function createSession(
  env: Env,
  userId: string,
  userAgent = '',
): Promise<IssuedSession> {
  const { plaintext, hash } = await generateSessionToken()
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(newId(), userId, hash, userAgent.slice(0, 255), now, expiresAt)
    .run()

  return { plaintext, expiresAt }
}

/** Revokes one session. Silent when the cookie is already unknown. */
export async function destroySession(env: Env, plaintext: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`)
    .bind(await hashToken(plaintext))
    .run()
}

/**
 * Builds the Set-Cookie header.
 *
 * HttpOnly keeps the value out of reach of any script that manages to run on the
 * page — repository content is rendered here, so that is not a theoretical
 * concern. SameSite=Lax is what lets a normal top-level navigation carry the
 * session while a cross-site form post does not.
 */
export function sessionCookie(value: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ]
  // Omitted on http://localhost, where a Secure cookie would be dropped.
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAgeSeconds: 0 })
}
