import type { Env } from '../env'
import type { RepoRow } from '../db/repos'
import { dispatchEvent } from './webhooks'

/**
 * Event payload builders and the one place that fires them.
 *
 * Every emit is fire-and-forget through `waitUntil`: a webhook subscriber must
 * never be able to slow down or fail the action that triggered it. Failures are
 * swallowed here and recorded as delivery rows instead, which is where someone
 * debugging an integration will actually look.
 */

export type ForgeEvent =
  | 'push'
  | 'issues'
  | 'issue_comment'
  | 'pull_request'
  | 'pull_request_review'
  | 'release'
  | 'ci_run'
  | 'repo'
  | 'star'
  | 'fork'
  | 'wiki'

interface EmitContext {
  env: Env
  waitUntil(promise: Promise<unknown>): void
  origin: string
}

/**
 * Queues an event for every hook that subscribes to it.
 *
 * Takes the repo row rather than ids so the payload can carry the names a
 * receiver needs without a second lookup.
 */
export function emit(
  ctx: EmitContext,
  repo: Pick<RepoRow, 'id' | 'owner_id' | 'name' | 'owner_login' | 'visibility'>,
  event: ForgeEvent,
  payload: Record<string, unknown>,
): void {
  const body = {
    event,
    repository: {
      id: repo.id,
      name: repo.name,
      fullName: `${repo.owner_login}/${repo.name}`,
      private: repo.visibility === 'private',
      url: `${ctx.origin}/${repo.owner_login}/${repo.name}`,
    },
    ...payload,
  }

  ctx.waitUntil(
    dispatchEvent(ctx.env, {
      repoId: repo.id,
      ownerId: repo.owner_id,
      event,
      payload: body,
    }).catch((error: unknown) => {
      // Nothing to do for the caller — the action already succeeded. Logged so a
      // broken queue binding is visible rather than silent.
      console.error('[events] dispatch failed', event, error)
    }),
  )
}

export function issuePayload(
  action: 'opened' | 'closed' | 'reopened' | 'edited',
  issue: { number: number; title: string; state: string; authorLogin: string },
): Record<string, unknown> {
  return { action, issue }
}

export function commentPayload(
  issue: { number: number; title: string },
  comment: { id: string; body: string; authorLogin: string },
): Record<string, unknown> {
  return { action: 'created', issue, comment }
}

export function pullPayload(
  action: 'opened' | 'closed' | 'merged' | 'reopened' | 'edited',
  pull: {
    number: number
    title: string
    state: string
    baseBranch: string
    headBranch: string
    authorLogin: string
    mergeCommitSha?: string
  },
): Record<string, unknown> {
  return { action, pullRequest: pull }
}

export function pushPayload(push: {
  ref: string
  before: string
  after: string
  pusherLogin: string | null
}): Record<string, unknown> {
  return push
}

export function runPayload(run: {
  number: number
  status: string
  sha: string
  branch?: string
  error?: string
}): Record<string, unknown> {
  return { action: run.status, run }
}
