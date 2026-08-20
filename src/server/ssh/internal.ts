import type { Env } from '../env'
import { fingerprintSshKey, parseSshPublicKey } from '../auth/ssh-keys'
import { findRepoForViewer } from '../db/repos'
import { ArtifactsClient } from '../artifacts/client'
import { atLeast } from '../auth/rbac'
import { timingSafeEqual } from '../auth/tokens'
import { reconcileRepoStatus } from '../repo-status'

/**
 * The main Worker's half of the SSH contract.
 *
 * `ssh/authorized-keys-command.sh` and `ssh/git-shell-wrapper.sh` call these two
 * endpoints: the first to resolve an offered public key to a user, the second to
 * exchange that user and a repo for a short-lived Artifacts token.
 *
 * Keeping authorization here rather than in the container is the point. The
 * container holds no long-lived credential and no copy of the permission rules,
 * so SSH cannot become a way around the checks the web UI and HTTPS proxy apply.
 *
 * Both are guarded by a shared secret rather than a user credential, because the
 * caller is the container, not a person. They are not reachable from the public
 * internet in a correct deployment — but they are written as though they are.
 */

export function matchInternalSshRoute(url: URL): 'authorized-key' | 'authorize' | null {
  if (url.pathname === '/internal/ssh/authorized-key') return 'authorized-key'
  if (url.pathname === '/internal/ssh/authorize') return 'authorize'
  return null
}

export async function handleInternalSsh(
  route: 'authorized-key' | 'authorized' | 'authorize',
  request: Request,
  env: Env,
): Promise<Response> {
  const expected = (env as Env & { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN
  // Fail closed. An unset secret must not mean "no authentication required".
  if (!expected) {
    return json({ error: 'SSH support is not configured' }, 503)
  }

  const offered = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!timingSafeEqual(offered, expected)) {
    return json({ error: 'Unauthorized' }, 401)
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  return route === 'authorized-key'
    ? resolveKey(request, env)
    : authorizeRepo(request, env)
}

/**
 * Resolves an offered public key to a user id.
 *
 * sshd calls this on every connection. Looking the key up live is what makes
 * revoking one in the UI take effect immediately, with no file to regenerate.
 */
async function resolveKey(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { keyType?: string; publicKey?: string }
  if (!body.keyType || !body.publicKey) return json({ error: 'keyType and publicKey required' }, 400)

  let fingerprint: string
  try {
    fingerprint = await fingerprintSshKey(parseSshPublicKey(`${body.keyType} ${body.publicKey}`))
  } catch {
    // A malformed key is simply not a match; there is nothing to tell the caller
    // that would not also tell an attacker probing the endpoint.
    return json({}, 404)
  }

  const row = await env.DB.prepare(
    `SELECT k.id, k.user_id, k.read_only FROM ssh_keys k
     JOIN users u ON u.owner_id = k.user_id
     WHERE k.fingerprint = ?1 AND u.is_active = 1`,
  )
    .bind(fingerprint)
    .first<{ id: string; user_id: string; read_only: number }>()

  if (!row) return json({}, 404)

  // Recorded so the settings page can show when a key was last used, which is
  // how someone decides whether an old key is safe to remove.
  await env.DB.prepare(`UPDATE ssh_keys SET last_used_at = ?2 WHERE id = ?1`)
    .bind(row.id, Date.now())
    .run()

  return json({ userId: row.user_id, readOnly: row.read_only === 1 })
}

/**
 * Exchanges a user and repo for a repo-scoped Artifacts token.
 *
 * The same `requireRepo` path the web UI and HTTPS proxy use, so a key cannot
 * reach anything its owner could not reach through a browser.
 */
async function authorizeRepo(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    userId?: string
    repo?: string
    scope?: 'read' | 'write'
  }
  if (!body.userId || !body.repo) return json({ error: 'userId and repo required' }, 400)

  const [owner, name] = body.repo.split('/')
  if (!owner || !name) return json({ error: 'repo must be "owner/name"' }, 400)

  const user = await env.DB.prepare(
    `SELECT owner_id, is_admin FROM users WHERE owner_id = ?1 AND is_active = 1`,
  )
    .bind(body.userId)
    .first<{ owner_id: string; is_admin: number }>()
  if (!user) return json({}, 404)

  const found = await findRepoForViewer(env.DB, owner, name, {
    id: user.owner_id,
    isSiteAdmin: user.is_admin === 1,
  })
  // Indistinguishable from "no such repo", the same as every other surface.
  if (!found) return json({}, 404)

  const scope = body.scope === 'write' ? 'write' : 'read'
  if (scope === 'write' && !found.access.canWrite) return json({}, 403)
  if (!atLeast(found.access.permission, scope === 'write' ? 'write' : 'read')) {
    return json({}, 403)
  }
  const repo = await reconcileRepoStatus(env, found.repo)
  if (repo.status !== 'ready') {
    return json({ error: `Repository is still ${repo.status}` }, 409)
  }

  const artifacts = new ArtifactsClient(env)
  const token = await artifacts.mintToken(repo.artifacts_name, scope, 3600)

  return json({
    remote: artifacts.remoteFor(repo.artifacts_name),
    token,
    scope,
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
