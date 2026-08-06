import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  NotificationService,
  NotificationSchema,
  NotificationReason,
  SubjectType,
  ActivityEntrySchema,
  ListNotificationsResponseSchema,
  MarkNotificationsResponseSchema,
  ListActivityResponseSchema,
} from '~/gen/forge/v1/notification_pb'
import { PageResponseSchema } from '~/gen/forge/v1/common_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { ForgeError } from '../../errors'
import { contextFrom, type RequestContext } from '../router'

/**
 * In-app notifications and activity feeds.
 *
 * Notifications are per-user and always self-scoped — there is no path here that
 * reads or writes someone else's, which is why no method takes a user argument.
 *
 * Activity is the public counterpart: it describes what happened in a repo, and
 * each row carries the repo's visibility at write time so a feed can be filtered
 * without a join, and so an entry disappears if a repo later goes private.
 */

export function registerNotificationService(router: ConnectRouter): void {
  router.service(NotificationService, {
    async listNotifications(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewerId(ctx)

      const filters = ['n.user_id = ?1']
      const binds: unknown[] = [viewer]
      const bind = (value: unknown) => {
        binds.push(value)
        return `?${binds.length}`
      }

      if (request.unreadOnly) filters.push('n.unread = 1')
      if (request.repoFullName) {
        const [owner, name] = splitFullName(request.repoFullName)
        filters.push(
          `n.repo_id = (SELECT r.id FROM repos r JOIN owners o ON o.id = r.owner_id
                        WHERE o.login_lower = ${bind(owner)} AND r.name_lower = ${bind(name)})`,
        )
      }
      if (request.page?.cursor) filters.push(`n.id < ${bind(request.page.cursor)}`)

      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)

      const [rows, unread] = await Promise.all([
        ctx.env.DB.prepare(
          `SELECT n.*, o.login AS owner_login, r.name AS repo_name
           FROM notifications n
           JOIN repos r ON r.id = n.repo_id
           JOIN owners o ON o.id = r.owner_id
           WHERE ${filters.join(' AND ')}
           ORDER BY n.updated_at DESC, n.id DESC
           LIMIT ${bind(limit + 1)}`,
        )
          .bind(...binds)
          .all<NotificationRow>(),
        // The badge count ignores every filter: it is a property of the user,
        // not of whichever view they happen to be looking at.
        ctx.env.DB.prepare(
          `SELECT count(*) AS count FROM notifications WHERE user_id = ?1 AND unread = 1`,
        )
          .bind(viewer)
          .first<{ count: number }>(),
      ])

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      return create(ListNotificationsResponseSchema, {
        notifications: page.map(toNotification),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
        unreadCount: unread?.count ?? 0,
      })
    },

    async markNotifications(request, context) {
      const ctx = contextFrom(context.values)
      const viewer = requireViewerId(ctx)
      const unread = request.unread ? 1 : 0

      if (request.all) {
        await ctx.env.DB.prepare(`UPDATE notifications SET unread = ?2 WHERE user_id = ?1`)
          .bind(viewer, unread)
          .run()
      } else if (request.ids.length > 0) {
        // Always scoped by user_id: an id from someone else's inbox must not be
        // markable, and D1 has no per-row ownership to fall back on.
        const placeholders = request.ids.map((_, index) => `?${index + 3}`).join(', ')
        await ctx.env.DB.prepare(
          `UPDATE notifications SET unread = ?2 WHERE user_id = ?1 AND id IN (${placeholders})`,
        )
          .bind(viewer, unread, ...request.ids)
          .run()
      }

      const count = await ctx.env.DB.prepare(
        `SELECT count(*) AS count FROM notifications WHERE user_id = ?1 AND unread = 1`,
      )
        .bind(viewer)
        .first<{ count: number }>()

      return create(MarkNotificationsResponseSchema, { unreadCount: count?.count ?? 0 })
    },

    async listActivity(request, context) {
      const ctx = contextFrom(context.values)

      const filters: string[] = []
      const binds: unknown[] = []
      const bind = (value: unknown) => {
        binds.push(value)
        return `?${binds.length}`
      }

      if (request.repoFullName) {
        const [owner, name] = splitFullName(request.repoFullName)
        filters.push(
          `a.repo_id = (SELECT r.id FROM repos r JOIN owners o ON o.id = r.owner_id
                        WHERE o.login_lower = ${bind(owner)} AND r.name_lower = ${bind(name)})`,
        )
      } else if (request.userLogin) {
        filters.push(
          `a.actor_id = (SELECT id FROM owners WHERE login_lower = ${bind(request.userLogin.toLowerCase())})`,
        )
      } else if (request.orgLogin) {
        filters.push(
          `a.owner_id = (SELECT id FROM owners WHERE login_lower = ${bind(request.orgLogin.toLowerCase())})`,
        )
      } else {
        // The viewer's dashboard: everything they watch. An anonymous caller has
        // no watch list, so they get the public firehose instead of an error.
        if (ctx.viewer.id) {
          filters.push(
            `a.repo_id IN (SELECT repo_id FROM watches WHERE user_id = ${bind(ctx.viewer.id)})`,
          )
        }
      }

      // Visibility is recorded on the row at write time, so a repo that later
      // goes private stops appearing without a backfill.
      if (!ctx.viewer.isSiteAdmin) {
        if (ctx.viewer.id) {
          const viewer = bind(ctx.viewer.id)
          filters.push(`(
            a.is_public = 1
            OR EXISTS (SELECT 1 FROM repos r WHERE r.id = a.repo_id AND r.owner_id = ${viewer})
            OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = a.repo_id AND c.user_id = ${viewer})
          )`)
        } else {
          filters.push('a.is_public = 1')
        }
      }

      if (request.page?.cursor) filters.push(`a.id < ${bind(request.page.cursor)}`)
      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)

      const rows = await ctx.env.DB.prepare(
        `SELECT a.*, o.login AS actor_login, o.display_name AS actor_name, o.avatar_url AS actor_avatar,
                ro.login AS owner_login, r.name AS repo_name
         FROM activity a
         JOIN owners o ON o.id = a.actor_id
         LEFT JOIN repos r ON r.id = a.repo_id
         LEFT JOIN owners ro ON ro.id = r.owner_id
         ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
         ORDER BY a.id DESC
         LIMIT ${bind(limit + 1)}`,
      )
        .bind(...binds)
        .all<ActivityRow>()

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      return create(ListActivityResponseSchema, {
        entries: page.map(toActivity),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
      })
    },
  })
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface NotificationRow {
  id: string
  repo_id: string
  owner_login: string
  repo_name: string
  subject_type: string
  subject_title: string
  subject_ref: string
  reason: string
  unread: number
  url: string
  updated_at: number
}

interface ActivityRow {
  id: string
  actor_id: string
  actor_login: string
  actor_name: string
  actor_avatar: string
  owner_login: string | null
  repo_name: string | null
  action: string
  summary: string
  url: string
  created_at: number
}

function requireViewerId(ctx: RequestContext): string {
  if (!ctx.viewer.id) throw ForgeError.unauthenticated()
  return ctx.viewer.id
}

function splitFullName(fullName: string): [string, string] {
  const [owner = '', name = ''] = fullName.toLowerCase().split('/')
  return [owner, name]
}

function toNotification(row: NotificationRow) {
  return create(NotificationSchema, {
    id: row.id,
    repoFullName: `${row.owner_login}/${row.repo_name}`,
    subjectType: subjectType(row.subject_type),
    subjectTitle: row.subject_title,
    subjectRef: row.subject_ref,
    reason: reason(row.reason),
    unread: row.unread === 1,
    url: row.url,
    updatedAt: timestampFromDate(new Date(row.updated_at)),
  })
}

function toActivity(row: ActivityRow) {
  return create(ActivityEntrySchema, {
    id: row.id,
    actor: create(UserSchema, {
      id: row.actor_id,
      login: row.actor_login,
      displayName: row.actor_name || row.actor_login,
      avatarUrl: row.actor_avatar,
    }),
    action: row.action,
    // The repo may have been deleted since; the entry survives without it.
    repoFullName: row.owner_login && row.repo_name ? `${row.owner_login}/${row.repo_name}` : '',
    summary: row.summary,
    url: row.url,
    createdAt: timestampFromDate(new Date(row.created_at)),
  })
}

function subjectType(value: string): SubjectType {
  switch (value) {
    case 'issue':
      return SubjectType.ISSUE
    case 'pull_request':
      return SubjectType.PULL_REQUEST
    case 'release':
      return SubjectType.RELEASE
    case 'ci_run':
      return SubjectType.CI_RUN
    default:
      return SubjectType.UNSPECIFIED
  }
}

function reason(value: string): NotificationReason {
  const map: Record<string, NotificationReason> = {
    assign: NotificationReason.ASSIGN,
    author: NotificationReason.AUTHOR,
    comment: NotificationReason.COMMENT,
    mention: NotificationReason.MENTION,
    review_requested: NotificationReason.REVIEW_REQUESTED,
    watching: NotificationReason.WATCHING,
    ci_failure: NotificationReason.CI_FAILURE,
  }
  return map[value] ?? NotificationReason.UNSPECIFIED
}

export type { HandlerContext }
