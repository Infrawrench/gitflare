import { describe, expect, it, vi } from 'vitest'
import {
  handleGitRequest,
  matchGitRoute,
  requiredPermission,
  type GitAuthorization,
  type GitProxyDeps,
} from '~/server/git/http'
import { ForgeError } from '~/server/errors'

function url(path: string): URL {
  return new URL(`https://gitflare.test${path}`)
}

describe('matchGitRoute', () => {
  it('matches the upload-pack advertisement', () => {
    expect(matchGitRoute(url('/astrid/api.git/info/refs?service=git-upload-pack'), 'GET')).toEqual({
      owner: 'astrid',
      repo: 'api',
      service: 'git-upload-pack',
      isAdvertisement: true,
    })
  })

  it('accepts a repo path without the .git suffix', () => {
    // Git tries both forms; rejecting one breaks clones that omit it.
    expect(matchGitRoute(url('/astrid/api/info/refs?service=git-receive-pack'), 'GET')?.repo).toBe('api')
  })

  it('matches the RPC endpoints', () => {
    expect(matchGitRoute(url('/astrid/api.git/git-receive-pack'), 'POST')).toEqual({
      owner: 'astrid',
      repo: 'api',
      service: 'git-receive-pack',
      isAdvertisement: false,
    })
  })

  it('ignores unknown services and non-git paths', () => {
    expect(matchGitRoute(url('/astrid/api.git/info/refs?service=git-evil-pack'), 'GET')).toBeNull()
    expect(matchGitRoute(url('/astrid/api/issues'), 'GET')).toBeNull()
    expect(matchGitRoute(url('/astrid'), 'GET')).toBeNull()
  })

  it('maps services to the permission they need', () => {
    expect(requiredPermission('git-upload-pack')).toBe('read')
    expect(requiredPermission('git-receive-pack')).toBe('write')
  })
})

function auth(overrides: Partial<GitAuthorization> = {}): GitAuthorization {
  return {
    permission: 'admin',
    canWrite: true,
    userId: 'u1',
    artifactsName: 'astrid--api',
    archived: false,
    ...overrides,
  }
}

function deps(overrides: Partial<GitProxyDeps> = {}): GitProxyDeps {
  return {
    artifacts: {
      mintToken: vi.fn().mockResolvedValue('artifacts-token'),
      remoteFor: (name: string) => `https://acct.artifacts.cloudflare.net/git/gitflare/${name}.git`,
    } as never,
    authorize: vi.fn().mockResolvedValue(auth()),
    waitUntil: vi.fn(),
    ...overrides,
  }
}

const PUSH_ROUTE = {
  owner: 'astrid',
  repo: 'api',
  service: 'git-receive-pack' as const,
  isAdvertisement: false,
}
const FETCH_ROUTE = {
  owner: 'astrid',
  repo: 'api',
  service: 'git-upload-pack' as const,
  isAdvertisement: true,
}

describe('handleGitRequest', () => {
  it('challenges an anonymous push with Basic auth', async () => {
    const response = await handleGitRequest(
      PUSH_ROUTE,
      new Request('https://gitflare.test/astrid/api.git/git-receive-pack', { method: 'POST' }),
      deps({ authorize: vi.fn().mockResolvedValue(auth({ userId: null, canWrite: false })) }),
    )

    expect(response.status).toBe(401)
    // Without this header git will not prompt for credentials at all.
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm="Gitflare"')
  })

  it('returns 403, not a re-prompt, when an authenticated user lacks write', async () => {
    const response = await handleGitRequest(
      PUSH_ROUTE,
      new Request('https://gitflare.test/astrid/api.git/git-receive-pack', { method: 'POST' }),
      deps({ authorize: vi.fn().mockResolvedValue(auth({ canWrite: false, permission: 'read' })) }),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toMatch(/do not have permission to push/)
  })

  it('explains an archived repo instead of blaming permissions', async () => {
    const response = await handleGitRequest(
      PUSH_ROUTE,
      new Request('https://gitflare.test/astrid/api.git/git-receive-pack', { method: 'POST' }),
      deps({
        authorize: vi.fn().mockResolvedValue(auth({ canWrite: false, archived: true })),
      }),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toMatch(/archived/)
  })

  it('reports a hidden private repo as not found', async () => {
    // 403 here would confirm the repo exists to someone who should not know.
    const response = await handleGitRequest(
      FETCH_ROUTE,
      new Request('https://gitflare.test/astrid/api.git/info/refs?service=git-upload-pack'),
      deps({ authorize: vi.fn().mockRejectedValue(ForgeError.notFound('Repository')) }),
    )
    expect(response.status).toBe(404)
  })

  it('mints a write-scoped token for a push and a read-scoped one for a fetch', async () => {
    const mintToken = vi.fn().mockResolvedValue('t')
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const shared = {
      artifacts: { mintToken, remoteFor: (n: string) => `https://remote/${n}.git` } as never,
    }

    await handleGitRequest(
      PUSH_ROUTE,
      new Request('https://gitflare.test/x', { method: 'POST', body: 'pack' }),
      deps(shared),
    )
    expect(mintToken).toHaveBeenCalledWith('astrid--api', 'write')

    await handleGitRequest(
      FETCH_ROUTE,
      new Request('https://gitflare.test/x'),
      deps({ ...shared, authorize: vi.fn().mockResolvedValue(auth({ canWrite: false, permission: 'read' })) }),
    )
    expect(mintToken).toHaveBeenLastCalledWith('astrid--api', 'read')
    vi.unstubAllGlobals()
  })

  it('forwards Git-Protocol so v2 clones are not silently downgraded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await handleGitRequest(
      FETCH_ROUTE,
      new Request('https://gitflare.test/x', { headers: { 'Git-Protocol': 'version=2' } }),
      deps(),
    )

    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Headers).get('git-protocol')).toBe('version=2')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer artifacts-token')
    vi.unstubAllGlobals()
  })

  it('turns an upstream token rejection into 502 rather than re-prompting the user', async () => {
    // A 401 from Artifacts means *our* token was bad. Passing it through would
    // make git ask the user for credentials that were never the problem.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 401 })))
    const response = await handleGitRequest(
      FETCH_ROUTE,
      new Request('https://gitflare.test/x'),
      deps(),
    )
    expect(response.status).toBe(502)
    expect(response.headers.get('WWW-Authenticate')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('marks git responses uncacheable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('refs', { status: 200 })))
    const response = await handleGitRequest(
      FETCH_ROUTE,
      new Request('https://gitflare.test/x'),
      deps(),
    )
    expect(response.headers.get('cache-control')).toMatch(/no-cache/)
    vi.unstubAllGlobals()
  })

  it('records the push after a successful receive-pack, without blocking it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))
    const onPush = vi.fn().mockResolvedValue(undefined)
    const waitUntil = vi.fn()

    await handleGitRequest(
      PUSH_ROUTE,
      new Request('https://gitflare.test/x', { method: 'POST', body: 'pack' }),
      deps({ onPush, waitUntil }),
    )

    expect(waitUntil).toHaveBeenCalledOnce()
    expect(onPush).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('does not record a push that upstream rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 500 })))
    const onPush = vi.fn()
    await handleGitRequest(
      PUSH_ROUTE,
      new Request('https://gitflare.test/x', { method: 'POST', body: 'pack' }),
      deps({ onPush }),
    )
    expect(onPush).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
