import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { EntryType, type TreeEntry } from '~/gen/forge/v1/git_pb'
import { RefKind } from '~/gen/forge/v1/common_pb'
import { GateNotice } from '~/components/GateNotice'
import { CloneBox } from '~/components/CloneBox'
import { commitSubject, formatBytes, relativeTime, shortSha } from '~/lib/format'

/**
 * Repository code browser.
 *
 * `ref` and `path` are search params rather than path segments deliberately.
 * GitHub's `/tree/:ref/*path` layout is ambiguous — a branch named `feat/api`
 * and the path `api` under branch `feat` produce the same URL — and resolving it
 * needs a ref list on every request. Search params sidestep that entirely.
 */
interface RepoSearch {
  /** Branch, tag, or commit SHA. Defaults to the repo's default branch. */
  ref?: string
  /** Directory being browsed. */
  path?: string
  /** File being viewed; mutually exclusive with `path`. */
  file?: string
}

export const Route = createFileRoute('/$owner_/$repo')({
  // Keys are omitted rather than set to undefined so the inferred type has
  // genuinely optional properties. Returning `{ ref: undefined }` would give
  // required keys with undefined values, which forces every <Link> in the app to
  // restate all three.
  validateSearch: (search: Record<string, unknown>): RepoSearch => ({
    ...(typeof search.ref === 'string' ? { ref: search.ref } : {}),
    ...(typeof search.path === 'string' ? { path: search.path } : {}),
    ...(typeof search.file === 'string' ? { file: search.file } : {}),
  }),
  component: RepoPage,
})

function RepoPage() {
  const { owner, repo } = Route.useParams()
  const { ref, path = '', file } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const repoQuery = useQuery({
    queryKey: ['repo', owner, repo],
    queryFn: () => api.repo.getRepo({ owner, name: repo }),
  })

  const activeRef = ref ?? repoQuery.data?.repo?.defaultBranch ?? ''

  const refsQuery = useQuery({
    queryKey: ['refs', owner, repo],
    queryFn: () => api.git.listRefs({ owner, repo }),
    enabled: repoQuery.isSuccess,
  })

  const treeQuery = useQuery({
    queryKey: ['tree', owner, repo, activeRef, path],
    queryFn: () => api.git.getTree({ owner, repo, ref: activeRef, path, recursive: false }),
    enabled: repoQuery.isSuccess && activeRef !== '' && file === undefined,
  })

  const blobQuery = useQuery({
    queryKey: ['blob', owner, repo, activeRef, file],
    queryFn: () => api.git.getBlob({ owner, repo, ref: activeRef, path: file! }),
    enabled: repoQuery.isSuccess && activeRef !== '' && file !== undefined,
  })

  const commitsQuery = useQuery({
    queryKey: ['commits', owner, repo, activeRef],
    queryFn: () => api.git.listCommits({ owner, repo, ref: activeRef, limit: 1 }),
    enabled: repoQuery.isSuccess && activeRef !== '',
  })

  if (repoQuery.isError) return <GateNotice message={errorMessage(repoQuery.error)} />
  if (!repoQuery.data?.repo) return <p className="muted">Loading…</p>

  const model = repoQuery.data.repo
  const latest = commitsQuery.data?.commits[0]

  return (
    <>
      <div className="page-head">
        <h1>
          <Link to="/$owner" params={{ owner }}>
            {owner}
          </Link>
          <span className="muted"> / </span>
          {model.name}
        </h1>
      </div>

      {model.description && <p className="repo-description">{model.description}</p>}

      {model.status !== 'ready' && (
        <div className="notice notice-warning">
          This repository is still {model.status}. Git operations will fail until it is ready.
        </div>
      )}

      <div className="repo-toolbar">
        <select
          value={activeRef}
          onChange={(event) =>
            // Changing ref resets the path: the same path rarely exists on both
            // sides, and a stale one would render a confusing "not found".
            navigate({ search: { ref: event.target.value } })
          }
          aria-label="Branch or tag"
        >
          {refsQuery.data?.refs
            .filter((item) => item.kind === RefKind.BRANCH)
            .map((item) => (
              <option key={`b-${item.name}`} value={item.name}>
                {item.name}
                {item.isDefault ? ' (default)' : ''}
              </option>
            ))}
          {refsQuery.data?.refs.some((item) => item.kind === RefKind.TAG) && (
            <optgroup label="Tags">
              {refsQuery.data.refs
                .filter((item) => item.kind === RefKind.TAG)
                .map((item) => (
                  <option key={`t-${item.name}`} value={item.name}>
                    {item.name}
                  </option>
                ))}
            </optgroup>
          )}
        </select>

        <CloneBox cloneUrl={model.cloneUrl} sshUrl={model.sshUrl} />
      </div>

      {refsQuery.isError && <GateNotice message={errorMessage(refsQuery.error)} />}

      {latest && (
        <div className="commit-bar">
          <code>{shortSha(latest.sha)}</code>
          <span>{commitSubject(latest.message)}</span>
          <span className="muted">
            {latest.author?.name}
            {latest.author?.time && ` committed ${relativeTime(latest.author.time)}`}
          </span>
        </div>
      )}

      <Breadcrumbs owner={owner} repo={repo} path={file ?? path} isFile={file !== undefined} />

      {file !== undefined ? (
        <BlobView
          query={blobQuery}
          rawHref={`/${owner}/${repo}/raw/${encodeURIComponent(activeRef)}/${file}`}
        />
      ) : (
        <TreeView query={treeQuery} />
      )}
    </>
  )
}

function Breadcrumbs({
  owner,
  repo,
  path,
  isFile,
}: {
  owner: string
  repo: string
  path: string
  isFile: boolean
}) {
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) return null

  return (
    <nav className="breadcrumbs">
      <Link to="/$owner/$repo" params={{ owner, repo }} search={{}}>
        {repo}
      </Link>
      {segments.map((segment, index) => {
        const upto = segments.slice(0, index + 1).join('/')
        const last = index === segments.length - 1
        return (
          <span key={upto}>
            <span className="muted"> / </span>
            {last && isFile ? (
              <span>{segment}</span>
            ) : (
              <Link to="/$owner/$repo" params={{ owner, repo }} search={{ path: upto }}>
                {segment}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}

function TreeView({ query }: { query: { isPending: boolean; isError: boolean; error: unknown; data?: { entries: TreeEntry[]; truncated: boolean } } }) {
  const { owner, repo } = Route.useParams()
  const { ref } = Route.useSearch()

  if (query.isPending) return <p className="muted">Loading files…</p>
  if (query.isError) return <GateNotice message={errorMessage(query.error)} />
  if (!query.data) return null

  // Directories first, then files — each alphabetically, matching every other
  // file browser people use.
  const entries = [...query.data.entries].sort((a, b) => {
    const aDir = a.type === EntryType.DIR
    const bDir = b.type === EntryType.DIR
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      {query.data.truncated && (
        <p className="notice notice-warning">
          This listing was truncated because the tree exceeded the traversal budget.
        </p>
      )}
      <table className="tree">
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.sha + entry.path}>
              <td className="tree-icon">{iconFor(entry.type)}</td>
              <td>
                {entry.type === EntryType.SUBMODULE ? (
                  // A gitlink points into another repository; there is nothing
                  // to browse here.
                  <span title="Submodule">
                    {entry.name} <span className="muted">@ {shortSha(entry.sha)}</span>
                  </span>
                ) : (
                  <Link
                    to="/$owner/$repo"
                    params={{ owner, repo }}
                    search={
                      entry.type === EntryType.DIR
                        ? { ref, path: entry.path }
                        : { ref, file: entry.path }
                    }
                  >
                    {entry.name}
                  </Link>
                )}
              </td>
              <td className="muted tree-size">
                {entry.size !== undefined && entry.type === EntryType.FILE
                  ? formatBytes(entry.size)
                  : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function BlobView({
  query,
  rawHref,
}: {
  query: { isPending: boolean; isError: boolean; error: unknown; data?: { blob?: { text: string; isBinary: boolean; truncated: boolean; size: bigint; language: string } } }
  rawHref: string
}) {
  if (query.isPending) return <p className="muted">Loading file…</p>
  if (query.isError) return <GateNotice message={errorMessage(query.error)} />

  const blob = query.data?.blob
  if (!blob) return <p className="muted">Empty file.</p>

  if (blob.isBinary || blob.truncated) {
    return (
      <div className="notice">
        <p>
          {blob.isBinary ? 'Binary file' : 'File is too large to display'} —{' '}
          {formatBytes(blob.size)}.
        </p>
        <p>
          <a href={rawHref}>Download raw file</a>
        </p>
      </div>
    )
  }

  const lines = blob.text.split('\n')
  return (
    <div className="blob">
      <div className="blob-head muted">
        <span>
          {lines.length} lines · {formatBytes(blob.size)}
          {blob.language && ` · ${blob.language}`}
        </span>
        <a href={rawHref}>Raw</a>
      </div>
      {/* Line numbers live in a separate column so selecting the code does not
          also select them. */}
      <div className="blob-body">
        <pre className="line-numbers" aria-hidden="true">
          {lines.map((_, index) => `${index + 1}\n`).join('')}
        </pre>
        <pre className="blob-code">
          <code>{blob.text}</code>
        </pre>
      </div>
    </div>
  )
}

function iconFor(type: EntryType): string {
  switch (type) {
    case EntryType.DIR:
      return '📁'
    case EntryType.SUBMODULE:
      return '📦'
    case EntryType.SYMLINK:
      return '🔗'
    default:
      return '📄'
  }
}
