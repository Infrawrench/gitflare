import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { RepoSort } from '~/gen/forge/v1/repo_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoCard } from '~/components/RepoCard'

export const Route = createFileRoute('/')({
  component: Home,
})

function Home() {
  const repos = useQuery({
    queryKey: ['repos', 'recent'],
    queryFn: () => api.repo.listRepos({ sort: RepoSort.UPDATED, page: { limit: 30 } }),
  })

  return (
    <>
      <div className="page-head">
        <h1>Repositories</h1>
        <Link to="/new" className="button button-primary">
          New repository
        </Link>
      </div>

      {repos.isPending && <p className="muted">Loading…</p>}

      {repos.isError && <GateNotice message={errorMessage(repos.error)} />}

      {repos.data?.repos.length === 0 && (
        <div className="notice">
          <h2>No repositories yet</h2>
          <p>
            <Link to="/new">Create one</Link> to get started, or import an existing repository from
            any git remote.
          </p>
        </div>
      )}

      <ul className="repo-list">
        {repos.data?.repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
      </ul>
    </>
  )
}
