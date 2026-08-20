import type { CiLogStream } from './ci/log-stream'
import type { GitflareSandbox } from './ci/sandbox'

/**
 * Bindings for the main Worker. The CI and SSH auxiliary Workers declare their
 * own; see ci/env.ts and ssh/env.ts.
 */
export interface Env {
  // ── Storage ────────────────────────────────────────────────────────────────
  /** Git storage. One namespace holds every repo; see artifacts/names.ts. */
  ARTIFACTS: Artifacts
  DB: D1Database
  /** Access JWKS and other short-lived lookups. */
  CACHE: KVNamespace
  /** Release asset bodies. */
  ASSETS_BUCKET: R2Bucket

  // ── Compute ────────────────────────────────────────────────────────────────
  CI_LOGS: DurableObjectNamespace<CiLogStream>
  /**
   * Container CI commands run in. Optional because the main Worker does not
   * need it in production — the CI Worker owns the pipeline — but the test and
   * dev configs bind it so the runner can be exercised directly.
   */
  SANDBOX?: DurableObjectNamespace<GitflareSandbox>
  WEBHOOKS: Queue<WebhookJob>
  /** The gitflare-ci auxiliary Worker. Absent in tests that do not exercise CI. */
  CI?: Fetcher

  // ── Configuration ──────────────────────────────────────────────────────────
  ARTIFACTS_NAMESPACE: string
  /**
   * Enables the development sign-in route when "1". Set in `.dev.vars`, which
   * Wrangler reads only locally and never uploads — so a deployed Worker cannot
   * carry it. See auth/dev-login.ts.
   */
  GITFLARE_DEV_LOGIN?: string
  /** Cloudflare Access team domain, e.g. "acme.cloudflareaccess.com". */
  ACCESS_TEAM_DOMAIN: string
  /** Access application AUD tag. Required whenever ACCESS_TEAM_DOMAIN is set. */
  ACCESS_AUD: string
  /** Public origin, used to build clone URLs and webhook payload links. */
  GITFLARE_URL: string

  // ── Secrets ────────────────────────────────────────────────────────────────
  CLOUDFLARE_ACCOUNT_ID: string
  /** Artifacts:Read API token, for the REST endpoints the binding lacks. */
  CF_API_TOKEN: string
}

export interface WebhookJob {
  webhookId: string
  event: string
  payload: unknown
  attempt: number
  /** Set when redelivering, so the original delivery row can be referenced. */
  redeliveryOf?: string
}

/**
 * True when Access is not configured. Callers fall back to local dev sessions,
 * which is the only way to sign in under `wrangler dev` or on a workers.dev
 * subdomain — Access applications require a zone you own.
 */
export function isAccessConfigured(env: Env): boolean {
  return env.ACCESS_TEAM_DOMAIN !== '' && env.ACCESS_AUD !== ''
}
