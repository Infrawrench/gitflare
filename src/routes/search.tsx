import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { SearchKind } from '~/gen/forge/v1/search_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoCard } from '~/components/RepoCard'

const KINDS = [
  { kind: SearchKind.REPOS, label: 'Repositories', param: 'repos' },
  { kind: SearchKind.ISSUES, label: 'Issues', param: 'issues' },
  { kind: SearchKind.USERS, label: 'Users', param: 'users' },
] as const

export const Route = createFileRoute('/search')({
  validateSearch: (search: Record<string, unknown>): { q?: string; kind?: string } => ({
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
    ...(typeof search.kind === 'string' ? { kind: search.kind } : {}),
  }),
  component: SearchPage,
})

function SearchPage() {
  const { q = '', kind = 'repos' } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [draft, setDraft] = useState(q)

  const active = KINDS.find((entry) => entry.param === kind) ?? KINDS[0]

  const results = useQuery({
    queryKey: ['search', q, kind],
    queryFn: () => api.search.search({ query: q, kind: active.kind, page: { limit: 30 } }),
    // An empty query is rejected by the server; not asking is cheaper than
    // rendering an error the user has not caused yet.
    enabled: q.trim() !== '',
  })

  return (
    <>
      <div className="page-head">
        <h1>Search</h1>
      </div>

      <form
        className="repo-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          navigate({ search: { q: draft, kind } })
        }}
      >
        <input
          type="text"
          className="search-input"
          placeholder="Search repositories, issues, and users"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Search query"
        />
        <button type="submit" className="button button-primary">
          Search
        </button>
      </form>

      <div className="tabs">
        {KINDS.map((entry) => (
          <Link
            key={entry.param}
            to="/search"
            search={{ ...(q ? { q } : {}), kind: entry.param }}
            className={entry.param === kind ? 'tab tab-active' : 'tab'}
          >
            {entry.label}
          </Link>
        ))}
      </div>

      {q.trim() === '' && <p className="muted">Enter a query to search.</p>}
      {results.isPending && q.trim() !== '' && <p className="muted">Searching…</p>}
      {results.isError && <GateNotice message={errorMessage(results.error)} />}

      {results.data && (
        <>
          {active.kind === SearchKind.REPOS && (
            <ul className="repo-list">
              {results.data.repos.map((repo) => (
                <RepoCard key={repo.id} repo={repo} />
              ))}
            </ul>
          )}

          {active.kind === SearchKind.ISSUES && (
            <ul className="issue-list">
              {results.data.issues.map((issue) => (
                <li key={issue.id} className="issue-row">
                  <div>
                    <span className="issue-title">{issue.title}</span>
                    <div className="muted issue-meta">
                      #{issue.number} · {issue.author?.login}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {active.kind === SearchKind.USERS && (
            <ul className="issue-list">
              {results.data.users.map((user) => (
                <li key={user.id} className="issue-row">
                  <Link to="/$owner" params={{ owner: user.login }} className="issue-title">
                    {user.login}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {isEmpty(results.data, active.kind) && (
            <p className="muted">No {active.label.toLowerCase()} matched “{q}”.</p>
          )}

          {results.data.tookMs > 0 && (
            <p className="muted search-timing">Took {results.data.tookMs}ms</p>
          )}
        </>
      )}
    </>
  )
}

function isEmpty(
  data: { repos: unknown[]; issues: unknown[]; users: unknown[] },
  kind: SearchKind,
): boolean {
  if (kind === SearchKind.ISSUES) return data.issues.length === 0
  if (kind === SearchKind.USERS) return data.users.length === 0
  return data.repos.length === 0
}
