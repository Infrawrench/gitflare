import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { RepoSort } from '~/gen/forge/v1/repo_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoCard } from '~/components/RepoCard'

export const Route = createFileRoute('/$owner')({
  component: OwnerPage,
})

function OwnerPage() {
  const { owner } = Route.useParams()

  const repos = useQuery({
    queryKey: ['repos', 'owner', owner],
    queryFn: () => api.repo.listRepos({ owner, sort: RepoSort.UPDATED, page: { limit: 50 } }),
  })

  return (
    <>
      <div className="page-head">
        <h1>{owner}</h1>
      </div>

      {repos.isPending && <p className="muted">Loading…</p>}
      {repos.isError && <GateNotice message={errorMessage(repos.error)} />}

      {repos.data?.repos.length === 0 && (
        <p className="muted">No repositories here that you can see.</p>
      )}

      <ul className="repo-list">
        {repos.data?.repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
      </ul>
    </>
  )
}
