import { isAccessConfigured, type Env } from '../env'
import { newId } from '../ids'
import { readCookie, SESSION_COOKIE } from './context'
import { clearedSessionCookie, createSession, destroySession, sessionCookie } from './session'

/**
 * Sign-in for local development.
 *
 * Cloudflare Access is the real authentication path, but it cannot run against
 * `wrangler dev` — there is no edge in front of localhost to terminate it — and
 * it cannot be attached to a workers.dev subdomain either, since Access
 * applications require a zone. Without something in its place the UI has no way
 * to establish a session at all, which is what made every page render as an
 * anonymous viewer.
 *
 * This is deliberately a back door, so the gate matters:
 *
 *   1. `GITFLARE_DEV_LOGIN` must be "1". It is set in `.dev.vars`, which
 *      Wrangler reads only in local development and never uploads, so a
 *      deployed Worker cannot have it however the config drifts.
 *   2. Access must be unconfigured. Once a team domain and AUD are set, the
 *      real path exists and this one must not.
 *
 * Both are checked on every request rather than once at startup, and the routes
 * return null when either fails — so the endpoint 404s rather than announcing
 * itself.
 */

export type AuthRoute = 'dev-login' | 'logout'

export function matchAuthRoute(url: URL): AuthRoute | null {
  if (url.pathname === '/auth/dev-login') return 'dev-login'
  if (url.pathname === '/auth/logout') return 'logout'
  return null
}

function devLoginEnabled(env: Env, url: URL): boolean {
  return isLoopback(url.hostname) && env.GITFLARE_DEV_LOGIN === '1' && !isAccessConfigured(env)
}

/** Hostnames only reachable when the Worker is running on this machine. */
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

export async function handleAuthRoute(
  route: AuthRoute,
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url)
  const secure = url.protocol === 'https:'

  if (route === 'logout') return handleLogout(request, env, secure)
  // Disabled: explain where sign-in actually lives rather than 404ing blankly.
  // The status stays 404 — the route does not exist here — but the body saves
  // whoever followed the header link from guessing.
  if (!devLoginEnabled(env, url)) return disabledPage(env)

  if (request.method === 'GET') return signInPage(env)
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const form = await request.formData()
  const login = String(form.get('login') ?? '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,38}$/.test(login)) {
    return signInPage(env, 'Pick a login of letters, numbers, dots, hyphens, or underscores.')
  }

  const user = await ensureUser(env, login)
  const session = await createSession(env, user.id, request.headers.get('User-Agent') ?? '')

  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Set-Cookie': sessionCookie(session.plaintext, {
        secure,
        maxAgeSeconds: Math.floor((session.expiresAt - Date.now()) / 1000),
      }),
    },
  })
}

/**
 * Ends the session and clears the cookie.
 *
 * Available whether or not dev login is: an Access deployment still wants the
 * local cookie cleared, and Access's own session is ended by its logout
 * endpoint, which the response points at.
 */
async function handleLogout(request: Request, env: Env, secure: boolean): Promise<Response> {
  const cookie = readCookie(request.headers.get('Cookie'), SESSION_COOKIE)
  if (cookie) await destroySession(env, cookie)

  const location = isAccessConfigured(env)
    ? `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`
    : '/'

  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Set-Cookie': clearedSessionCookie(secure) },
  })
}

/**
 * Finds a user by login, creating one on first sign-in.
 *
 * The first account created becomes the site administrator — the same rule the
 * Access path uses, and the only way to bootstrap one when there is no
 * pre-existing admin to grant the flag.
 */
async function ensureUser(env: Env, login: string): Promise<{ id: string; login: string }> {
  const existing = await env.DB.prepare(
    `SELECT u.owner_id AS id, o.login
     FROM users u JOIN owners o ON o.id = u.owner_id
     WHERE o.login_lower = ?1 AND u.is_active = 1`,
  )
    .bind(login.toLowerCase())
    .first<{ id: string; login: string }>()
  if (existing) return existing

  // An org already holding the name is not a user and cannot be signed in as.
  const taken = await env.DB.prepare(`SELECT 1 FROM owners WHERE login_lower = ?1`)
    .bind(login.toLowerCase())
    .first()
  if (taken) throw new Error(`The name "${login}" is already taken by an organization`)

  const id = newId()
  const now = Date.now()
  const count = await env.DB.prepare(`SELECT count(*) AS count FROM users`).first<{ count: number }>()
  const isAdmin = (count?.count ?? 0) === 0

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO owners (id, login, login_lower, kind, display_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'user', ?2, ?4, ?4)`,
    ).bind(id, login, login.toLowerCase(), now),
    env.DB.prepare(
      `INSERT INTO users (owner_id, email, email_lower, is_admin, last_seen_at)
       VALUES (?1, ?2, ?2, ?3, ?4)`,
    ).bind(id, `${login.toLowerCase()}@localhost`, isAdmin ? 1 : 0, now),
  ])

  return { id, login }
}

/**
 * A plain HTML form rather than a React route.
 *
 * Sign-in has to work before any session exists, which is exactly when the app
 * shell has the least to show. Serving it from the Worker keeps it independent
 * of the client bundle, and keeps a development-only affordance out of the
 * production build entirely.
 */
async function signInPage(env: Env, error?: string): Promise<Response> {
  const users = await env.DB.prepare(
    `SELECT o.login FROM users u JOIN owners o ON o.id = u.owner_id
     WHERE u.is_active = 1 ORDER BY o.login_lower LIMIT 20`,
  ).all<{ login: string }>()

  const existing = (users.results ?? [])
    .map((row) => `<li><button name="login" value="${escapeHtml(row.login)}">${escapeHtml(row.login)}</button></li>`)
    .join('')

  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Gitflare</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 26rem;
         margin: 4rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  p.note { color: #6b7280; font-size: .875rem; margin-top: 0; }
  form { margin-top: 1.5rem; display: flex; gap: .5rem; }
  input { flex: 1; padding: .5rem .75rem; font: inherit; border: 1px solid #9ca3af;
          border-radius: .375rem; background: transparent; color: inherit; }
  button { padding: .5rem .9rem; font: inherit; cursor: pointer;
           border: 1px solid #9ca3af; border-radius: .375rem;
           background: transparent; color: inherit; }
  ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
  .error { color: #b91c1c; }
</style></head><body>
<h1>Sign in to Gitflare</h1>
<p class="note">Development sign-in. No password: any name signs you in, creating
the account if it does not exist. Cloudflare Access replaces this once a team
domain is configured.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/auth/dev-login">
  <input name="login" placeholder="username" autofocus required
         pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{0,38}">
  <button type="submit">Sign in</button>
</form>
${existing ? `<p class="note">Existing accounts:</p>
<form method="post" action="/auth/dev-login"><ul>${existing}</ul></form>` : ''}
</body></html>`

  return new Response(body, {
    status: error ? 400 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * Shown when dev login is gated off, which is every deployed environment.
 *
 * Access signs users in by redirecting before the request ever reaches the
 * Worker, so reaching this page means Access is not in front of this hostname —
 * which is the thing worth saying.
 */
function disabledPage(env: Env): Response {
  const configured = isAccessConfigured(env)
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in \u00b7 Gitflare</title>
<style>body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:32rem;
margin:4rem auto;padding:0 1.5rem}code{font-size:.9em}</style></head><body>
<h1>Sign-in is not available here</h1>
${
  configured
    ? `<p>This deployment authenticates with Cloudflare Access. Reaching this page
means the request did not pass through Access &mdash; check that the application
covers this hostname.</p>`
    : `<p>Cloudflare Access is not configured on this deployment, and the
development sign-in is disabled.</p>
<p>Set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code> and put an
Access application in front of this hostname. Access requires a zone you own; it
cannot be attached to a <code>workers.dev</code> subdomain.</p>
<p>API and git clients authenticate with a personal access token instead, which
needs no browser session.</p>`
}
<p><a href="/">Back to Gitflare</a></p>
</body></html>`
  return new Response(body, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
}
