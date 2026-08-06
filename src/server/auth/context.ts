import { isAccessConfigured, type Env } from '../env'
import { newId } from '../ids'
import { AccessVerificationError, verifyAccessJwt } from './access'
import { hashToken, looksLikePat, parseBasicAuth, parseBearer } from './tokens'

/**
 * Resolves who is making a request.
 *
 * Four credentials are accepted, in priority order:
 *
 *   1. Cloudflare Access assertion  browser sign-in (the configured default)
 *   2. Bearer personal access token API clients
 *   3. Basic auth password          git over HTTPS, which cannot do SSO
 *   4. Session cookie               local dev only, when Access is unconfigured
 *
 * Access covers the web UI, but a git client cannot complete an interactive SSO
 * redirect and neither can a CLI. Personal access tokens exist to cover those,
 * which is why the `/api/*` and `*.git/*` paths need an Access bypass policy.
 */

export interface Viewer {
  id: string | null
  login: string | null
  isSiteAdmin: boolean
  /** How this request authenticated; null when anonymous. */
  via: 'access' | 'token' | 'session' | null
  /** True for a browser session, which alone may perform cookie-authenticated writes. */
  isSession: boolean
}

export const ANONYMOUS: Viewer = {
  id: null,
  login: null,
  isSiteAdmin: false,
  via: null,
  isSession: false,
}

const SESSION_COOKIE = 'gitflare_session'

export async function resolveViewer(request: Request, env: Env): Promise<Viewer> {
  const accessJwt = request.headers.get('Cf-Access-Jwt-Assertion')
  if (accessJwt && isAccessConfigured(env)) {
    const viewer = await viewerFromAccess(accessJwt, env)
    if (viewer) return viewer
  }

  const bearer = parseBearer(request.headers.get('Authorization'))
  if (bearer && looksLikePat(bearer)) {
    const viewer = await viewerFromPat(bearer, env)
    if (viewer) return viewer
  }

  // Git sends the token as the Basic auth password and ignores the username.
  const basic = parseBasicAuth(request.headers.get('Authorization'))
  if (basic) {
    const viewer = await viewerFromPat(basic.password, env)
    if (viewer) return viewer
  }

  const cookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
  if (cookie) {
    const viewer = await viewerFromSession(cookie, env)
    if (viewer) return viewer
  }

  return ANONYMOUS
}

async function viewerFromAccess(jwt: string, env: Env): Promise<Viewer | null> {
  let identity
  try {
    identity = await verifyAccessJwt(jwt, {
      teamDomain: env.ACCESS_TEAM_DOMAIN,
      aud: env.ACCESS_AUD,
      cache: env.CACHE,
    })
  } catch (error) {
    // A bad assertion is treated as "not signed in" rather than an error, so a
    // stale tab falls through to the sign-in flow instead of a 500.
    if (error instanceof AccessVerificationError) return null
    throw error
  }

  const user = await upsertAccessUser(identity.sub, identity.email, env)
  return { id: user.id, login: user.login, isSiteAdmin: user.isAdmin, via: 'access', isSession: true }
}

/**
 * Finds or creates the local user behind an Access identity.
 *
 * Access is the authority on *who* someone is, but the forge still needs a row
 * to own repos and be referenced by issues, so first sign-in provisions one.
 */
async function upsertAccessUser(
  sub: string,
  email: string,
  env: Env,
): Promise<{ id: string; login: string; isAdmin: boolean }> {
  const existing = await env.DB.prepare(
    `SELECT u.owner_id AS id, o.login, u.is_admin
     FROM users u JOIN owners o ON o.id = u.owner_id
     WHERE u.access_sub = ?1`,
  )
    .bind(sub)
    .first<{ id: string; login: string; is_admin: number }>()

  if (existing) {
    return { id: existing.id, login: existing.login, isAdmin: existing.is_admin === 1 }
  }

  // An account may predate Access (seeded, or created by an earlier local
  // session). Claim it by email rather than creating a duplicate.
  const byEmail = email
    ? await env.DB.prepare(
        `SELECT u.owner_id AS id, o.login, u.is_admin
         FROM users u JOIN owners o ON o.id = u.owner_id
         WHERE u.email_lower = ?1 AND u.access_sub IS NULL`,
      )
        .bind(email.toLowerCase())
        .first<{ id: string; login: string; is_admin: number }>()
    : null

  if (byEmail) {
    await env.DB.prepare(`UPDATE users SET access_sub = ?2 WHERE owner_id = ?1`)
      .bind(byEmail.id, sub)
      .run()
    return { id: byEmail.id, login: byEmail.login, isAdmin: byEmail.is_admin === 1 }
  }

  const id = newId()
  const login = await uniqueLogin(loginFromEmail(email, sub), env)
  const now = Date.now()

  // The very first user becomes the site administrator; there is no other way to
  // bootstrap one when identity is delegated to Access.
  const isFirst = await env.DB.prepare(`SELECT count(*) AS count FROM users`).first<{ count: number }>()
  const isAdmin = (isFirst?.count ?? 0) === 0

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO owners (id, login, login_lower, kind, display_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?5)`,
    ).bind(id, login, login.toLowerCase(), email || login, now),
    env.DB.prepare(
      `INSERT INTO users (owner_id, email, email_lower, access_sub, is_admin, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(id, email, email.toLowerCase(), sub, isAdmin ? 1 : 0, now),
  ])

  return { id, login, isAdmin }
}

async function viewerFromPat(plaintext: string, env: Env): Promise<Viewer | null> {
  if (!looksLikePat(plaintext)) return null
  const hash = await hashToken(plaintext)

  const row = await env.DB.prepare(
    `SELECT t.id AS token_id, t.expires_at, u.owner_id AS id, o.login, u.is_admin, u.is_active
     FROM access_tokens t
     JOIN users u ON u.owner_id = t.user_id
     JOIN owners o ON o.id = u.owner_id
     WHERE t.token_hash = ?1`,
  )
    .bind(hash)
    .first<{
      token_id: string
      expires_at: number | null
      id: string
      login: string
      is_admin: number
      is_active: number
    }>()

  if (!row || row.is_active !== 1) return null
  if (row.expires_at !== null && row.expires_at < Date.now()) return null

  return {
    id: row.id,
    login: row.login,
    isSiteAdmin: row.is_admin === 1,
    via: 'token',
    // A token is not a browser session: this flag is what stops a PAT from
    // being usable where a same-site cookie is assumed.
    isSession: false,
  }
}

async function viewerFromSession(plaintext: string, env: Env): Promise<Viewer | null> {
  const hash = await hashToken(plaintext)
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.owner_id AS id, o.login, u.is_admin, u.is_active
     FROM sessions s
     JOIN users u ON u.owner_id = s.user_id
     JOIN owners o ON o.id = u.owner_id
     WHERE s.token_hash = ?1`,
  )
    .bind(hash)
    .first<{ expires_at: number; id: string; login: string; is_admin: number; is_active: number }>()

  if (!row || row.is_active !== 1 || row.expires_at < Date.now()) return null
  return { id: row.id, login: row.login, isSiteAdmin: row.is_admin === 1, via: 'session', isSession: true }
}

function loginFromEmail(email: string, sub: string): string {
  const local = email.split('@')[0] ?? ''
  const cleaned = local.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/-{2,}/g, '-')
  return cleaned.replace(/^[^a-z0-9]+/, '') || `user-${sub.slice(0, 8).toLowerCase()}`
}

/** Appends a numeric suffix until the login is free. */
async function uniqueLogin(base: string, env: Env): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    const taken = await env.DB.prepare(`SELECT 1 FROM owners WHERE login_lower = ?1`)
      .bind(candidate.toLowerCase())
      .first()
    if (!taken) return candidate
  }
  return `${base}-${newId().slice(-6).toLowerCase()}`
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim())
    }
  }
  return null
}

export { SESSION_COOKIE }
