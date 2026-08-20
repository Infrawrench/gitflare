import { beforeEach, describe, expect, it } from 'vitest'
import { handleAuthRoute, matchAuthRoute } from '~/server/auth/dev-login'
import { resolveViewer } from '~/server/auth/context'
import { createSession } from '~/server/auth/session'
import { createUser, resetDatabase, testEnv } from './helpers'
import type { Env } from '~/server/env'

/**
 * The development sign-in route.
 *
 * Two things are worth testing here, and only one of them is the happy path.
 * The other is the gate: this route creates an authenticated session for
 * whatever name it is handed, with no password, so every condition that keeps it
 * off a deployed Worker is a security boundary. A regression there would not
 * fail any other test in the suite — everything would keep working, just for
 * everyone.
 */

beforeEach(async () => {
  await resetDatabase()
})

/** Local dev: the gate is open. */
const devEnv = { ...testEnv, GITFLARE_DEV_LOGIN: '1' } as Env

/**
 * The flag explicitly absent.
 *
 * `testEnv` cannot stand in for this: `.dev.vars` is read by the test runner
 * too, so the flag is already set there. That is precisely why the flag is not
 * the security boundary — the loopback check is.
 */
const noFlagEnv = { ...testEnv, GITFLARE_DEV_LOGIN: undefined } as Env

function signIn(login: string, env: Env, origin = 'http://localhost:8787') {
  const body = new FormData()
  body.set('login', login)
  return handleAuthRoute('dev-login', new Request(`${origin}/auth/dev-login`, { method: 'POST', body }), env)
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('Set-Cookie') ?? ''
  return header.split(';')[0]!
}

describe('routing', () => {
  it('matches only its own paths', () => {
    expect(matchAuthRoute(new URL('http://localhost/auth/dev-login'))).toBe('dev-login')
    expect(matchAuthRoute(new URL('http://localhost/auth/logout'))).toBe('logout')
    expect(matchAuthRoute(new URL('http://localhost/auth/dev-login/x'))).toBeNull()
    expect(matchAuthRoute(new URL('http://localhost/astrid/auth/dev-login'))).toBeNull()
  })
})

describe('signing in', () => {
  it('issues a session that resolveViewer accepts', async () => {
    const userId = await createUser('astrid')
    const response = await signIn('astrid', devEnv)

    expect(response?.status).toBe(303)
    expect(response?.headers.get('Location')).toBe('/')

    const viewer = await resolveViewer(
      new Request('http://localhost/', { headers: { Cookie: cookieFrom(response!) } }),
      testEnv,
    )
    expect(viewer).toMatchObject({ id: userId, login: 'astrid', via: 'session', isSession: true })
  })

  it('creates the account on first sign-in, and the first one is the admin', async () => {
    const first = await signIn('astrid', devEnv)
    const second = await signIn('someone', devEnv)

    const viewerOne = await resolveViewer(
      new Request('http://localhost/', { headers: { Cookie: cookieFrom(first!) } }),
      testEnv,
    )
    const viewerTwo = await resolveViewer(
      new Request('http://localhost/', { headers: { Cookie: cookieFrom(second!) } }),
      testEnv,
    )

    expect(viewerOne.isSiteAdmin).toBe(true)
    expect(viewerTwo.isSiteAdmin).toBe(false)
    expect(viewerTwo.login).toBe('someone')
  })

  it('sets HttpOnly and SameSite, and stores only a hash', async () => {
    await createUser('astrid')
    const response = await signIn('astrid', devEnv)
    const header = response!.headers.get('Set-Cookie')!

    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Lax')
    // http://localhost must not get Secure, or the browser drops the cookie.
    expect(header).not.toContain('Secure')

    const plaintext = decodeURIComponent(header.split(';')[0]!.split('=')[1]!)
    const stored = await testEnv.DB.prepare(`SELECT token_hash FROM sessions`).first<{
      token_hash: string
    }>()
    expect(stored!.token_hash).not.toBe(plaintext)
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('marks the cookie Secure over https', async () => {
    await createUser('astrid')
    const response = await signIn('astrid', devEnv, 'https://gitflare.localhost')
    expect(response!.headers.get('Set-Cookie')).toContain('Secure')
  })

  it('rejects a login that is not a valid name', async () => {
    for (const bad of ['', '../etc', 'has space', '-leading', 'a'.repeat(40)]) {
      const response = await signIn(bad, devEnv)
      expect(response!.status).toBe(400)
      expect(response!.headers.get('Set-Cookie')).toBeNull()
    }
    const count = await testEnv.DB.prepare(`SELECT count(*) AS n FROM sessions`).first<{ n: number }>()
    expect(count!.n).toBe(0)
  })
})

describe('the gate', () => {
  /** Each of these must independently be enough to close the route. */
  const closed: [string, Env, string][] = [
    ['the hostname is not loopback', devEnv, 'https://gitflare.astrid-906.workers.dev'],
    ['GITFLARE_DEV_LOGIN is unset', noFlagEnv, 'http://localhost:8787'],
    [
      'Access is configured',
      { ...devEnv, ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com', ACCESS_AUD: 'aud' } as Env,
      'http://localhost:8787',
    ],
  ]

  for (const [reason, env, origin] of closed) {
    it(`refuses to sign anyone in when ${reason}`, async () => {
      const response = await signIn('attacker', env, origin)

      expect(response!.status).toBe(404)
      expect(response!.headers.get('Set-Cookie')).toBeNull()

      // No session, and no account conjured into existence either.
      const sessions = await testEnv.DB.prepare(`SELECT count(*) AS n FROM sessions`).first<{ n: number }>()
      const owners = await testEnv.DB.prepare(
        `SELECT count(*) AS n FROM owners WHERE login_lower = 'attacker'`,
      ).first<{ n: number }>()
      expect(sessions!.n).toBe(0)
      expect(owners!.n).toBe(0)
    })
  }

  it('does not serve the form when closed', async () => {
    const response = await handleAuthRoute(
      'dev-login',
      new Request('https://gitflare.astrid-906.workers.dev/auth/dev-login'),
      devEnv,
    )
    expect(response!.status).toBe(404)
    expect(await response!.text()).not.toContain('<form method="post"')
  })
})

describe('signing out', () => {
  it('revokes the session and clears the cookie', async () => {
    const userId = await createUser('astrid')
    const session = await createSession(testEnv, userId)
    const cookie = `gitflare_session=${session.plaintext}`

    const response = await handleAuthRoute(
      'logout',
      new Request('http://localhost/auth/logout', { headers: { Cookie: cookie } }),
      devEnv,
    )

    expect(response!.status).toBe(303)
    expect(response!.headers.get('Set-Cookie')).toContain('Max-Age=0')

    const viewer = await resolveViewer(
      new Request('http://localhost/', { headers: { Cookie: cookie } }),
      testEnv,
    )
    expect(viewer.id).toBeNull()
  })

  it('works even where dev sign-in does not, and points at the Access logout', async () => {
    const accessEnv = {
      ...testEnv,
      ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com',
      ACCESS_AUD: 'aud',
    } as Env
    const response = await handleAuthRoute(
      'logout',
      new Request('https://gitflare.example.com/auth/logout'),
      accessEnv,
    )
    expect(response!.headers.get('Location')).toBe(
      'https://acme.cloudflareaccess.com/cdn-cgi/access/logout',
    )
  })
})

describe('expiry', () => {
  it('stops accepting a session past its expiry', async () => {
    const userId = await createUser('astrid')
    const session = await createSession(testEnv, userId)
    await testEnv.DB.prepare(`UPDATE sessions SET expires_at = ?1`).bind(Date.now() - 1).run()

    const viewer = await resolveViewer(
      new Request('http://localhost/', {
        headers: { Cookie: `gitflare_session=${session.plaintext}` },
      }),
      testEnv,
    )
    expect(viewer.id).toBeNull()
  })
})
