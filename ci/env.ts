import type { CiBindings } from '@cloudflare/ci/worker'

/**
 * Bindings for the gitflare-ci auxiliary Worker.
 *
 * `CiBindings` is the contract @cloudflare/ci itself requires — ARTIFACTS,
 * BACKUP_BUCKET, BACKUP_BUCKET_NAME, CLOUDFLARE_ACCOUNT_ID, SANDBOX,
 * CI_WORKFLOW, and the CF_TOKEN / R2 credential secrets. Intersecting with it
 * means a missing binding in wrangler.ci.jsonc fails typecheck rather than at
 * the first push.
 */
export type CiEnv = CiBindings & {
  /** Shared with the main Worker; run and step rows are written here. */
  DB: D1Database
  /**
   * Live log fan-out, defined in the main Worker and bound cross-script. The UI
   * subscribes to it over a server-streaming RPC.
   */
  CI_LOGS: DurableObjectNamespace
  ARTIFACTS_NAMESPACE: string
  /**
   * Container the sandbox path runs in. Bound to the same class @cloudflare/ci
   * uses, so both paths share one image and one container pool.
   */
  SANDBOX: DurableObjectNamespace
}
