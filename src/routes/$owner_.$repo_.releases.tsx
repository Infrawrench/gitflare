import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { formatBytes, relativeTime } from '~/lib/format'

export const Route = createFileRoute('/$owner_/$repo_/releases')({
  component: Releases,
})

function Releases() {
  const { owner, repo } = Route.useParams()

  const releases = useQuery({
    queryKey: ['releases', owner, repo],
    queryFn: () => api.release.listReleases({ owner, repo, includeDrafts: true, page: { limit: 30 } }),
  })

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="releases" />

      <div className="page-head">
        <h2>Releases</h2>
      </div>

      {releases.isPending && <p className="muted">Loading…</p>}
      {releases.isError && <GateNotice message={errorMessage(releases.error)} />}
      {releases.data?.releases.length === 0 && <p className="muted">No releases yet.</p>}

      {releases.data?.releases.map((release) => (
        <section key={release.id} className="release">
          <div className="release-head">
            <h3>{release.name || release.tagName}</h3>
            <code>{release.tagName}</code>
            {release.draft && <span className="badge">Draft</span>}
            {release.prerelease && <span className="badge">Pre-release</span>}
            {release.publishedAt && (
              <span className="muted">{relativeTime(release.publishedAt)}</span>
            )}
          </div>

          {release.body && <pre className="release-body">{release.body}</pre>}

          <ul className="asset-list">
            {release.assets.map((asset) => (
              <li key={asset.id}>
                <a href={asset.downloadUrl}>{asset.name}</a>
                <span className="muted">
                  {formatBytes(asset.size)} · {asset.downloadCount} downloads
                </span>
              </li>
            ))}
            {/* Source archives are generated from the tag's tree rather than
                stored, so they are always available. */}
            <li>
              <a href={release.tarballUrl}>Source code (tar.gz)</a>
            </li>
            <li>
              <a href={release.zipballUrl}>Source code (zip)</a>
            </li>
          </ul>
        </section>
      ))}
    </>
  )
}
