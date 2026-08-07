/**
 * Writing git objects.
 *
 * Artifacts has no object-write API, so anything that creates a commit — merging
 * with a real merge commit, saving a wiki page from the web — has to build the
 * objects itself and push them in a packfile.
 *
 * That turns out to be entirely possible in a Worker: `crypto.subtle.digest`
 * does SHA-1, and `CompressionStream('deflate')` produces the zlib framing git
 * expects. Both are verified against real git in the tests — our blob hash for
 * "hello\n" is `ce013625030ba8dba906f756967f9e9ca394464a`, the same id
 * `git hash-object` produces.
 */

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag'

/** Packfile type numbers, from the v2 format. */
export const TYPE_CODES: Record<ObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
}

export interface GitObject {
  type: ObjectType
  /** Raw content, without the `<type> <size>\0` header. */
  content: Uint8Array
  /** SHA-1 of the header plus content, as 40 hex characters. */
  sha: string
}

/**
 * Hashes content the way git does: `<type> <size>\0<content>`.
 *
 * The header is part of the hash, which is why a blob's id is not simply the
 * hash of the file. Getting this wrong produces ids that look plausible and
 * match nothing.
 */
export async function hashObject(type: ObjectType, content: Uint8Array): Promise<GitObject> {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`)
  const store = concat([header, content])
  const digest = await crypto.subtle.digest('SHA-1', store as BufferSource)
  return { type, content, sha: toHex(new Uint8Array(digest)) }
}

export interface TreeEntry {
  /** "100644" for a file, "100755" executable, "40000" a directory, "120000" a symlink. */
  mode: string
  name: string
  sha: string
}

/**
 * Serializes a tree.
 *
 * Entries must be sorted the way git sorts them, and the rule is not plain
 * lexicographic: a directory sorts as though its name ended in `/`. Sorting
 * naively produces a tree that hashes differently from the one git would build
 * for identical content, so every id downstream diverges.
 */
export async function buildTree(entries: TreeEntry[]): Promise<GitObject> {
  const sorted = [...entries].sort((a, b) => {
    const left = a.mode === '40000' ? `${a.name}/` : a.name
    const right = b.mode === '40000' ? `${b.name}/` : b.name
    return left < right ? -1 : left > right ? 1 : 0
  })

  const parts: Uint8Array[] = []
  for (const entry of sorted) {
    // "<mode> <name>\0" then the sha as 20 raw bytes, not hex.
    parts.push(new TextEncoder().encode(`${entry.mode} ${entry.name}\0`))
    parts.push(fromHex(entry.sha))
  }
  return hashObject('tree', concat(parts))
}

export interface Signature {
  name: string
  email: string
  /** Milliseconds; serialized as whole seconds. */
  when: number
  /** Offset like "+0000". UTC is used throughout, since a Worker has no local zone. */
  timezone?: string
}

export interface CommitInput {
  tree: string
  parents: string[]
  author: Signature
  committer?: Signature
  message: string
}

export async function buildCommit(input: CommitInput): Promise<GitObject> {
  const committer = input.committer ?? input.author
  const lines = [`tree ${input.tree}`]

  // Parent order is significant: the first parent is the branch being merged
  // into, which is what `--first-parent` follows.
  for (const parent of input.parents) lines.push(`parent ${parent}`)

  lines.push(`author ${signature(input.author)}`)
  lines.push(`committer ${signature(committer)}`)
  lines.push('')
  // Git conventionally ends a commit message with a newline.
  lines.push(input.message.endsWith('\n') ? input.message : `${input.message}\n`)

  return hashObject('commit', new TextEncoder().encode(lines.join('\n')))
}

function signature(sig: Signature): string {
  const seconds = Math.floor(sig.when / 1000)
  return `${sig.name} <${sig.email}> ${seconds} ${sig.timezone ?? '+0000'}`
}

/**
 * Builds a packfile containing the given objects.
 *
 * Everything is stored undeltified (type 1–4). Deltas would make the pack
 * smaller, but a merge or wiki save pushes a handful of small objects, and delta
 * encoding is a large amount of subtle code to save a few hundred bytes.
 */
export async function buildPackfile(objects: GitObject[]): Promise<Uint8Array> {
  const header = new Uint8Array(12)
  header.set(new TextEncoder().encode('PACK'), 0)
  const view = new DataView(header.buffer)
  view.setUint32(4, 2)
  view.setUint32(8, objects.length)

  const parts: Uint8Array[] = [header]
  for (const object of objects) {
    parts.push(encodeObjectHeader(TYPE_CODES[object.type], object.content.length))
    parts.push(await deflate(object.content))
  }

  const body = concat(parts)
  // The trailer is a SHA-1 over everything before it; git verifies it and
  // rejects the push if it does not match.
  const digest = await crypto.subtle.digest('SHA-1', body as BufferSource)
  return concat([body, new Uint8Array(digest)])
}

/**
 * Variable-length object header.
 *
 * The first byte carries the type in bits 6–4 and the low four bits of the size;
 * each further byte carries seven more size bits, least-significant group first.
 * The high bit means "another byte follows".
 */
export function encodeObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = []
  let byte = (type << 4) | (size & 0x0f)
  let remaining = size >> 4

  while (remaining > 0) {
    bytes.push(byte | 0x80)
    byte = remaining & 0x7f
    remaining >>= 7
  }
  bytes.push(byte)
  return new Uint8Array(bytes)
}

/** zlib-framed deflate, which is what git stores. */
export async function deflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  void writer.write(input as BufferSource)
  void writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
