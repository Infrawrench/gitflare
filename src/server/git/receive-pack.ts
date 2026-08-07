import { encodeFlush, encodePktLine } from './pktline'
import type { GitObject } from './objects'
import { buildPackfile } from './objects'
import { decodeLatin1, decodePktLines } from './pktline'

/**
 * Updating a ref through the git protocol.
 *
 * Artifacts exposes no write API — the binding creates and forks whole repos,
 * and the REST API is read-only. The only way to move a branch is to speak
 * `git-receive-pack` to the remote, the same as `git push` does.
 *
 * A push carries two parts: a list of ref update commands, and a packfile of any
 * objects the server is missing.
 *
 * A **fast-forward** needs no objects at all — everything arrived when the head
 * branch was pushed — so the pack is the 32-byte empty one and the push is just
 * "move refs/heads/main from A to B".
 *
 * A **merge commit** does need objects, and `objects.ts` builds them: SHA-1 from
 * WebCrypto, zlib from `CompressionStream`. Both were verified by feeding a
 * generated pack to `git index-pack --stdin`, which validates the trailer and
 * every object encoding before accepting it.
 */

const ZERO_SHA = '0'.repeat(40)

/**
 * The 32-byte empty packfile.
 *
 * Header is "PACK", version 2, and an object count of zero — 12 bytes — followed
 * by a SHA-1 trailer over those bytes. git verifies the trailer, so it cannot be
 * a fixed blob of zeroes.
 */
export async function emptyPackfile(): Promise<Uint8Array> {
  const header = new Uint8Array(12)
  header.set(new TextEncoder().encode('PACK'), 0)
  const view = new DataView(header.buffer)
  view.setUint32(4, 2) // version
  view.setUint32(8, 0) // object count

  const digest = await crypto.subtle.digest('SHA-1', header as BufferSource)
  const packfile = new Uint8Array(32)
  packfile.set(header, 0)
  packfile.set(new Uint8Array(digest), 12)
  return packfile
}

export interface RefUpdate {
  /** Full ref name, e.g. "refs/heads/main". */
  ref: string
  /** SHA the ref is expected to point at now. Zeroes to create it. */
  oldSha: string
  /** SHA to move it to. Zeroes to delete it. */
  newSha: string
}

/**
 * Builds a receive-pack request body.
 *
 * `oldSha` is not decoration: the server rejects the update if the ref has moved
 * since it was read. That compare-and-swap is what stops a merge from silently
 * clobbering a push that landed while the pull request page was open.
 */
export async function buildReceivePackRequest(
  update: RefUpdate,
  /**
   * Objects the server does not have yet. Omitted for a fast-forward, where
   * every object already arrived with the head branch, so the pack is empty.
   */
  objects: GitObject[] = [],
): Promise<Uint8Array> {
  // Capabilities ride on the first command, after a NUL.
  const command = `${update.oldSha} ${update.newSha} ${update.ref}\0report-status\n`

  const pack = objects.length > 0 ? await buildPackfile(objects) : await emptyPackfile()
  const parts = [encodePktLine(command), encodeFlush(), pack]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const body = new Uint8Array(total)

  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return body
}

export interface ReceivePackResult {
  ok: boolean
  /** Reason the server gave, when it refused. */
  error?: string
}

/**
 * Parses a report-status response.
 *
 * A push can fail with HTTP 200 — the transport succeeded, the update did not.
 * Treating a 200 as success is the classic mistake here, so `unpack ok` and the
 * per-ref status are both checked.
 */
export function parseReceivePackResponse(body: Uint8Array): ReceivePackResult {
  let unpackOk = false
  let refError: string | undefined
  let sawRefStatus = false

  for (const line of decodePktLines(body)) {
    if (line.data === null) continue
    const text = decodeLatin1(line.data).replace(/\n$/, '')

    if (text === 'unpack ok') {
      unpackOk = true
    } else if (text.startsWith('unpack ')) {
      return { ok: false, error: text.slice('unpack '.length) }
    } else if (text.startsWith('ok ')) {
      sawRefStatus = true
    } else if (text.startsWith('ng ')) {
      sawRefStatus = true
      // "ng <ref> <reason>"
      const rest = text.slice(3)
      const space = rest.indexOf(' ')
      refError = space === -1 ? rest : rest.slice(space + 1)
    }
  }

  if (refError) return { ok: false, error: refError }
  if (!unpackOk || !sawRefStatus) {
    return { ok: false, error: 'Server did not confirm the ref update' }
  }
  return { ok: true }
}

/**
 * Whether `head` can be merged into `base` by moving the branch pointer alone.
 *
 * True exactly when base is already an ancestor of head — the merge would
 * introduce no new commits, so no objects need to be written.
 */
export function canFastForward(baseSha: string, headSha: string, headAncestry: string[]): boolean {
  if (baseSha === headSha) return false // Nothing to merge.
  if (baseSha === ZERO_SHA) return true // Creating the branch.
  return headAncestry.includes(baseSha)
}

export { ZERO_SHA }
