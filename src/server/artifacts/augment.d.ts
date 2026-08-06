// The Artifacts runtime binding exposes hash-addressed git object readers that
// @cloudflare/workers-types 5.20260804.1 does not yet declare. @cloudflare/ci
// works around the same gap by casting (see its src/artifacts/source-control.ts,
// "Remove once the published types include them").
//
// Declaration merging is the honest version of that cast: it adds the methods to
// the shipped `ArtifactsRepo` interface without re-describing the parts the
// platform already types. Delete this file once workers-types ships them.
//
// Shapes are taken from the REST endpoints these mirror
// (GET /repos/:name/{log,commit/:hash,tree/:hash}) and from how @cloudflare/ci
// consumes them at runtime.

export {}

declare global {
  interface ArtifactsTreeEntry {
    name: string
    /** Git file mode, e.g. "100644" for a file or "040000" for a directory. */
    mode: string
    /** SHA-1 of the entry's own object. */
    hash: string
    /** `commit` marks a gitlink — a submodule reference, not a nested tree. */
    type: 'blob' | 'tree' | 'commit'
  }

  interface ArtifactsCommitObject {
    hash: string
    /** Root tree of this commit; the entry point for readTree(). */
    treeHash: string
    message: string
    author: { name: string; email: string; time: string }
    committer: { name: string; email: string; time: string }
    parents: string[]
  }

  interface ArtifactsLogResult {
    commits: ArtifactsCommitObject[]
  }

  interface ArtifactsRepo {
    /**
     * Commit history for a ref. `ref` accepts a branch, tag, or commit hash and
     * defaults to the repo's default branch.
     */
    log(opts?: {
      ref?: string
      limit?: number
      offset?: number
    }): Promise<ArtifactsLogResult | null>

    /** Reads one commit object by SHA-1. Null when the object is unknown. */
    readCommit(hash: string): Promise<ArtifactsCommitObject | null>

    /**
     * Reads a single level of a tree by SHA-1. Subdirectories come back as
     * `type: 'tree'` entries and need a further call to descend.
     */
    readTree(hash: string): Promise<ArtifactsTreeEntry[] | null>
  }
}
