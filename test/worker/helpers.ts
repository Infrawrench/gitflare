import { env } from 'cloudflare:test'
import type { Env } from '~/server/env'

/**
 * Test fixtures against a real D1 database.
 *
 * These exist to cover the SQL that the pure unit tests cannot: the joins in
 * `resolveAccess` decide who can see and write to a repository, and a mistake
 * there is a security bug that a resolver-level test would never catch.
 */

/**
 * `cloudflare:test` types `env` as the global `Cloudflare.Env`, which only has
 * real members once `wrangler types` has generated worker-configuration.d.ts.
 * That file is 550KB of runtime declarations that duplicate
 * @cloudflare/workers-types, so rather than commit and maintain it, the cast is
 * made here, once. The bindings it names are checked against the Worker's own
 * Env, so a drift still fails to compile at every use site.
 */
export const testEnv = env as unknown as Env

/**
 * Clears every table between tests.
 *
 * The schema itself is applied once by `setup.ts` from the real migration files;
 * this only truncates. Order matters — foreign keys are enforced, so children
 * must go before parents.
 */
export async function resetDatabase(): Promise<void> {
  const tables = [
    'review_comments',
    'reviews',
    'pull_reviewers',
    'pull_requests',
    'comments',
    'issue_assignees',
    'issue_labels',
    'issues',
    'milestones',
    'labels',
    'ci_steps',
    'ci_runs',
    'release_assets',
    'releases',
    'webhook_deliveries',
    'webhooks',
    'notifications',
    'activity',
    'watches',
    'stars',
    'team_repos',
    'team_members',
    'teams',
    'repo_collaborators',
    'repos',
    'org_members',
    'ssh_keys',
    'access_tokens',
    'sessions',
    'users',
    'owners',
  ]
  for (const table of tables) {
    await testEnv.DB.exec(`DELETE FROM ${table}`)
  }
}

let counter = 0
function nextId(prefix: string): string {
  counter++
  return `${prefix}${String(counter).padStart(6, '0')}`
}

export async function createUser(
  login: string,
  options: { isAdmin?: boolean } = {},
): Promise<string> {
  const id = nextId('u')
  const now = Date.now()
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO owners (id, login, login_lower, kind, display_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'user', ?2, ?4, ?4)`,
    ).bind(id, login, login.toLowerCase(), now),
    testEnv.DB.prepare(
      `INSERT INTO users (owner_id, email, email_lower, is_admin) VALUES (?1, ?2, ?2, ?3)`,
    ).bind(id, `${login.toLowerCase()}@example.test`, options.isAdmin ? 1 : 0),
  ])
  return id
}

export async function createOrg(login: string): Promise<string> {
  const id = nextId('o')
  const now = Date.now()
  await testEnv.DB.prepare(
    `INSERT INTO owners (id, login, login_lower, kind, display_name, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'org', ?2, ?4, ?4)`,
  )
    .bind(id, login, login.toLowerCase(), now)
    .run()
  return id
}

export async function addOrgMember(
  orgId: string,
  userId: string,
  role: 'member' | 'owner',
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(orgId, userId, role, Date.now())
    .run()
}

export async function createRepo(
  ownerId: string,
  name: string,
  options: { visibility?: 'public' | 'private'; archived?: boolean } = {},
): Promise<string> {
  const id = nextId('r')
  const now = Date.now()
  await testEnv.DB.prepare(
    `INSERT INTO repos (id, owner_id, name, name_lower, visibility, archived, artifacts_name, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
  )
    .bind(
      id,
      ownerId,
      name,
      name.toLowerCase(),
      options.visibility ?? 'private',
      options.archived ? 1 : 0,
      `${id}--${name.toLowerCase()}`,
      now,
    )
    .run()
  return id
}

export async function addCollaborator(
  repoId: string,
  userId: string,
  permission: string,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO repo_collaborators (repo_id, user_id, permission, created_at) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(repoId, userId, permission, Date.now())
    .run()
}

export async function createTeam(
  orgId: string,
  name: string,
  permission: string,
  options: { allRepos?: boolean } = {},
): Promise<string> {
  const id = nextId('t')
  await testEnv.DB.prepare(
    `INSERT INTO teams (id, org_id, name, name_lower, permission, includes_all_repos, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, orgId, name, name.toLowerCase(), permission, options.allRepos ? 1 : 0, Date.now())
    .run()
  return id
}

export async function addTeamMember(teamId: string, userId: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO team_members (team_id, user_id, created_at) VALUES (?1, ?2, ?3)`,
  )
    .bind(teamId, userId, Date.now())
    .run()
}

export async function addTeamRepo(teamId: string, repoId: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO team_repos (team_id, repo_id, created_at) VALUES (?1, ?2, ?3)`,
  )
    .bind(teamId, repoId, Date.now())
    .run()
}

export async function createRun(
  repoId: string,
  number: number,
  options: {
    status?: string
    sha?: string
    branch?: string
    steps?: { name: string; status: string; exitCode?: number }[]
  } = {},
): Promise<string> {
  const id = nextId('run')
  const now = Date.now()
  await testEnv.DB.prepare(
    `INSERT INTO ci_runs (id, repo_id, number, workflow_instance_id, status, trigger, ref, branch, sha, commit_message, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'push', ?6, ?7, ?8, 'msg', ?9)`,
  )
    .bind(
      id,
      repoId,
      number,
      `wf-${id}`,
      options.status ?? 'success',
      `refs/heads/${options.branch ?? 'main'}`,
      options.branch ?? 'main',
      options.sha ?? 'a'.repeat(40),
      now,
    )
    .run()

  const steps = options.steps ?? []
  for (const [index, step] of steps.entries()) {
    await testEnv.DB.prepare(
      `INSERT INTO ci_steps (id, run_id, name, command, status, exit_code, needs, ordinal)
       VALUES (?1, ?2, ?3, 'cmd', ?4, ?5, '[]', ?6)`,
    )
      .bind(nextId('step'), id, step.name, step.status, step.exitCode ?? 0, index)
      .run()
  }
  return id
}
