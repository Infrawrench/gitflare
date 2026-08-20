import { ARTIFACTS_GATE_MESSAGE, ForgeError, isArtifactsError, isArtifactsFeatureGate } from '../errors'
import { parseRefAdvertisement, resolveRefs, type ResolvedRefs } from '../git/refs'
import { artifactsRemote } from './names'

/**
 * One façade over the three different ways Artifacts data is reachable, because
 * no single one of them is sufficient:
 *
 *   Workers binding  repo lifecycle, tokens, and hash-addressed object reads
 *                    (log/readCommit/readTree — see augment.d.ts, these are
 *                    undeclared in the shipped types)
 *   REST API         file and blob *content*, which the binding cannot read
 *   git protocol     ref listing, which neither of the above exposes
 *
 * Callers should not have to know which is which, so everything funnels through
 * here and errors are normalized on the way out.
 */

export interface ArtifactsEnv {
  /**
   * Optional so the app can run without it.
   *
   * The Artifacts binding has no local simulation — `vite dev` opens a remote
   * proxy session for it, which fails outright on an account without beta
   * access ("You do not have access to use Artifacts", code 10015) and takes the
   * whole dev server down with it. wrangler.dev.jsonc therefore omits the
   * binding, and every method here reports the gate instead of crashing, so the
   * UI and all non-git features remain workable.
   */
  ARTIFACTS?: Artifacts
  ARTIFACTS_NAMESPACE: string
  CLOUDFLARE_ACCOUNT_ID: string
  CF_API_TOKEN: string
}

export interface FileContent {
  bytes: Uint8Array
  sha: string
  size: number
  contentType: string
}

/** Reads above this are served as a download link instead of inline content. */
export const MAX_INLINE_BLOB_BYTES = 1024 * 1024

export class ArtifactsClient {
  constructor(private readonly env: ArtifactsEnv) {}

  private get namespace(): string {
    return this.env.ARTIFACTS_NAMESPACE
  }

  /** True when git storage is reachable at all. */
  get available(): boolean {
    return this.env.ARTIFACTS !== undefined
  }

  /**
   * The binding, or the gate error. Centralized so a missing binding fails the
   * same way a gated account does — both mean "git storage is unavailable", and
   * the caller should not have to tell them apart.
   */
  private get binding(): Artifacts {
    if (!this.env.ARTIFACTS) throw featureGate('Artifacts binding is not configured')
    return this.env.ARTIFACTS
  }

  remoteFor(name: string): string {
    return artifactsRemote(this.env.CLOUDFLARE_ACCOUNT_ID, this.namespace, name)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async createRepo(
    name: string,
    opts: { description?: string; defaultBranch?: string } = {},
  ): Promise<ArtifactsCreateRepoResult> {
    return this.guard(() =>
      this.binding.create(name, {
        ...(opts.description === undefined ? {} : { description: opts.description }),
        ...(opts.defaultBranch === undefined ? {} : { setDefaultBranch: opts.defaultBranch }),
      }),
    )
  }

  async importRepo(params: {
    name: string
    url: string
    branch?: string
    depth?: number
    description?: string
  }): Promise<ArtifactsCreateRepoResult> {
    return this.guard(() =>
      this.binding.import({
        source: {
          url: params.url,
          ...(params.branch === undefined ? {} : { branch: params.branch }),
          ...(params.depth === undefined ? {} : { depth: params.depth }),
        },
        target: {
          name: params.name,
          ...(params.description === undefined ? {} : { opts: { description: params.description } }),
        },
      }),
    )
  }

  async forkRepo(
    source: string,
    target: string,
    opts: { description?: string; defaultBranchOnly?: boolean } = {},
  ): Promise<ArtifactsCreateRepoResult> {
    return this.guard(async () => {
      const repo = await this.binding.get(source)
      return repo.fork(target, {
        ...(opts.description === undefined ? {} : { description: opts.description }),
        // Artifacts defaults this to true; forking every ref is rarely wanted
        // and is markedly slower on a large repo.
        defaultBranchOnly: opts.defaultBranchOnly ?? true,
      })
    })
  }

  /** Returns false when the repo was already gone, which callers treat as success. */
  async deleteRepo(name: string): Promise<boolean> {
    return this.guard(() => this.binding.delete(name))
  }

  /**
   * Repo handle, or null when it does not exist. An in-progress import or fork
   * also yields null rather than throwing, since to a caller the repo is simply
   * not usable yet; `repos.status` in D1 records which of the two it is.
   */
  async tryGetRepo(name: string): Promise<ArtifactsRepo | null> {
    try {
      return await this.binding.get(name)
    } catch (error) {
      if (isArtifactsFeatureGate(error)) throw featureGate(error)
      if (isArtifactsError(error)) {
        if (error.code === 'NOT_FOUND') return null
        if (error.code === 'IMPORT_IN_PROGRESS' || error.code === 'FORK_IN_PROGRESS') return null
      }
      throw error
    }
  }

  async getRepo(name: string): Promise<ArtifactsRepo> {
    const repo = await this.tryGetRepo(name)
    if (!repo) throw ForgeError.notFound('Repository')
    return repo
  }

  // ── Tokens ─────────────────────────────────────────────────────────────────

  /**
   * Mints a short-lived, repo-scoped git token.
   *
   * These are the credentials the HTTPS proxy and the CI checkout both use. The
   * default hour is deliberate: long enough for a large clone, short enough that
   * a leaked token from a log or a crash dump expires on its own.
   */
  async mintToken(name: string, scope: 'read' | 'write', ttlSeconds = 3600): Promise<string> {
    return this.guard(async () => {
      const repo = await this.binding.get(name)
      const token = await repo.createToken(scope, ttlSeconds)
      return token.plaintext
    })
  }

  // ── Git objects (binding) ──────────────────────────────────────────────────

  /**
   * Commit history.
   *
   * The binding's `log` is undeclared in the shipped types, so its exact return
   * shape is not guaranteed. It was assumed to be `{ commits: [...] }`, which
   * produced a silently empty history against the real service — the wrong
   * shape reads as "no commits" rather than as an error. Both forms are handled
   * now, and anything else throws instead of pretending the repo is empty.
   */
  async log(
    name: string,
    opts: { ref?: string; limit?: number; offset?: number } = {},
  ): Promise<ArtifactsCommitObject[]> {
    return this.guard(async () => {
      const repo = await this.binding.get(name)
      const result: unknown = await repo.log(opts)

      if (result === null || result === undefined) return []
      if (Array.isArray(result)) return result as ArtifactsCommitObject[]
      if (typeof result === 'object' && Array.isArray((result as { commits?: unknown }).commits)) {
        return (result as { commits: ArtifactsCommitObject[] }).commits
      }
      throw new ForgeError(
        'internal',
        `Artifacts log() returned an unrecognized shape: ${JSON.stringify(result).slice(0, 200)}`,
      )
    })
  }

  async readCommit(name: string, sha: string): Promise<ArtifactsCommitObject | null> {
    return this.guard(async () => {
      const repo = await this.binding.get(name)
      return repo.readCommit(sha)
    })
  }

  async readTree(name: string, treeSha: string): Promise<ArtifactsTreeEntry[] | null> {
    return this.guard(async () => {
      const repo = await this.binding.get(name)
      return repo.readTree(treeSha)
    })
  }

  /**
   * Walks a commit's tree down to `path` and returns that level's entries.
   *
   * Each path segment costs one readTree call, since the binding reads a single
   * level at a time. Returns null when any segment is missing or names a blob.
   */
  async readTreeAtPath(
    name: string,
    commitSha: string,
    path: string,
  ): Promise<{ entries: ArtifactsTreeEntry[]; treeSha: string } | null> {
    const commit = await this.readCommit(name, commitSha)
    if (!commit) return null

    let treeSha = commit.treeHash
    const segments = path.split('/').filter(Boolean)

    for (const segment of segments) {
      const entries = await this.readTree(name, treeSha)
      if (!entries) return null
      const match = entries.find((entry) => entry.name === segment)
      if (!match || match.type !== 'tree') return null
      treeSha = match.hash
    }

    const entries = await this.readTree(name, treeSha)
    return entries ? { entries, treeSha } : null
  }

  // ── File content (REST) ────────────────────────────────────────────────────

  /**
   * Reads a file at a ref. The Workers binding has no blob-content read, so this
   * is the one operation that must go over the REST API.
   */
  async readFile(name: string, ref: string, path: string): Promise<FileContent | null> {
    const url = new URL(`${this.restBase(name)}/raw/${encodeURIComponent(ref)}/${encodePath(path)}`)
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
    })

    if (response.status === 404) return null
    if (!response.ok) throw await restError(response, `read ${path}@${ref}`)

    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      bytes,
      sha: response.headers.get('etag')?.replace(/"/g, '') ?? '',
      size: bytes.length,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  /** Reads a blob by its object hash, for diffing where the path may have moved. */
  async readBlob(name: string, sha: string): Promise<Uint8Array | null> {
    const response = await fetch(`${this.restBase(name)}/blob/${sha}`, {
      headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
    })
    if (response.status === 404) return null
    if (!response.ok) throw await restError(response, `read blob ${sha}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  // ── Refs (git protocol) ────────────────────────────────────────────────────

  /**
   * Lists branches and tags.
   *
   * Artifacts exposes no ref API, so this performs the git v0 ref-advertisement
   * handshake against the remote with a freshly minted read token. It is the
   * only supported way to enumerate refs, which is why the code browser's branch
   * switcher depends on it.
   */
  async listRefs(name: string): Promise<ResolvedRefs> {
    const token = await this.mintToken(name, 'read', 300)
    const url = `${this.remoteFor(name)}/info/refs?service=git-upload-pack`

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Omitting Git-Protocol keeps the server on v0, whose advertisement
        // arrives in the response body. v2 would require a follow-up ls-refs
        // request for the same information.
        'User-Agent': 'git/2.45.0 (gitflare)',
        Accept: 'application/x-git-upload-pack-advertisement',
      },
    })

    if (!response.ok) throw await restError(response, `list refs for ${name}`)
    const body = new Uint8Array(await response.arrayBuffer())
    return resolveRefs(parseRefAdvertisement(body))
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private restBase(name: string): string {
    const account = this.env.CLOUDFLARE_ACCOUNT_ID
    return `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces/${this.namespace}/repos/${encodeURIComponent(name)}`
  }

  /**
   * Converts the closed-beta feature gate into a message that says what to do,
   * rather than letting an opaque "Authentication error" reach the UI on every
   * git-backed route.
   */
  private async guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (isArtifactsFeatureGate(error)) throw featureGate(error)
      throw error
    }
  }
}

function featureGate(cause: unknown): ForgeError {
  return new ForgeError('failed_precondition', ARTIFACTS_GATE_MESSAGE, { cause })
}

/** Encodes each path segment but keeps the separators intact. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function restError(response: Response, action: string): Promise<ForgeError> {
  const body = await response.text().catch(() => '')
  if (/feature gate/i.test(body) || body.includes('10004')) return featureGate(body)
  if (response.status === 404) return ForgeError.notFound('Object')
  if (response.status === 401 || response.status === 403) {
    return new ForgeError(
      'internal',
      `Artifacts rejected the API token while trying to ${action}. Check that CF_API_TOKEN carries the Artifacts:Read permission.`,
    )
  }
  return new ForgeError('unavailable', `Artifacts request failed (${response.status}) while trying to ${action}`)
}
