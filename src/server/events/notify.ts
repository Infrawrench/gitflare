import type { Env } from '../env'
import { newId } from '../ids'

/**
 * Writing notifications and activity rows.
 *
 * Both are best-effort and run through `waitUntil`: failing to record that
 * something happened must never fail the thing that happened.
 *
 * Recipients are resolved here rather than at read time so the rules live in one
 * place, and so a user who stops watching a repo keeps the notifications they
 * already had.
 */

export type Reason =
  | 'assign'
  | 'author'
  | 'comment'
  | 'mention'
  | 'review_requested'
  | 'watching'
  | 'ci_failure'

export interface NotifySubject {
  repoId: string
  type: 'issue' | 'pull_request' | 'release' | 'ci_run'
  /** Stable id for the thread, so repeat events update one row. */
  id: string
  title: string
  /** Issue or run number, tag name — whatever identifies it in a URL. */
  ref: string
  url: string
}

/**
 * Notifies everyone with a stake in a thread.
 *
 * The actor is always excluded: being told about your own action is noise, and
 * it is the single most common complaint about notification systems.
 */
export async function notifyThread(
  env: Env,
  params: {
    subject: NotifySubject
    actorId: string
    reason: Reason
    /** Explicit recipients — the issue author, assignees, requested reviewers. */
    userIds: string[]
    /** Also notify everyone watching the repo. */
    includeWatchers?: boolean
  },
): Promise<void> {
  const recipients = new Set(params.userIds.filter(Boolean))

  if (params.includeWatchers) {
    const watchers = await env.DB.prepare(`SELECT user_id FROM watches WHERE repo_id = ?1`)
      .bind(params.subject.repoId)
      .all<{ user_id: string }>()
    for (const row of watchers.results ?? []) recipients.add(row.user_id)
  }

  recipients.delete(params.actorId)
  if (recipients.size === 0) return

  const now = Date.now()

  // One row per user per subject: a busy thread bumps the existing row rather
  // than stacking a dozen entries for the same conversation. It is also marked
  // unread again, since there is something new to see.
  await env.DB.batch(
    [...recipients].map((userId) =>
      env.DB.prepare(
        `INSERT INTO notifications
           (id, user_id, repo_id, subject_type, subject_id, subject_title, subject_ref, reason, unread, url, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?10)
         ON CONFLICT (user_id, subject_type, subject_id) DO UPDATE SET
           unread = 1,
           reason = excluded.reason,
           subject_title = excluded.subject_title,
           updated_at = excluded.updated_at`,
      ).bind(
        newId(),
        userId,
        params.subject.repoId,
        params.subject.type,
        params.subject.id,
        params.subject.title,
        params.subject.ref,
        params.reason,
        params.subject.url,
        now,
      ),
    ),
  )
}

/** Everyone already involved in a thread: its author plus its assignees. */
export async function threadParticipants(env: Env, issueId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT author_id AS user_id FROM issues WHERE id = ?1
     UNION
     SELECT user_id FROM issue_assignees WHERE issue_id = ?1
     UNION
     SELECT author_id FROM comments WHERE issue_id = ?1`,
  )
    .bind(issueId)
    .all<{ user_id: string }>()
  return (rows.results ?? []).map((row) => row.user_id)
}

export async function recordActivity(
  env: Env,
  params: {
    actorId: string
    repoId: string
    ownerId: string
    action: string
    summary: string
    url: string
    isPublic: boolean
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO activity (id, actor_id, repo_id, owner_id, action, summary, url, is_public, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      newId(),
      params.actorId,
      params.repoId,
      params.ownerId,
      params.action,
      params.summary,
      params.url,
      params.isPublic ? 1 : 0,
      Date.now(),
    )
    .run()
}
