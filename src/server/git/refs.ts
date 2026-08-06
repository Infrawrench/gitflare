import { decodeLatin1, decodePktLines } from './pktline'

/**
 * Reads a repo's refs by speaking the git smart-HTTP protocol to the Artifacts
 * remote.
 *
 * This exists because Artifacts has no ref-listing API: the Workers binding
 * offers create/get/list/import/delete plus token and hash-addressed object
 * reads, and the REST API adds file and blob content, but neither can answer
 * "what branches does this repo have?". The git protocol can, so we ask it
 * directly and parse the advertisement.
 */

export interface GitRef {
  /** Full ref name, e.g. "refs/heads/main". */
  name: string
  sha: string
}

export interface RefAdvertisement {
  refs: GitRef[]
  /** Server capabilities from the first ref line. */
  capabilities: string[]
  /**
   * Branch HEAD points at, resolved from the `symref=HEAD:` capability. Null on
   * an empty repo, or if the server omitted the capability.
   */
  headRef: string | null
}

const ZERO_SHA = '0'.repeat(40)

/**
 * Parses the response body of `GET /info/refs?service=git-upload-pack`.
 *
 * The body opens with a `# service=` banner and a flush, then one packet per
 * ref: `<sha> <name>` with NUL-separated capabilities appended to the first.
 * An empty repo advertises a single zero-SHA `capabilities^{}` line, which is a
 * capability carrier rather than a real ref and is dropped.
 */
export function parseRefAdvertisement(body: Uint8Array): RefAdvertisement {
  const refs: GitRef[] = []
  let capabilities: string[] = []
  let sawBanner = false

  for (const line of decodePktLines(body)) {
    if (line.data === null) continue

    const text = decodeLatin1(line.data).replace(/\n$/, '')
    if (!sawBanner && text.startsWith('# service=')) {
      sawBanner = true
      continue
    }
    if (text === '') continue

    // Capabilities ride on the first ref line, after a NUL byte.
    const nul = text.indexOf('\0')
    const refPart = nul === -1 ? text : text.slice(0, nul)
    if (nul !== -1 && capabilities.length === 0) {
      capabilities = text
        .slice(nul + 1)
        .split(' ')
        .filter(Boolean)
    }

    const space = refPart.indexOf(' ')
    if (space === -1) continue
    const sha = refPart.slice(0, space)
    const name = refPart.slice(space + 1)
    if (!/^[0-9a-f]{40}$/.test(sha)) continue

    // An empty repo carries capabilities on a placeholder line rather than a ref.
    if (name === 'capabilities^{}' || sha === ZERO_SHA) continue

    refs.push({ name, sha })
  }

  const symref = capabilities.find((capability) => capability.startsWith('symref=HEAD:'))
  return {
    refs,
    capabilities,
    headRef: symref ? symref.slice('symref=HEAD:'.length) : null,
  }
}

export interface ResolvedRefs {
  branches: GitRef[]
  /** Annotated tags are collapsed onto the commit they peel to. */
  tags: GitRef[]
  headBranch: string | null
}

/**
 * Splits an advertisement into branches and tags.
 *
 * Annotated tags appear twice: `refs/tags/v1` pointing at the tag object, and
 * the peeled `refs/tags/v1^{}` pointing at the commit. Callers want the commit,
 * so a peeled entry replaces its unpeeled counterpart.
 */
export function resolveRefs(advertisement: RefAdvertisement): ResolvedRefs {
  const branches: GitRef[] = []
  const tags = new Map<string, GitRef>()

  for (const ref of advertisement.refs) {
    if (ref.name.startsWith('refs/heads/')) {
      branches.push({ name: ref.name.slice('refs/heads/'.length), sha: ref.sha })
      continue
    }
    if (!ref.name.startsWith('refs/tags/')) continue

    const raw = ref.name.slice('refs/tags/'.length)
    const peeled = raw.endsWith('^{}')
    const name = peeled ? raw.slice(0, -3) : raw
    // The peeled line always wins; order in the advertisement is not guaranteed.
    if (peeled || !tags.has(name)) tags.set(name, { name, sha: ref.sha })
  }

  branches.sort((a, b) => a.name.localeCompare(b.name))
  const head = advertisement.headRef
  return {
    branches,
    tags: [...tags.values()].sort((a, b) => b.name.localeCompare(a.name)),
    headBranch: head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null,
  }
}
