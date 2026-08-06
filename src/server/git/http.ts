import { ArtifactsClient } from '../artifacts/client'
import { ForgeError, httpStatusFor, isGateError } from '../errors'
import type { Permission } from '../auth/rbac'

/**
 * Git smart-HTTP proxy.
 *
 * Artifacts serves a real git remote, but only to bearers of a repo-scoped
 * token that a git client has no way to obtain. This route bridges the two: it
 * authenticates the client with ordinary HTTP Basic auth (username + personal
 * access token), checks the forge's own permissions, mints a short-lived
 * Artifacts token, and streams the git protocol through.
 *
 * The result is that `git clone https://gitflare.example.com/astrid/api.git`
 * works with an unmodified git client — no `http.extraHeader` configuration,
 * which is what the raw Artifacts remote would otherwise require.
 *
 * Bodies are streamed in both directions. A packfile can be hundreds of
 * megabytes, and buffering one would blow the Worker's memory limit on exactly
 * the repos that matter most.
 */

export type GitService = 'git-upload-pack' | 'git-receive-pack'

export interface GitRoute {
  owner: string
  repo: string
  service: GitService
  /** `info/refs` advertisement rather than the RPC itself. */
  isAdvertisement: boolean
}

/**
 * Matches the git HTTP routes. Recognized shapes:
 *   GET  /:owner/:repo.git/info/refs?service=git-upload-pack
 *   POST /:owner/:repo.git/git-upload-pack
 *   POST /:owner/:repo.git/git-receive-pack
 *
 * The `.git` suffix is optional, matching how git itself will try both.
 */
export function matchGitRoute(url: URL, method: string): GitRoute | null {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 3) return null

  const owner = segments[0]!
  const repo = segments[1]!.replace(/\.git$/, '')
  const rest = segments.slice(2).join('/')

  if (method === 'GET' && rest === 'info/refs') {
    const service = url.searchParams.get('service')
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return null
    return { owner, repo, service, isAdvertisement: true }
  }

  if (method === 'POST' && (rest === 'git-upload-pack' || rest === 'git-receive-pack')) {
    return { owner, repo, service: rest, isAdvertisement: false }
  }

  return null
}

/** Fetching needs read; pushing needs write. */
export function requiredPermission(service: GitService): Permission {
  return service === 'git-receive-pack' ? 'write' : 'read'
}

export interface GitAuthorization {
  permission: Permission
  canWrite: boolean
  /** Null for an anonymous clone of a public repo. */
  userId: string | null
  /** Artifacts repo name backing this repo. */
  artifactsName: string
  archived: boolean
}

export interface GitProxyDeps {
  artifacts: ArtifactsClient
  /**
   * Resolves the repo and the caller's permission, or throws ForgeError. Must
   * report a private repo the caller cannot see as not-found, never forbidden.
   */
  authorize(route: GitRoute, request: Request): Promise<GitAuthorization>
  /** Called after a push is proxied, to refresh pushed_at and the activity feed. */
  onPush?(auth: GitAuthorization, route: GitRoute): Promise<void>
  waitUntil(promise: Promise<unknown>): void
}

const AUTH_REALM = 'Basic realm="Gitflare", charset="UTF-8"'

export async function handleGitRequest(
  route: GitRoute,
  request: Request,
  deps: GitProxyDeps,
): Promise<Response> {
  let auth: GitAuthorization
  try {
    auth = await deps.authorize(route, request)
  } catch (error) {
    return errorResponse(error)
  }

  const needed = requiredPermission(route.service)
  if (needed === 'write' && !auth.canWrite) {
    // Distinguish the two write failures: an archived repo is not a permissions
    // problem, and telling the user to ask for access would be wrong.
    return auth.archived
      ? gitError(403, 'This repository is archived and cannot be pushed to.')
      : unauthorized(auth.userId !== null)
  }

  const scope = needed === 'write' ? 'write' : 'read'

  let token: string
  try {
    token = await deps.artifacts.mintToken(auth.artifactsName, scope)
  } catch (error) {
    return errorResponse(error)
  }

  const upstream = buildUpstreamUrl(deps.artifacts.remoteFor(auth.artifactsName), route, request)
  const response = await fetch(upstream, buildUpstreamRequest(route, request, token))

  if (route.service === 'git-receive-pack' && !route.isAdvertisement && response.ok && deps.onPush) {
    // Fire-and-forget: the client is waiting on the packfile response, and
    // bookkeeping must not delay or fail it.
    deps.waitUntil(deps.onPush(auth, route).catch(() => {}))
  }

  return proxyResponse(response)
}

function buildUpstreamUrl(remote: string, route: GitRoute, request: Request): string {
  if (route.isAdvertisement) {
    return `${remote}/info/refs?service=${route.service}`
  }
  return `${remote}/${route.service}`
}

function buildUpstreamRequest(route: GitRoute, request: Request, token: string): RequestInit {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('User-Agent', request.headers.get('user-agent') ?? 'git/2.45.0 (gitflare)')

  // Forwarded as-is. Content-Encoding matters because git gzips request bodies
  // by default, and Git-Protocol carries the v2 negotiation the client asked
  // for — dropping it would silently downgrade every clone to v0.
  for (const name of ['accept', 'content-type', 'content-encoding', 'git-protocol']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  if (route.isAdvertisement) {
    return { method: 'GET', headers }
  }

  return {
    method: 'POST',
    headers,
    body: request.body,
    // Required whenever a request body is a stream: it tells the runtime we are
    // not waiting for the response before finishing the request.
    duplex: 'half',
  } as RequestInit
}

/**
 * Copies the upstream response through, dropping headers that describe the
 * upstream hop rather than the payload.
 */
function proxyResponse(response: Response): Response {
  const headers = new Headers()
  for (const name of ['content-type', 'cache-control', 'expires', 'pragma', 'content-encoding']) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  // Git responses must never be cached; a stale ref advertisement makes a client
  // negotiate against objects the server no longer has.
  if (!headers.has('cache-control')) {
    headers.set('cache-control', 'no-cache, max-age=0, must-revalidate')
  }

  if (response.status === 401 || response.status === 403) {
    // An upstream auth failure means our minted token was rejected, which is a
    // server-side problem. Surfacing 401 would make git re-prompt the user for
    // credentials that were never the issue.
    return gitError(502, 'Artifacts rejected the repository token. Check the Worker configuration.')
  }

  return new Response(response.body, { status: response.status, headers })
}

function unauthorized(authenticated: boolean): Response {
  if (authenticated) {
    return gitError(403, 'You do not have permission to push to this repository.')
  }
  return new Response('Authentication required\n', {
    status: 401,
    headers: {
      'WWW-Authenticate': AUTH_REALM,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}

function errorResponse(error: unknown): Response {
  // 503, not the 412 that failed_precondition would otherwise map to: from a
  // git client's point of view the server is missing a capability, which is a
  // server-side fault it may retry, not a precondition on this request.
  if (isGateError(error)) {
    return gitError(503, 'Git storage is unavailable: Cloudflare Artifacts is not enabled on this account.')
  }
  if (error instanceof ForgeError) {
    if (error.kind === 'unauthenticated') return unauthorized(false)
    return gitError(httpStatusFor(error), error.message)
  }
  return gitError(500, 'Internal error')
}

/**
 * Plain-text error. Git surfaces the body to the user for non-2xx responses, so
 * the message is the only channel we have to explain what went wrong.
 */
function gitError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
