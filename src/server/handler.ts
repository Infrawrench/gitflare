import { ArtifactsClient } from './artifacts/client'
import { resolveViewer } from './auth/context'
import { findRepoForViewer, touchPushed } from './db/repos'
import type { Env } from './env'
import { ForgeError } from './errors'
import { handleConnect } from './connect'
import {
  handleGitRequest,
  matchGitRoute,
  requiredPermission,
  type GitAuthorization,
  type GitRoute,
} from './git/http'
import { handleAuthRoute, matchAuthRoute } from './auth/dev-login'
import { atLeast } from './auth/rbac'
import { emit, pushPayload } from './events/emit'
import { handleInternalSsh, matchInternalSshRoute } from './ssh/internal'

/**
 * Non-SSR request handling, in priority order:
 *
 *   1. git smart-HTTP  /:owner/:repo.git/...
 *   2. Connect/gRPC    /api/...
 *   3. raw file        /:owner/:repo/raw/:ref/*
 *
 * Returns null when nothing matches, so the caller can fall through to TanStack
 * Start's SSR handler. Git is checked first because its paths sit at the root of
 * the namespace and would otherwise be captured by a page route.
 */
export async function handleApiRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url)

  const gitRoute = matchGitRoute(url, request.method)
  if (gitRoute) {
    return handleGitRequest(gitRoute, request, {
      artifacts: new ArtifactsClient(env),
      authorize: (route) => authorizeGit(route, request, env),
      onPush: (auth) => recordPush(auth, env, ctx, url.origin),
      waitUntil: (promise) => ctx.waitUntil(promise),
    })
  }

  // Called by the SSH container, guarded by a shared secret. Checked before the
  // Connect router so it cannot be shadowed by a future /api route.
  const sshRoute = matchInternalSshRoute(url)
  if (sshRoute) return handleInternalSsh(sshRoute, request, env)

  // Sign-in and sign-out. Ahead of Connect so neither can be shadowed, and
  // ahead of SSR so the page renders without a client bundle.
  const authRoute = matchAuthRoute(url)
  if (authRoute) {
    const response = await handleAuthRoute(authRoute, request, env)
    if (response) return response
  }

  const connectResponse = await handleConnect(request, env, ctx)
  if (connectResponse) return connectResponse

  return handleRawFile(url, request, env)
}

/**
 * Resolves git access.
 *
 * Reports a repo the caller cannot see as not-found rather than forbidden: a
 * 403 would confirm a private repo exists to someone who should not know that.
 */
async function authorizeGit(route: GitRoute, request: Request, env: Env): Promise<GitAuthorization> {
  const viewer = await resolveViewer(request, env)
  const found = await findRepoForViewer(env.DB, route.owner, route.repo, {
    id: viewer.id,
    isSiteAdmin: viewer.isSiteAdmin,
  })

  if (!found) {
    // An anonymous caller gets a challenge instead, so a git client will prompt
    // for credentials rather than reporting a repo that may well exist.
    if (viewer.id === null) throw ForgeError.unauthenticated()
    throw ForgeError.notFound('Repository')
  }

  // Artifacts reports a repo as importing or forking until its objects land.
  // Serving git against one would hand the client an empty or partial history.
  if (found.repo.status !== 'ready') {
    throw new ForgeError(
      'failed_precondition',
      `This repository is still ${found.repo.status}. Try again in a moment.`,
    )
  }

  const needed = requiredPermission(route.service)
  if (!atLeast(found.access.permission, needed)) {
    if (viewer.id === null) throw ForgeError.unauthenticated()
    throw ForgeError.notFound('Repository')
  }

  return {
    permission: found.access.permission,
    canWrite: found.access.canWrite,
    userId: viewer.id,
    artifactsName: found.repo.artifacts_name,
    archived: found.repo.archived === 1,
  }
}

/**
 * Bookkeeping after a push. Runs in waitUntil, so it must not be relied on for
 * anything the client needs; CI is triggered by Artifacts' own event, not here.
 */
async function recordPush(
  auth: GitAuthorization,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
): Promise<void> {
  const repo = await env.DB.prepare(
    `SELECT r.id, r.owner_id, r.name, r.visibility, o.login AS owner_login
     FROM repos r JOIN owners o ON o.id = r.owner_id WHERE r.artifacts_name = ?1`,
  )
    .bind(auth.artifactsName)
    .first<{
      id: string
      owner_id: string
      name: string
      visibility: 'public' | 'private'
      owner_login: string
    }>()
  if (!repo) return

  await touchPushed(env.DB, repo.id)

  // The individual refs and SHAs are inside the packfile, which is streamed
  // straight through and never parsed here. Subscribers that need them should
  // read the repo; this says only that something landed.
  emit({ env, waitUntil: (promise) => ctx.waitUntil(promise), origin }, repo, 'push',
    pushPayload({ ref: '', before: '', after: '', pusherLogin: auth.userId }))
}

/**
 * Streams a file straight from Artifacts: `/:owner/:repo/raw/:ref/:path`.
 *
 * Exists because the Connect API inlines only small text blobs — images and
 * large files need a plain URL a browser can follow.
 */
async function handleRawFile(url: URL, request: Request, env: Env): Promise<Response | null> {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 5 || segments[2] !== 'raw') return null

  const [owner, repo, , ref, ...pathParts] = segments
  const viewer = await resolveViewer(request, env)
  const found = await findRepoForViewer(env.DB, owner!, repo!, {
    id: viewer.id,
    isSiteAdmin: viewer.isSiteAdmin,
  })
  if (!found) return new Response('Not found\n', { status: 404 })

  const file = await new ArtifactsClient(env).readFile(
    found.repo.artifacts_name,
    decodeURIComponent(ref!),
    pathParts.map(decodeURIComponent).join('/'),
  )
  if (!file) return new Response('Not found\n', { status: 404 })

  return new Response(file.bytes as BufferSource, {
    headers: {
      'Content-Type': file.contentType,
      // Repository content is attacker-controlled. Serving it inline on the app
      // origin would let a committed .html file run script with access to the
      // session cookie, so it is forced to download and sandboxed.
      'Content-Disposition': 'attachment',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      // Blobs are immutable when addressed by SHA; by branch they are not.
      'Cache-Control': /^[0-9a-f]{40}$/i.test(ref!)
        ? 'public, max-age=31536000, immutable'
        : 'private, max-age=0, must-revalidate',
    },
  })
}
