import { Link } from '@tanstack/react-router'
import type { Repo } from '~/gen/forge/v1/repo_pb'
import { Visibility } from '~/gen/forge/v1/common_pb'
import { relativeTime } from '~/lib/format'

export function RepoCard({ repo }: { repo: Repo }) {
  const owner = repo.owner?.login ?? ''

  return (
    <li className="repo-card">
      <div className="repo-card-head">
        <h3>
          <Link to="/$owner/$repo" params={{ owner, repo: repo.name }}>
            {owner}/{repo.name}
          </Link>
        </h3>
        {repo.visibility === Visibility.PRIVATE && <span className="badge">Private</span>}
        {repo.isFork && <span className="badge">Fork</span>}
        {repo.archived && <span className="badge badge-muted">Archived</span>}
        {/* Artifacts reports importing/forking until objects land; git routes
            refuse until then, so saying so avoids a confusing empty repo. */}
        {repo.status !== 'ready' && <span className="badge badge-pending">{repo.status}…</span>}
      </div>

      {repo.description && <p className="repo-description">{repo.description}</p>}

      <div className="repo-meta muted">
        {repo.starCount > 0 && <span>★ {repo.starCount}</span>}
        {repo.forkCount > 0 && <span>⑂ {repo.forkCount}</span>}
        {repo.pushedAt && <span>Updated {relativeTime(repo.pushedAt)}</span>}
      </div>
    </li>
  )
}
