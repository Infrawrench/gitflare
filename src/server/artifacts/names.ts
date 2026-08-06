import { ForgeError } from '../errors'

/**
 * Artifacts repo names are flat within a namespace — there is no directory
 * structure — so `owner/repo` is encoded as `owner--repo`.
 *
 * That encoding is only unambiguous if neither half can contain the separator,
 * which is why `assertLogin` and `assertRepoName` reject consecutive hyphens.
 * Without that rule, owner `a--b` + repo `c` and owner `a` + repo `b--c` would
 * both encode to `a--b--c` and silently share git storage. GitHub and Gitea
 * disallow consecutive hyphens in usernames for their own reasons; here it is a
 * correctness requirement, so it is enforced rather than assumed.
 *
 * The mapping is also stored in `repos.artifacts_name` (unique), so the database
 * is the authority and this module only has to produce a stable candidate name.
 */

const SEPARATOR = '--'

/** Artifacts accepts alphanumerics, dots, hyphens, and underscores. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const MAX_SEGMENT = 64

// Reserved because they would shadow first-segment application routes.
const RESERVED_LOGINS = new Set([
  'api',
  'assets',
  'admin',
  'login',
  'logout',
  'signin',
  'signout',
  'settings',
  'new',
  'search',
  'explore',
  'notifications',
  'dashboard',
  'static',
  'favicon.ico',
  'robots.txt',
  '_build',
  '.well-known',
])

function assertSegment(value: string, kind: 'owner' | 'repository'): void {
  if (value.length === 0 || value.length > MAX_SEGMENT) {
    throw ForgeError.invalid(`${kind} name must be 1-${MAX_SEGMENT} characters`)
  }
  if (!NAME_PATTERN.test(value)) {
    throw ForgeError.invalid(
      `${kind} name may only contain letters, numbers, dots, hyphens, and underscores, and must start with a letter or number`,
    )
  }
  if (value.includes(SEPARATOR)) {
    throw ForgeError.invalid(`${kind} name may not contain consecutive hyphens`)
  }
  if (value.endsWith('.git')) {
    throw ForgeError.invalid(`${kind} name may not end in ".git"`)
  }
  if (value === '.' || value === '..') {
    throw ForgeError.invalid(`${kind} name is reserved`)
  }
}

export function assertLogin(login: string): void {
  assertSegment(login, 'owner')
  if (RESERVED_LOGINS.has(login.toLowerCase())) {
    throw ForgeError.invalid(`"${login}" is reserved`)
  }
}

export function assertRepoName(name: string): void {
  assertSegment(name, 'repository')
}

/** The Artifacts repo name backing `owner/repo`. */
export function artifactsName(owner: string, repo: string): string {
  assertLogin(owner)
  assertRepoName(repo)
  return `${owner.toLowerCase()}${SEPARATOR}${repo.toLowerCase()}`
}

/**
 * The sibling repo holding a repo's wiki. Cannot collide with a real repo:
 * `owner--repo--wiki` has three segments, and a repo literally named "wiki"
 * encodes to `owner--wiki`, which has two.
 */
export function wikiArtifactsName(owner: string, repo: string): string {
  return `${artifactsName(owner, repo)}${SEPARATOR}wiki`
}

/**
 * The git remote Artifacts serves for a repo. Format taken from @cloudflare/ci
 * (src/artifacts/source-control.ts), which builds the same URL to hand to git.
 */
export function artifactsRemote(accountId: string, namespace: string, name: string): string {
  if (!/^[a-f\d]{32}$/i.test(accountId)) {
    throw new ForgeError('internal', 'CLOUDFLARE_ACCOUNT_ID is missing or malformed')
  }
  return `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${name}.git`
}
