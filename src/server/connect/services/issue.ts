import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  IssueService,
  IssueSchema,
  IssueState,
  CommentSchema,
  LabelSchema,
  MilestoneSchema,
  ListIssuesResponseSchema,
  GetIssueResponseSchema,
  CreateIssueResponseSchema,
  UpdateIssueResponseSchema,
  ListCommentsResponseSchema,
  CreateCommentResponseSchema,
  UpdateCommentResponseSchema,
  DeleteCommentResponseSchema,
  ListLabelsResponseSchema,
  CreateLabelResponseSchema,
  UpdateLabelResponseSchema,
  DeleteLabelResponseSchema,
  ListMilestonesResponseSchema,
  CreateMilestoneResponseSchema,
  UpdateMilestoneResponseSchema,
  DeleteMilestoneResponseSchema,
} from '~/gen/forge/v1/issue_pb'
import { PageResponseSchema } from '~/gen/forge/v1/common_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { nextIssueNumber, requireRepo, type RepoWithAccess } from '../../db/repos'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import { atLeast } from '../../auth/rbac'
import { contextFrom, type RequestContext } from '../router'
import { commentPayload, emit, issuePayload } from '../../events/emit'
import { notifyThread, recordActivity, threadParticipants } from '../../events/notify'
import { sanitizeFtsQuery } from './repo'

/**
 * Issue tracker.
 *
 * Issues and pull requests share the `issues` table and one per-repo number
 * sequence, so #12 identifies exactly one thing. Methods here operate on issues
 * by default; pull requests are reached through PullService, which reads the
 * same rows.
 *
 * None of this touches Artifacts, so the tracker keeps working while git storage
 * is unavailable.
 */

export function registerIssueService(router: ConnectRouter): void {
  router.service(IssueService, {
    async listIssues(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)

      const filters = ['i.repo_id = ?1']
      const binds: unknown[] = [found.repo.id]
      const bind = (value: unknown) => {
        binds.push(value)
        return `?${binds.length}`
      }

      // Defaults to issues only. Pull requests live in the same table, and a
      // caller that forgets this would see PRs mixed into the issue list.
      if (request.issuesOnly !== false) filters.push('i.is_pull = 0')
      if (request.state !== undefined && request.state !== IssueState.UNSPECIFIED) {
        filters.push(`i.state = ${bind(request.state === IssueState.OPEN ? 'open' : 'closed')}`)
      }
      if (request.author) {
        filters.push(`i.author_id = (SELECT id FROM owners WHERE login_lower = ${bind(request.author.toLowerCase())})`)
      }
      if (request.assignee) {
        filters.push(
          `EXISTS (SELECT 1 FROM issue_assignees a
                   JOIN owners o ON o.id = a.user_id
                   WHERE a.issue_id = i.id AND o.login_lower = ${bind(request.assignee.toLowerCase())})`,
        )
      }
      if (request.milestoneId) filters.push(`i.milestone_id = ${bind(request.milestoneId)}`)

      // Every requested label must be present, not just one of them — an AND,
      // which is what a label filter is universally taken to mean.
      for (const label of request.labels) {
        filters.push(
          `EXISTS (SELECT 1 FROM issue_labels il
                   JOIN labels l ON l.id = il.label_id
                   WHERE il.issue_id = i.id AND l.name_lower = ${bind(label.toLowerCase())})`,
        )
      }
      if (request.query) {
        filters.push(`i.rowid IN (SELECT f.rowid FROM issues_fts f WHERE issues_fts MATCH ${bind(sanitizeFtsQuery(request.query))})`)
      }

      const where = filters.join(' AND ')
      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)
      const cursorClause = request.page?.cursor ? ` AND i.id < ${bind(request.page.cursor)}` : ''

      const [rows, counts] = await Promise.all([
        ctx.env.DB.prepare(
          `SELECT i.*, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
           FROM issues i JOIN owners o ON o.id = i.author_id
           WHERE ${where}${cursorClause}
           ORDER BY i.id DESC LIMIT ${bind(limit + 1)}`,
        )
          .bind(...binds)
          .all<IssueRow>(),
        // Counts ignore the state filter so the UI can show both tab totals
        // regardless of which tab is open.
        ctx.env.DB.prepare(
          `SELECT
             COUNT(*) FILTER (WHERE state = 'open') AS open_count,
             COUNT(*) FILTER (WHERE state = 'closed') AS closed_count
           FROM issues WHERE repo_id = ?1 AND is_pull = ?2`,
        )
          .bind(found.repo.id, request.issuesOnly === false ? 1 : 0)
          .first<{ open_count: number; closed_count: number }>(),
      ])

      const results = rows.results ?? []
      const page = results.slice(0, limit)
      const decorated = await decorate(ctx, page)

      return create(ListIssuesResponseSchema, {
        issues: decorated,
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
        openCount: counts?.open_count ?? 0,
        closedCount: counts?.closed_count ?? 0,
      })
    },

    async getIssue(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findIssue(ctx, found.repo.id, request.number)
      const [issue] = await decorate(ctx, [row])
      return create(GetIssueResponseSchema, { issue: issue! })
    },

    async createIssue(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const author = requireViewerId(ctx)

      if (found.repo.has_issues !== 1) {
        throw new ForgeError('failed_precondition', 'Issues are disabled for this repository')
      }
      if (request.title.trim() === '') throw ForgeError.invalid('Issue title is required')

      // Anyone who can read may open an issue; that is what a tracker is for.
      const number = await nextIssueNumber(ctx.env.DB, found.repo.id)
      const id = newId()
      const now = Date.now()

      await ctx.env.DB.prepare(
        `INSERT INTO issues (id, repo_id, number, title, body, state, author_id, milestone_id, is_pull, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, 0, ?8, ?8)`,
      )
        .bind(id, found.repo.id, number, request.title, request.body, author, request.milestoneId || null, now)
        .run()

      // Labels and assignees are privileged: an outside reporter must not be
      // able to triage their own issue.
      if (atLeast(found.access.permission, 'triage')) {
        await applyLabels(ctx, id, found.repo.id, request.labelIds)
        await applyAssignees(ctx, id, request.assigneeLogins)
      }

      const row = await findIssue(ctx, found.repo.id, number)
      const [issue] = await decorate(ctx, [row])

      emit(ctx, found.repo, 'issues', issuePayload('opened', {
        number,
        title: request.title,
        state: 'open',
        authorLogin: ctx.viewer.login ?? '',
      }))

      const subject = issueSubject(found.repo, id, number, request.title, ctx.origin)
      ctx.waitUntil(
        Promise.all([
          notifyThread(ctx.env, {
            subject,
            actorId: author,
            reason: 'watching',
            userIds: request.assigneeLogins.length > 0 ? await resolveLogins(ctx, request.assigneeLogins) : [],
            includeWatchers: true,
          }),
          recordActivity(ctx.env, {
            actorId: author,
            repoId: found.repo.id,
            ownerId: found.repo.owner_id,
            action: 'open_issue',
            summary: request.title,
            url: subject.url,
            isPublic: found.repo.visibility === 'public',
          }),
        ]).catch(() => {}),
      )

      return create(CreateIssueResponseSchema, { issue: issue! })
    },

    async updateIssue(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const viewer = requireViewerId(ctx)
      const row = await findIssue(ctx, found.repo.id, request.number)

      const isAuthor = row.author_id === viewer
      const canTriage = atLeast(found.access.permission, 'triage')
      // Authors may edit their own text and close their own issue; changing
      // labels, assignees, or milestones is a triage action.
      if (!isAuthor && !canTriage) throw ForgeError.permissionDenied()

      const sets: string[] = []
      const binds: unknown[] = [row.id]
      const set = (column: string, value: unknown) => {
        binds.push(value)
        sets.push(`${column} = ?${binds.length}`)
      }

      if (request.title !== undefined) {
        if (request.title.trim() === '') throw ForgeError.invalid('Issue title is required')
        set('title', request.title)
      }
      if (request.body !== undefined) set('body', request.body)
      if (request.state !== undefined && request.state !== IssueState.UNSPECIFIED) {
        const state = request.state === IssueState.OPEN ? 'open' : 'closed'
        set('state', state)
        set('closed_at', state === 'closed' ? Date.now() : null)
      }
      if (request.locked !== undefined) {
        if (!canTriage) throw ForgeError.permissionDenied('Only maintainers can lock a thread')
        set('locked', request.locked ? 1 : 0)
      }
      if (request.clearMilestone) set('milestone_id', null)
      else if (request.milestoneId !== undefined) set('milestone_id', request.milestoneId)

      set('updated_at', Date.now())
      await ctx.env.DB.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?1`)
        .bind(...binds)
        .run()

      if (request.setLabels || request.setAssignees) {
        if (!canTriage) throw ForgeError.permissionDenied('Only maintainers can triage')
        if (request.setLabels) await applyLabels(ctx, row.id, found.repo.id, request.labelIds, true)
        if (request.setAssignees) await applyAssignees(ctx, row.id, request.assigneeLogins, true)
      }

      const updated = await findIssue(ctx, found.repo.id, request.number)
      const [issue] = await decorate(ctx, [updated])

      // Reopening and closing are the transitions integrations care about; a
      // body edit is reported as `edited` rather than not at all.
      const action =
        row.state === updated.state
          ? 'edited'
          : updated.state === 'closed'
            ? 'closed'
            : 'reopened'
      emit(ctx, found.repo, 'issues', issuePayload(action, {
        number: updated.number,
        title: updated.title,
        state: updated.state,
        authorLogin: updated.author_login,
      }))

      return create(UpdateIssueResponseSchema, { issue: issue! })
    },

    async listComments(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findIssue(ctx, found.repo.id, request.number)
      const limit = Math.min(Math.max(request.page?.limit || 50, 1), 100)

      const rows = await ctx.env.DB.prepare(
        `SELECT c.*, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
         FROM comments c JOIN owners o ON o.id = c.author_id
         WHERE c.issue_id = ?1 ${request.page?.cursor ? 'AND c.id > ?3' : ''}
         ORDER BY c.id ASC LIMIT ?2`,
      )
        .bind(...[row.id, limit + 1, ...(request.page?.cursor ? [request.page.cursor] : [])])
        .all<CommentRow>()

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      return create(ListCommentsResponseSchema, {
        comments: page.map(toComment),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
      })
    },

    async createComment(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const author = requireViewerId(ctx)
      const row = await findIssue(ctx, found.repo.id, request.number)

      // A locked thread still accepts maintainer replies, which is the point of
      // locking rather than closing.
      if (row.locked === 1 && !atLeast(found.access.permission, 'triage')) {
        throw new ForgeError('failed_precondition', 'This conversation is locked')
      }
      if (request.body.trim() === '') throw ForgeError.invalid('Comment body is required')

      const id = newId()
      const now = Date.now()
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO comments (id, issue_id, author_id, body, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
        ).bind(id, row.id, author, request.body, now),
        // Denormalized so the issue list can show a count without a join.
        ctx.env.DB.prepare(
          `UPDATE issues SET comment_count = comment_count + 1, updated_at = ?2 WHERE id = ?1`,
        ).bind(row.id, now),
      ])

      const created = await ctx.env.DB.prepare(
        `SELECT c.*, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
         FROM comments c JOIN owners o ON o.id = c.author_id WHERE c.id = ?1`,
      )
        .bind(id)
        .first<CommentRow>()

      emit(ctx, found.repo, 'issue_comment', commentPayload(
        { number: row.number, title: row.title },
        { id, body: request.body, authorLogin: ctx.viewer.login ?? '' },
      ))

      ctx.waitUntil(
        (async () => {
          // Everyone already in the conversation, not the whole watch list — a
          // reply is for the participants.
          const participants = await threadParticipants(ctx.env, row.id)
          await notifyThread(ctx.env, {
            subject: issueSubject(found.repo, row.id, row.number, row.title, ctx.origin),
            actorId: author,
            reason: 'comment',
            userIds: participants,
          })
        })().catch(() => {}),
      )

      return create(CreateCommentResponseSchema, { comment: toComment(created!) })
    },

    async updateComment(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewerId(ctx)

      const row = await ctx.env.DB.prepare(
        `SELECT c.*, i.repo_id, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
         FROM comments c
         JOIN issues i ON i.id = c.issue_id
         JOIN owners o ON o.id = c.author_id
         WHERE c.id = ?1`,
      )
        .bind(request.commentId)
        .first<CommentRow & { repo_id: string }>()

      if (!row) throw ForgeError.notFound('Comment')
      // Only the author may rewrite a comment. A maintainer can delete it, but
      // silently editing someone else's words is a different thing entirely.
      if (row.author_id !== viewer) throw ForgeError.permissionDenied()

      await ctx.env.DB.prepare(
        `UPDATE comments SET body = ?2, updated_at = ?3, edited = 1 WHERE id = ?1`,
      )
        .bind(request.commentId, request.body, Date.now())
        .run()

      return create(UpdateCommentResponseSchema, {
        comment: toComment({ ...row, body: request.body, edited: 1, updated_at: Date.now() }),
      })
    },

    async deleteComment(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewerId(ctx)

      const row = await ctx.env.DB.prepare(
        `SELECT c.author_id, c.issue_id, i.repo_id FROM comments c
         JOIN issues i ON i.id = c.issue_id WHERE c.id = ?1`,
      )
        .bind(request.commentId)
        .first<{ author_id: string; issue_id: string; repo_id: string }>()

      if (!row) throw ForgeError.notFound('Comment')

      if (row.author_id !== viewer) {
        // Not the author: fall back to a repo permission check.
        const access = await repoAccessById(ctx, row.repo_id)
        if (!atLeast(access, 'maintain')) throw ForgeError.permissionDenied()
      }

      await ctx.env.DB.batch([
        ctx.env.DB.prepare(`DELETE FROM comments WHERE id = ?1`).bind(request.commentId),
        ctx.env.DB.prepare(
          `UPDATE issues SET comment_count = MAX(0, comment_count - 1) WHERE id = ?1`,
        ).bind(row.issue_id),
      ])

      return create(DeleteCommentResponseSchema, {})
    },

    async listLabels(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const rows = await ctx.env.DB.prepare(
        `SELECT * FROM labels WHERE repo_id = ?1 ORDER BY name_lower`,
      )
        .bind(found.repo.id)
        .all<LabelRow>()
      return create(ListLabelsResponseSchema, { labels: (rows.results ?? []).map(toLabel) })
    },

    async createLabel(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo, 'triage')
      const id = newId()
      const color = normalizeColor(request.color)

      try {
        await ctx.env.DB.prepare(
          `INSERT INTO labels (id, repo_id, name, name_lower, color, description, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
          .bind(id, found.repo.id, request.name, request.name.toLowerCase(), color, request.description, Date.now())
          .run()
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ForgeError('already_exists', `A label named "${request.name}" already exists`)
        }
        throw error
      }

      return create(CreateLabelResponseSchema, {
        label: create(LabelSchema, {
          id,
          name: request.name,
          color,
          description: request.description,
        }),
      })
    },

    async updateLabel(request, context) {
      const ctx = contextFrom(context.values)
      const row = await ctx.env.DB.prepare(`SELECT * FROM labels WHERE id = ?1`)
        .bind(request.labelId)
        .first<LabelRow>()
      if (!row) throw ForgeError.notFound('Label')
      await requireRepoAccessById(ctx, row.repo_id, 'triage')

      const name = request.name ?? row.name
      const color = request.color !== undefined ? normalizeColor(request.color) : row.color
      const description = request.description ?? row.description

      await ctx.env.DB.prepare(
        `UPDATE labels SET name = ?2, name_lower = ?3, color = ?4, description = ?5 WHERE id = ?1`,
      )
        .bind(request.labelId, name, name.toLowerCase(), color, description)
        .run()

      return create(UpdateLabelResponseSchema, {
        label: create(LabelSchema, { id: row.id, name, color, description }),
      })
    },

    async deleteLabel(request, context) {
      const ctx = contextFrom(context.values)
      const row = await ctx.env.DB.prepare(`SELECT repo_id FROM labels WHERE id = ?1`)
        .bind(request.labelId)
        .first<{ repo_id: string }>()
      if (!row) throw ForgeError.notFound('Label')
      await requireRepoAccessById(ctx, row.repo_id, 'triage')

      // issue_labels cascades on delete, so assignments disappear with it.
      await ctx.env.DB.prepare(`DELETE FROM labels WHERE id = ?1`).bind(request.labelId).run()
      return create(DeleteLabelResponseSchema, {})
    },

    async listMilestones(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const state =
        request.state === IssueState.CLOSED ? 'closed' : request.state === IssueState.OPEN ? 'open' : null

      const rows = await ctx.env.DB.prepare(
        `SELECT m.*,
           (SELECT count(*) FROM issues WHERE milestone_id = m.id AND state = 'open') AS open_issues,
           (SELECT count(*) FROM issues WHERE milestone_id = m.id AND state = 'closed') AS closed_issues
         FROM milestones m
         WHERE m.repo_id = ?1 ${state ? 'AND m.state = ?2' : ''}
         ORDER BY m.due_on IS NULL, m.due_on, m.id`,
      )
        .bind(...[found.repo.id, ...(state ? [state] : [])])
        .all<MilestoneRow>()

      return create(ListMilestonesResponseSchema, {
        milestones: (rows.results ?? []).map(toMilestone),
      })
    },

    async createMilestone(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo, 'triage')
      const id = newId()

      await ctx.env.DB.prepare(
        `INSERT INTO milestones (id, repo_id, title, description, state, due_on, created_at)
         VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6)`,
      )
        .bind(
          id,
          found.repo.id,
          request.title,
          request.description,
          request.dueOn ? Number(request.dueOn.seconds) * 1000 : null,
          Date.now(),
        )
        .run()

      return create(CreateMilestoneResponseSchema, {
        milestone: create(MilestoneSchema, {
          id,
          title: request.title,
          description: request.description,
          state: IssueState.OPEN,
        }),
      })
    },

    async updateMilestone(request, context) {
      const ctx = contextFrom(context.values)
      const row = await ctx.env.DB.prepare(`SELECT * FROM milestones WHERE id = ?1`)
        .bind(request.milestoneId)
        .first<MilestoneRow>()
      if (!row) throw ForgeError.notFound('Milestone')
      await requireRepoAccessById(ctx, row.repo_id, 'triage')

      const state =
        request.state === IssueState.CLOSED
          ? 'closed'
          : request.state === IssueState.OPEN
            ? 'open'
            : row.state

      await ctx.env.DB.prepare(
        `UPDATE milestones SET title = ?2, description = ?3, state = ?4, due_on = ?5, closed_at = ?6 WHERE id = ?1`,
      )
        .bind(
          request.milestoneId,
          request.title ?? row.title,
          request.description ?? row.description,
          state,
          request.dueOn ? Number(request.dueOn.seconds) * 1000 : row.due_on,
          state === 'closed' ? (row.closed_at ?? Date.now()) : null,
        )
        .run()

      const updated = await ctx.env.DB.prepare(
        `SELECT m.*, 0 AS open_issues, 0 AS closed_issues FROM milestones m WHERE m.id = ?1`,
      )
        .bind(request.milestoneId)
        .first<MilestoneRow>()

      return create(UpdateMilestoneResponseSchema, { milestone: toMilestone(updated!) })
    },

    async deleteMilestone(request, context) {
      const ctx = contextFrom(context.values)
      const row = await ctx.env.DB.prepare(`SELECT repo_id FROM milestones WHERE id = ?1`)
        .bind(request.milestoneId)
        .first<{ repo_id: string }>()
      if (!row) throw ForgeError.notFound('Milestone')
      await requireRepoAccessById(ctx, row.repo_id, 'triage')

      // Issues keep existing; the schema nulls their milestone_id.
      await ctx.env.DB.prepare(`DELETE FROM milestones WHERE id = ?1`).bind(request.milestoneId).run()
      return create(DeleteMilestoneResponseSchema, {})
    },
  })
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface IssueRow {
  id: string
  repo_id: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  author_id: string
  author_login: string
  author_name: string
  author_avatar: string
  milestone_id: string | null
  is_pull: number
  locked: number
  comment_count: number
  created_at: number
  updated_at: number
  closed_at: number | null
}

interface CommentRow {
  id: string
  issue_id: string
  author_id: string
  author_login: string
  author_name: string
  author_avatar: string
  body: string
  created_at: number
  updated_at: number
  edited: number
}

interface LabelRow {
  id: string
  repo_id: string
  name: string
  color: string
  description: string
}

interface MilestoneRow {
  id: string
  repo_id: string
  title: string
  description: string
  state: 'open' | 'closed'
  due_on: number | null
  closed_at: number | null
  open_issues: number
  closed_issues: number
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function load(
  context: HandlerContext,
  owner: string,
  repo: string,
  required: 'read' | 'triage' = 'read',
): Promise<{ ctx: RequestContext; found: RepoWithAccess }> {
  const ctx = contextFrom(context.values)
  const found = await requireRepo(
    ctx.env.DB,
    owner,
    repo,
    { id: ctx.viewer.id, isSiteAdmin: ctx.viewer.isSiteAdmin },
    required === 'triage' ? 'triage' : 'read',
  )
  return { ctx, found }
}

/** Where a notification about an issue should point, and what identifies it. */
function issueSubject(
  repo: { id: string; name: string; owner_login: string },
  issueId: string,
  number: number,
  title: string,
  origin: string,
) {
  return {
    repoId: repo.id,
    type: 'issue' as const,
    id: issueId,
    title,
    ref: String(number),
    url: `${origin}/${repo.owner_login}/${repo.name}/issues/${number}`,
  }
}

async function resolveLogins(ctx: RequestContext, logins: string[]): Promise<string[]> {
  if (logins.length === 0) return []
  const placeholders = logins.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await ctx.env.DB.prepare(
    `SELECT id FROM owners WHERE login_lower IN (${placeholders})`,
  )
    .bind(...logins.map((login) => login.toLowerCase()))
    .all<{ id: string }>()
  return (rows.results ?? []).map((row) => row.id)
}

function requireViewerId(ctx: RequestContext): string {
  if (!ctx.viewer.id) throw ForgeError.unauthenticated()
  return ctx.viewer.id
}

async function findIssue(ctx: RequestContext, repoId: string, number: number): Promise<IssueRow> {
  const row = await ctx.env.DB.prepare(
    `SELECT i.*, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
     FROM issues i JOIN owners o ON o.id = i.author_id
     WHERE i.repo_id = ?1 AND i.number = ?2`,
  )
    .bind(repoId, number)
    .first<IssueRow>()
  if (!row) throw ForgeError.notFound(`Issue #${number}`)
  return row
}

/**
 * Attaches labels, assignees, and milestones.
 *
 * Fetched for the whole page in three queries rather than per issue — a list of
 * 30 issues would otherwise cost 90 round trips.
 */
async function decorate(ctx: RequestContext, rows: IssueRow[]) {
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ')

  const [labels, assignees, milestones] = await Promise.all([
    ctx.env.DB.prepare(
      `SELECT il.issue_id, l.* FROM issue_labels il JOIN labels l ON l.id = il.label_id
       WHERE il.issue_id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<LabelRow & { issue_id: string }>(),
    ctx.env.DB.prepare(
      `SELECT ia.issue_id, o.id, o.login, o.display_name, o.avatar_url
       FROM issue_assignees ia JOIN owners o ON o.id = ia.user_id
       WHERE ia.issue_id IN (${placeholders})`,
    )
      .bind(...ids)
      .all<{ issue_id: string; id: string; login: string; display_name: string; avatar_url: string }>(),
    ctx.env.DB.prepare(
      `SELECT m.*, 0 AS open_issues, 0 AS closed_issues FROM milestones m
       WHERE m.id IN (SELECT DISTINCT milestone_id FROM issues WHERE id IN (${placeholders}) AND milestone_id IS NOT NULL)`,
    )
      .bind(...ids)
      .all<MilestoneRow>(),
  ])

  const labelsByIssue = groupBy(labels.results ?? [], (row) => row.issue_id)
  const assigneesByIssue = groupBy(assignees.results ?? [], (row) => row.issue_id)
  const milestoneById = new Map((milestones.results ?? []).map((row) => [row.id, row]))

  return rows.map((row) => {
    const milestone = row.milestone_id ? milestoneById.get(row.milestone_id) : undefined
    return create(IssueSchema, {
      id: row.id,
      number: row.number,
      title: row.title,
      body: row.body,
      state: row.state === 'open' ? IssueState.OPEN : IssueState.CLOSED,
      author: create(UserSchema, {
        id: row.author_id,
        login: row.author_login,
        displayName: row.author_name || row.author_login,
        avatarUrl: row.author_avatar,
      }),
      labels: (labelsByIssue.get(row.id) ?? []).map(toLabel),
      assignees: (assigneesByIssue.get(row.id) ?? []).map((user) =>
        create(UserSchema, {
          id: user.id,
          login: user.login,
          displayName: user.display_name || user.login,
          avatarUrl: user.avatar_url,
        }),
      ),
      ...(milestone ? { milestone: toMilestone(milestone) } : {}),
      commentCount: row.comment_count,
      isPullRequest: row.is_pull === 1,
      locked: row.locked === 1,
      createdAt: timestampFromDate(new Date(row.created_at)),
      updatedAt: timestampFromDate(new Date(row.updated_at)),
      ...(row.closed_at ? { closedAt: timestampFromDate(new Date(row.closed_at)) } : {}),
    })
  })
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const group = map.get(key(row))
    if (group) group.push(row)
    else map.set(key(row), [row])
  }
  return map
}

async function applyLabels(
  ctx: RequestContext,
  issueId: string,
  repoId: string,
  labelIds: string[],
  replace = false,
): Promise<void> {
  const statements = []
  if (replace) {
    statements.push(ctx.env.DB.prepare(`DELETE FROM issue_labels WHERE issue_id = ?1`).bind(issueId))
  }
  for (const labelId of labelIds) {
    // Scoped by repo_id so a label from another repository cannot be attached.
    statements.push(
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO issue_labels (issue_id, label_id)
         SELECT ?1, id FROM labels WHERE id = ?2 AND repo_id = ?3`,
      ).bind(issueId, labelId, repoId),
    )
  }
  if (statements.length > 0) await ctx.env.DB.batch(statements)
}

async function applyAssignees(
  ctx: RequestContext,
  issueId: string,
  logins: string[],
  replace = false,
): Promise<void> {
  const statements = []
  if (replace) {
    statements.push(ctx.env.DB.prepare(`DELETE FROM issue_assignees WHERE issue_id = ?1`).bind(issueId))
  }
  for (const login of logins) {
    statements.push(
      ctx.env.DB.prepare(
        `INSERT OR IGNORE INTO issue_assignees (issue_id, user_id)
         SELECT ?1, owner_id FROM users
         JOIN owners ON owners.id = users.owner_id
         WHERE owners.login_lower = ?2`,
      ).bind(issueId, login.toLowerCase()),
    )
  }
  if (statements.length > 0) await ctx.env.DB.batch(statements)
}

async function repoAccessById(ctx: RequestContext, repoId: string) {
  const repo = await ctx.env.DB.prepare(
    `SELECT o.login AS owner, r.name FROM repos r JOIN owners o ON o.id = r.owner_id WHERE r.id = ?1`,
  )
    .bind(repoId)
    .first<{ owner: string; name: string }>()
  if (!repo) throw ForgeError.notFound('Repository')

  const found = await requireRepo(ctx.env.DB, repo.owner, repo.name, {
    id: ctx.viewer.id,
    isSiteAdmin: ctx.viewer.isSiteAdmin,
  })
  return found.access.permission
}

async function requireRepoAccessById(
  ctx: RequestContext,
  repoId: string,
  required: 'triage' | 'maintain',
): Promise<void> {
  const permission = await repoAccessById(ctx, repoId)
  if (!atLeast(permission, required)) throw ForgeError.permissionDenied()
}

function toLabel(row: LabelRow) {
  return create(LabelSchema, {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
  })
}

function toMilestone(row: MilestoneRow) {
  return create(MilestoneSchema, {
    id: row.id,
    title: row.title,
    description: row.description,
    state: row.state === 'open' ? IssueState.OPEN : IssueState.CLOSED,
    openIssues: row.open_issues ?? 0,
    closedIssues: row.closed_issues ?? 0,
    ...(row.due_on ? { dueOn: timestampFromDate(new Date(row.due_on)) } : {}),
  })
}

function toComment(row: CommentRow) {
  return create(CommentSchema, {
    id: row.id,
    author: create(UserSchema, {
      id: row.author_id,
      login: row.author_login,
      displayName: row.author_name || row.author_login,
      avatarUrl: row.author_avatar,
    }),
    body: row.body,
    // Rendering is done client-side; server-generated HTML from user input on
    // this path would need sanitizing we would rather not have to trust.
    bodyHtml: '',
    createdAt: timestampFromDate(new Date(row.created_at)),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    edited: row.edited === 1,
  })
}

/** Six hex digits, no leading '#'. Falls back to grey rather than rejecting. */
function normalizeColor(color: string): string {
  const cleaned = color.replace(/^#/, '').toLowerCase()
  return /^[0-9a-f]{6}$/.test(cleaned) ? cleaned : '888888'
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message)
}
