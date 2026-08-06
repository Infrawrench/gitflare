import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { RunStatus, type Run } from '~/gen/forge/v1/ci_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { RunStatusBadge } from '~/components/RunStatusBadge'
import { commitSubject, relativeTime, shortSha } from '~/lib/format'

export const Route = createFileRoute('/$owner_/$repo_/ci')({
  component: RunsPage,
})

function RunsPage() {
  const { owner, repo } = Route.useParams()

  const runs = useQuery({
    queryKey: ['runs', owner, repo],
    queryFn: () => api.ci.listRuns({ owner, repo, page: { limit: 50 } }),
    // A run in progress changes on its own; the list refreshes so the status
    // badge does not go stale while someone is watching.
    refetchInterval: (query) =>
      query.state.data?.runs.some(isActive) ? 5_000 : false,
  })

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="ci" />

      <div className="page-head">
        <h2>Pipelines</h2>
      </div>

      {runs.isPending && <p className="muted">Loading…</p>}
      {runs.isError && <GateNotice message={errorMessage(runs.error)} />}

      {runs.data?.runs.length === 0 && (
        <div className="notice">
          <h2>No runs yet</h2>
          <p>
            Add a <code>.gitflare/ci.ts</code> to this repository and push. The file is evaluated
            inside the build container, never on the server.
          </p>
        </div>
      )}

      <ul className="issue-list">
        {runs.data?.runs.map((run) => (
          <li key={run.id} className="issue-row">
            <div>
              <Link
                to="/$owner/$repo/ci/$number"
                params={{ owner, repo, number: String(run.number) }}
                className="issue-title"
              >
                {commitSubject(run.commitMessage) || `Run #${run.number}`}
              </Link>
              <div className="muted issue-meta">
                <RunStatusBadge status={run.status} /> #{run.number} ·{' '}
                <code>{shortSha(run.sha)}</code>
                {run.branch && ` · ${run.branch}`}
                {run.createdAt && ` · ${relativeTime(run.createdAt)}`}
              </div>
            </div>
            <span className="muted">{run.steps.length} steps</span>
          </li>
        ))}
      </ul>
    </>
  )
}

function isActive(run: Run): boolean {
  return run.status === RunStatus.QUEUED || run.status === RunStatus.RUNNING
}
