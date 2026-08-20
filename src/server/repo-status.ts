import { ArtifactsClient } from './artifacts/client'
import type { RepoRow } from './db/repos'
import type { Env } from './env'

/**
 * Settles a repo that is still importing or forking.
 *
 * `ImportRepo` and `ForkRepo` return as soon as Artifacts accepts the job, so
 * the row lands as 'importing' or 'forking' and the objects arrive some seconds
 * later. Artifacts offers no completion callback, so nothing was ever going to
 * write 'ready' on its own — the row stayed non-ready indefinitely and every git
 * route refused the repo with "try again in a moment", which never came.
 *
 * Reconciling on read rather than polling costs nothing for repos that are
 * already ready, which is nearly all of them after the first hit, and one
 * binding call for the ones that are not — on a request that was about to talk
 * to Artifacts anyway.
 */
export async function reconcileRepoStatus(env: Env, repo: RepoRow): Promise<RepoRow> {
  if (repo.status === 'ready') return repo

  // Without the binding there is nothing to ask, and the gate error this would
  // otherwise raise is not worth failing an ordinary metadata read over.
  const artifacts = new ArtifactsClient(env)
  if (!artifacts.available) return repo

  // The only completion signal Artifacts gives: null while the job is in
  // flight, the repo once its objects have landed. A job that failed outright
  // also reads as null, so a genuinely broken import stays non-ready — which is
  // the honest answer, since there is nothing to serve.
  const settled = await artifacts.tryGetRepo(repo.artifacts_name)
  if (!settled) return repo

  await env.DB.prepare(`UPDATE repos SET status = 'ready', updated_at = ?2 WHERE id = ?1`)
    .bind(repo.id, Date.now())
    .run()

  return { ...repo, status: 'ready' }
}
