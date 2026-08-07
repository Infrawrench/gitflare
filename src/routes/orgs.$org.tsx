import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { api, errorMessage } from '~/lib/connect'
import { OrgRole } from '~/gen/forge/v1/org_pb'
import { Permission } from '~/gen/forge/v1/common_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoCard } from '~/components/RepoCard'

export const Route = createFileRoute('/orgs/$org')({
  component: OrgPage,
})

function OrgPage() {
  const { org } = Route.useParams()

  const details = useQuery({
    queryKey: ['org', org],
    queryFn: () => api.org.getOrg({ login: org }),
  })

  const members = useQuery({
    queryKey: ['org-members', org],
    queryFn: () => api.org.listOrgMembers({ orgLogin: org, page: { limit: 100 } }),
    enabled: details.isSuccess,
  })

  // Team names describe who can reach what, so they are member-only; a
  // non-member gets not-found and the section simply does not render.
  const teams = useQuery({
    queryKey: ['org-teams', org],
    queryFn: () => api.org.listTeams({ orgLogin: org }),
    enabled: details.data?.viewerRole !== OrgRole.UNSPECIFIED,
    retry: false,
  })

  const repos = useQuery({
    queryKey: ['repos', 'owner', org],
    queryFn: () => api.repo.listRepos({ owner: org, page: { limit: 50 } }),
    enabled: details.isSuccess,
  })

  if (details.isError) return <GateNotice message={errorMessage(details.error)} />
  if (!details.data?.org) return <p className="muted">Loading…</p>

  return (
    <>
      <div className="page-head">
        <h1>{details.data.org.displayName || details.data.org.login}</h1>
        {details.data.viewerRole === OrgRole.OWNER && <span className="badge">Owner</span>}
      </div>

      {details.data.org.description && (
        <p className="repo-description">{details.data.org.description}</p>
      )}

      <h2 className="section-heading">Repositories</h2>
      <ul className="repo-list">
        {repos.data?.repos.map((repo) => (
          <RepoCard key={repo.id} repo={repo} />
        ))}
      </ul>
      {repos.data?.repos.length === 0 && <p className="muted">No repositories you can see.</p>}

      <h2 className="section-heading">People</h2>
      <ul className="issue-list">
        {members.data?.members.map((member) => (
          <li key={member.user?.id} className="issue-row">
            <Link
              to="/$owner"
              params={{ owner: member.user?.login ?? '' }}
              className="issue-title"
            >
              {member.user?.login}
            </Link>
            {member.role === OrgRole.OWNER && <span className="badge">Owner</span>}
          </li>
        ))}
      </ul>

      {teams.data && teams.data.teams.length > 0 && (
        <>
          <h2 className="section-heading">Teams</h2>
          <ul className="issue-list">
            {teams.data.teams.map((team) => (
              <li key={team.id} className="issue-row">
                <div>
                  <span className="issue-title">{team.name}</span>
                  <div className="muted issue-meta">
                    {permissionLabel(team.permission)} ·{' '}
                    {team.includesAllRepos ? 'all repositories' : `${team.repoCount} repositories`} ·{' '}
                    {team.memberCount} members
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

function permissionLabel(permission: Permission): string {
  return (
    {
      [Permission.READ]: 'read',
      [Permission.TRIAGE]: 'triage',
      [Permission.WRITE]: 'write',
      [Permission.MAINTAIN]: 'maintain',
      [Permission.ADMIN]: 'admin',
    }[permission as number] ?? 'read'
  )
}
