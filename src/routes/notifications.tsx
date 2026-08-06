import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { NotificationReason, SubjectType } from '~/gen/forge/v1/notification_pb'
import { GateNotice } from '~/components/GateNotice'
import { relativeTime } from '~/lib/format'

export const Route = createFileRoute('/notifications')({
  validateSearch: (search: Record<string, unknown>): { all?: boolean } => ({
    ...(search.all === true || search.all === 'true' ? { all: true } : {}),
  }),
  component: Inbox,
})

function Inbox() {
  const { all = false } = Route.useSearch()
  const queryClient = useQueryClient()

  const inbox = useQuery({
    queryKey: ['notifications', all],
    queryFn: () => api.notification.listNotifications({ unreadOnly: !all, page: { limit: 50 } }),
  })

  const markAll = useMutation({
    mutationFn: () => api.notification.markNotifications({ all: true, unread: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  })

  const markOne = useMutation({
    mutationFn: (id: string) =>
      api.notification.markNotifications({ ids: [id], unread: false }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  })

  return (
    <>
      <div className="page-head">
        <h1>
          Notifications{' '}
          {inbox.data && inbox.data.unreadCount > 0 && (
            <span className="badge">{inbox.data.unreadCount} unread</span>
          )}
        </h1>
        <div className="tabs">
          <a href="/notifications" className={!all ? 'tab tab-active' : 'tab'}>
            Unread
          </a>
          <a href="/notifications?all=true" className={all ? 'tab tab-active' : 'tab'}>
            All
          </a>
          <button
            type="button"
            className="button"
            disabled={markAll.isPending || inbox.data?.unreadCount === 0}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </button>
        </div>
      </div>

      {inbox.isPending && <p className="muted">Loading…</p>}
      {inbox.isError && <GateNotice message={errorMessage(inbox.error)} />}
      {inbox.data?.notifications.length === 0 && (
        <p className="muted">{all ? 'Nothing here yet.' : 'No unread notifications.'}</p>
      )}

      <ul className="issue-list">
        {inbox.data?.notifications.map((item) => (
          <li key={item.id} className={item.unread ? 'issue-row notification-unread' : 'issue-row'}>
            <div>
              <a href={item.url} className="issue-title">
                {item.subjectTitle}
              </a>
              <div className="muted issue-meta">
                {icon(item.subjectType)} {item.repoFullName}
                {item.subjectRef && ` #${item.subjectRef}`} · {reasonLabel(item.reason)}
                {item.updatedAt && ` · ${relativeTime(item.updatedAt)}`}
              </div>
            </div>
            {item.unread && (
              <button type="button" className="button" onClick={() => markOne.mutate(item.id)}>
                Mark read
              </button>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}

function icon(type: SubjectType): string {
  switch (type) {
    case SubjectType.PULL_REQUEST:
      return '⑃'
    case SubjectType.CI_RUN:
      return '⚙'
    case SubjectType.RELEASE:
      return '🏷'
    default:
      return '◉'
  }
}

/** Why this landed in the inbox — the first thing people look for. */
function reasonLabel(reason: NotificationReason): string {
  switch (reason) {
    case NotificationReason.ASSIGN:
      return 'assigned to you'
    case NotificationReason.AUTHOR:
      return 'you opened this'
    case NotificationReason.COMMENT:
      return 'new comment'
    case NotificationReason.MENTION:
      return 'you were mentioned'
    case NotificationReason.REVIEW_REQUESTED:
      return 'review requested'
    case NotificationReason.CI_FAILURE:
      return 'build failed'
    default:
      return 'watching'
  }
}
