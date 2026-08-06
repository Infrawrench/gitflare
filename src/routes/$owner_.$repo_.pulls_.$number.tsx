import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { MergeableState, MergeMethod, PullState } from '~/gen/forge/v1/pull_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { DiffView } from '~/components/DiffView'
import { commitSubject, relativeTime, shortSha } from '~/lib/format'

export const Route = createFileRoute('/$owner_/$repo_/pulls_/$number')({
  validateSearch: (search: Record<string, unknown>): { tab?: 'files' | 'commits' } => ({
    ...(search.tab === 'files' || search.tab === 'commits'
      ? { tab: search.tab as 'files' | 'commits' }
      : {}),
  }),
  component: PullPage,
})

function PullPage() {
  const { owner, repo, number } = Route.useParams()
  const { tab = 'files' } = Route.useSearch()
  const pullNumber = Number(number)
  const queryClient = useQueryClient()

  const pull = useQuery({
    queryKey: ['pull', owner, repo, pullNumber],
    queryFn: () => api.pull.getPull({ owner, repo, number: pullNumber }),
  })

  const diff = useQuery({
    queryKey: ['pull-diff', owner, repo, pullNumber],
    queryFn: () => api.pull.getPullDiff({ owner, repo, number: pullNumber, contextLines: 3 }),
    enabled: tab === 'files' && pull.isSuccess,
  })

  const commits = useQuery({
    queryKey: ['pull-commits', owner, repo, pullNumber],
    queryFn: () => api.pull.listPullCommits({ owner, repo, number: pullNumber }),
    enabled: tab === 'commits' && pull.isSuccess,
  })

  const merge = useMutation({
    mutationFn: () =>
      api.pull.mergePull({
        owner,
        repo,
        number: pullNumber,
        method: MergeMethod.REBASE,
        // Sent so the server refuses if the branch moved since this page loaded.
        ...(pull.data?.pull?.head?.sha ? { expectedHeadSha: pull.data.pull.head.sha } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['pull', owner, repo, pullNumber] }),
  })

  if (pull.isError) return <GateNotice message={errorMessage(pull.error)} />
  if (!pull.data?.pull) return <p className="muted">Loading…</p>

  const model = pull.data.pull

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="pulls" />

      <div className="page-head">
        <h2 className="issue-heading">
          {model.title} <span className="muted">#{model.number}</span>
        </h2>
      </div>

      <div className="issue-status">
        <span className={`state-badge ${stateClass(model.state)}`}>{stateLabel(model.state)}</span>
        <span className="muted">
          {model.author?.login} wants to merge <code>{model.head?.branch}</code> into{' '}
          <code>{model.base?.branch}</code>
        </span>
        {model.draft && <span className="badge">Draft</span>}
      </div>

      <MergeBox
        state={model.state}
        mergeable={model.mergeable}
        onMerge={() => merge.mutate()}
        pending={merge.isPending}
      />
      {merge.isError && <GateNotice message={errorMessage(merge.error)} />}

      <div className="tabs">
        <a href="?tab=files" className={tab === 'files' ? 'tab tab-active' : 'tab'}>
          Files changed
        </a>
        <a href="?tab=commits" className={tab === 'commits' ? 'tab tab-active' : 'tab'}>
          Commits
        </a>
      </div>

      {tab === 'files' && (
        <>
          {diff.isPending && <p className="muted">Loading diff…</p>}
          {diff.isError && <GateNotice message={errorMessage(diff.error)} />}
          {diff.data && <DiffView files={diff.data.files} truncated={diff.data.truncated} />}
        </>
      )}

      {tab === 'commits' && (
        <>
          {commits.isPending && <p className="muted">Loading commits…</p>}
          {commits.isError && <GateNotice message={errorMessage(commits.error)} />}
          <ul className="issue-list">
            {commits.data?.commits.map((commit) => (
              <li key={commit.sha} className="issue-row">
                <div>
                  <span className="issue-title">{commitSubject(commit.message)}</span>
                  <div className="muted issue-meta">
                    <code>{shortSha(commit.sha)}</code> · {commit.author?.name}
                    {commit.author?.time && ` · ${relativeTime(commit.author.time)}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * Merge affordance.
 *
 * Only fast-forward merges are possible, so a diverged branch gets an
 * explanation of what to do rather than a disabled button with no reason —
 * "Merge" being greyed out with no cause is the worst version of this.
 */
function MergeBox({
  state,
  mergeable,
  onMerge,
  pending,
}: {
  state: PullState
  mergeable: MergeableState
  onMerge: () => void
  pending: boolean
}) {
  if (state === PullState.MERGED) {
    return <div className="notice">This pull request has been merged.</div>
  }
  if (state === PullState.CLOSED) {
    return <div className="notice">This pull request is closed.</div>
  }

  if (mergeable === MergeableState.CLEAN) {
    return (
      <div className="notice merge-box">
        <p>This branch can be fast-forwarded onto the base.</p>
        <button type="button" className="button button-primary" disabled={pending} onClick={onMerge}>
          {pending ? 'Merging…' : 'Fast-forward merge'}
        </button>
      </div>
    )
  }

  if (mergeable === MergeableState.EMPTY) {
    return <div className="notice">There is nothing to merge — the branches are identical.</div>
  }

  if (mergeable === MergeableState.BEHIND) {
    return (
      <div className="notice notice-warning">
        <p>This branch is behind the base branch and has nothing new to contribute.</p>
      </div>
    )
  }

  if (mergeable === MergeableState.CONFLICTED) {
    return (
      <div className="notice notice-warning">
        <p>This branch has diverged from the base.</p>
        <p className="muted">
          Only fast-forward merges are supported — creating a merge commit means writing new git
          objects, and the Artifacts API cannot do that from a Worker. Rebase onto{' '}
          <code>base</code> and push, then merge again.
        </p>
      </div>
    )
  }

  return <div className="notice muted">Checking whether this branch can be merged…</div>
}

function stateLabel(state: PullState): string {
  return state === PullState.MERGED ? 'Merged' : state === PullState.CLOSED ? 'Closed' : 'Open'
}

function stateClass(state: PullState): string {
  return state === PullState.MERGED
    ? 'state-merged'
    : state === PullState.CLOSED
      ? 'state-closed'
      : 'state-open'
}
