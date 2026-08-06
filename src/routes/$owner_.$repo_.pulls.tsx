import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { PullState } from '~/gen/forge/v1/pull_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { relativeTime } from '~/lib/format'

export const Route = createFileRoute('/$owner_/$repo_/pulls')({
  validateSearch: (search: Record<string, unknown>): { state?: 'closed' | 'merged' } => ({
    ...(search.state === 'closed' || search.state === 'merged'
      ? { state: search.state as 'closed' | 'merged' }
      : {}),
  }),
  component: PullsPage,
})

function PullsPage() {
  const { owner, repo } = Route.useParams()
  const { state } = Route.useSearch()

  const pulls = useQuery({
    queryKey: ['pulls', owner, repo, state ?? 'open'],
    queryFn: () =>
      api.pull.listPulls({
        owner,
        repo,
        state:
          state === 'merged'
            ? PullState.MERGED
            : state === 'closed'
              ? PullState.CLOSED
              : PullState.OPEN,
        page: { limit: 50 },
      }),
  })

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="pulls" />

      <div className="page-head">
        <div className="tabs">
          <Link to="." search={{}} className={!state ? 'tab tab-active' : 'tab'}>
            {pulls.data ? `${pulls.data.openCount} open` : 'Open'}
          </Link>
          <Link
            to="."
            search={{ state: 'closed' }}
            className={state === 'closed' ? 'tab tab-active' : 'tab'}
          >
            {pulls.data ? `${pulls.data.closedCount} closed` : 'Closed'}
          </Link>
          <Link
            to="."
            search={{ state: 'merged' }}
            className={state === 'merged' ? 'tab tab-active' : 'tab'}
          >
            Merged
          </Link>
        </div>
      </div>

      <div className="notice">
        <p>
          Only <strong>fast-forward</strong> merges are supported. Creating a merge or squash commit
          means writing new git objects, and the Artifacts API has no way to do that from a Worker —
          so a diverged branch has to be rebased onto the base and pushed before it can be merged.
        </p>
      </div>

      {pulls.isPending && <p className="muted">Loading…</p>}
      {pulls.isError && <GateNotice message={errorMessage(pulls.error)} />}
      {pulls.data?.pulls.length === 0 && <p className="muted">No pull requests.</p>}

      <ul className="issue-list">
        {pulls.data?.pulls.map((pull) => (
          <li key={pull.id} className="issue-row">
            <div>
              <span className="issue-title">{pull.title}</span>
              {pull.draft && <span className="badge">Draft</span>}
              <div className="muted issue-meta">
                #{pull.number} · {pull.head?.branch} → {pull.base?.branch} · opened{' '}
                {pull.createdAt && relativeTime(pull.createdAt)} by {pull.author?.login}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
