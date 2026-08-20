import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { IssueState } from '~/gen/forge/v1/issue_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { LabelChip } from '~/components/LabelChip'
import { relativeTime } from '~/lib/format'

/**
 * Issue list.
 *
 * The trailing underscore in the filename (`$repo_`) opts this route out of
 * nesting under `/$owner/$repo`, which renders a code browser and has no
 * <Outlet>. Without it the page would never appear.
 */
export const Route = createFileRoute('/$owner_/$repo_/issues')({
  validateSearch: (search: Record<string, unknown>): { state?: 'open' | 'closed'; q?: string } => ({
    ...(search.state === 'closed' ? { state: 'closed' as const } : {}),
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
  }),
  component: IssuesPage,
})

/** Shared so the loader and the component cannot drift on the key or the args. */
function issueList(owner: string, repo: string, state: 'open' | 'closed', q?: string) {
  return {
    queryKey: ['issues', owner, repo, state, q],
    queryFn: () =>
      api.issue.listIssues({
        owner,
        repo,
        state: state === 'closed' ? IssueState.CLOSED : IssueState.OPEN,
        ...(q ? { query: q } : {}),
        page: { limit: 50 },
      }),
  }
}

function IssuesPage() {
  const { owner, repo } = Route.useParams()
  const { state = 'open', q } = Route.useSearch()

  const issues = useQuery(issueList(owner, repo, state, q))

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="issues" />

      <div className="page-head">
        <div className="tabs">
          {/* Counts come from the response and ignore the state filter, so both
              tabs show a total regardless of which one is open. */}
          <Link to="." search={{}} className={state === 'open' ? 'tab tab-active' : 'tab'}>
            {issues.data ? `${issues.data.openCount} open` : 'Open'}
          </Link>
          <Link
            to="."
            search={{ state: 'closed' }}
            className={state === 'closed' ? 'tab tab-active' : 'tab'}
          >
            {issues.data ? `${issues.data.closedCount} closed` : 'Closed'}
          </Link>
        </div>
        <Link to="/$owner/$repo/issues/new" params={{ owner, repo }} className="button button-primary">
          New issue
        </Link>
      </div>

      {issues.isPending && <p className="muted">Loading…</p>}
      {issues.isError && <GateNotice message={errorMessage(issues.error)} />}
      {issues.data?.issues.length === 0 && (
        <p className="muted">No {state} issues.</p>
      )}

      <ul className="issue-list">
        {issues.data?.issues.map((issue) => (
          <li key={issue.id} className="issue-row">
            <div>
              <Link
                to="/$owner/$repo/issues/$number"
                params={{ owner, repo, number: String(issue.number) }}
                className="issue-title"
              >
                {issue.title}
              </Link>
              {issue.labels.map((label) => (
                <LabelChip key={label.id} label={label} />
              ))}
              <div className="muted issue-meta">
                #{issue.number} opened {issue.createdAt && relativeTime(issue.createdAt)} by{' '}
                {issue.author?.login}
              </div>
            </div>
            {issue.commentCount > 0 && <span className="muted">💬 {issue.commentCount}</span>}
          </li>
        ))}
      </ul>
    </>
  )
}
