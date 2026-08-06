import { Link } from '@tanstack/react-router'

/** Tabs across a repository. `active` is passed rather than derived so each page
 *  stays a plain component with no route introspection. */
export function RepoNav({
  owner,
  repo,
  active,
}: {
  owner: string
  repo: string
  active: 'code' | 'issues' | 'pulls' | 'ci'
}) {
  return (
    <>
      <h1 className="repo-heading">
        <Link to="/$owner" params={{ owner }}>
          {owner}
        </Link>
        <span className="muted"> / </span>
        <Link to="/$owner/$repo" params={{ owner, repo }} search={{}}>
          {repo}
        </Link>
      </h1>
      <nav className="repo-nav">
        <Link
          to="/$owner/$repo"
          params={{ owner, repo }}
          search={{}}
          className={active === 'code' ? 'tab tab-active' : 'tab'}
        >
          Code
        </Link>
        <Link
          to="/$owner/$repo/issues"
          params={{ owner, repo }}
          search={{}}
          className={active === 'issues' ? 'tab tab-active' : 'tab'}
        >
          Issues
        </Link>
        <Link
          to="/$owner/$repo/pulls"
          params={{ owner, repo }}
          search={{}}
          className={active === 'pulls' ? 'tab tab-active' : 'tab'}
        >
          Pull requests
        </Link>
        <Link
          to="/$owner/$repo/ci"
          params={{ owner, repo }}
          search={{}}
          className={active === 'ci' ? 'tab tab-active' : 'tab'}
        >
          CI
        </Link>
      </nav>
    </>
  )
}
