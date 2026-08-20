import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { createClient, type Client } from '@connectrpc/connect'
import type { DescService } from '@bufbuild/protobuf'
import { CIService } from '~/gen/forge/v1/ci_pb'
import { NotificationService } from '~/gen/forge/v1/notification_pb'
import { OrgService } from '~/gen/forge/v1/org_pb'
import { ReleaseService } from '~/gen/forge/v1/release_pb'
import { SearchService } from '~/gen/forge/v1/search_pb'
import { WikiService } from '~/gen/forge/v1/wiki_pb'
import { GitService } from '~/gen/forge/v1/git_pb'
import { IssueService } from '~/gen/forge/v1/issue_pb'
import { PullService } from '~/gen/forge/v1/pull_pb'
import { RepoService } from '~/gen/forge/v1/repo_pb'
import { UserService } from '~/gen/forge/v1/user_pb'

/**
 * Browser transport.
 *
 * gRPC-web rather than the Connect protocol, because it is the wire format
 * Cloudflare translates natively: a CLI speaking real gRPC and this browser
 * client reach the same handlers, and the edge does the conversion. Choosing
 * Connect's own protocol here would work too, but it would leave native gRPC
 * clients on a different path through the router.
 */
/**
 * Absolute origin to call during SSR.
 *
 * A relative `/api` is meaningless on the server — there is no document to
 * resolve it against — so the Worker records the request's origin here before
 * rendering. `import.meta.env.SSR` is replaced at build time, so the client
 * bundle keeps the relative URL and never sees this.
 */
declare global {
  // eslint-disable-next-line no-var
  var __GITFLARE_ORIGIN__: string | undefined
}

/**
 * NOTE: there are no route loaders, and this SSR plumbing is currently unused.
 *
 * Prefetching during render requires the server to call its own API. On
 * Cloudflare that cannot be done over HTTP: a Worker fetching its own hostname
 * is not re-dispatched to the Worker, it falls through to the static-asset
 * layer, so every such call returns `[unimplemented] HTTP 404`. This works in
 * development, where Vite serves both halves in one process, which is exactly
 * what made it look finished.
 *
 * Doing it properly means an in-process transport (`createRouterTransport`) with
 * the per-request context threaded into the router — not a global, since Workers
 * interleave requests in one isolate and a shared global would leak one user's
 * context into another's render. That is the fix; it is not written yet.
 *
 * Sentinel origin used during SSR, rewritten per request by the fetch below.
 *
 * The transport is built once when this module is first evaluated, but the real
 * origin is only known per request — so it cannot be baked into `baseUrl`. Doing
 * that is a bug that hides in development, where Vite re-imports modules per
 * request and the global happens to be set in time; in production the module is
 * evaluated once at cold start and every SSR call goes to localhost.
 */
const SSR_SENTINEL = 'http://ssr.gitflare.invalid'

const transport = createGrpcWebTransport({
  baseUrl: import.meta.env.SSR ? `${SSR_SENTINEL}/api` : '/api',
  fetch: (input, init) =>
    fetch(rewriteForSsr(input), {
      ...init,
      // Cookies carry the session, and Access's own cookie rides along.
      credentials: 'same-origin',
      // connect-web asks for `redirect: 'error'`, which workerd refuses — it
      // implements only 'follow' and 'manual'. 'manual' keeps the intent: a
      // redirect is returned rather than followed, and Connect then rejects it
      // for the wrong content type. Without this, every SSR loader fails.
      redirect: 'manual',
    }),
})

function client<T extends DescService>(service: T): Client<T> {
  return createClient(service, transport)
}

export const api = {
  user: client(UserService),
  repo: client(RepoService),
  git: client(GitService),
  issue: client(IssueService),
  pull: client(PullService),
  ci: client(CIService),
  search: client(SearchService),
  notification: client(NotificationService),
  release: client(ReleaseService),
  wiki: client(WikiService),
  org: client(OrgService),
}

/**
 * Substitutes the live request origin for the sentinel, at call time.
 *
 * Resolved here rather than when the transport is created, because the transport
 * outlives any single request.
 */
function rewriteForSsr(input: RequestInfo | URL): RequestInfo | URL {
  if (!import.meta.env.SSR) return input
  const origin = globalThis.__GITFLARE_ORIGIN__
  if (!origin) return input

  if (typeof input === 'string') return input.replace(SSR_SENTINEL, origin)
  if (input instanceof URL) return new URL(input.toString().replace(SSR_SENTINEL, origin))
  return new Request(input.url.replace(SSR_SENTINEL, origin), input)
}

/**
 * Turns a ConnectError into something worth showing a user.
 *
 * The Artifacts closed-beta gate arrives as FailedPrecondition with an
 * actionable message; passing that through matters more than any generic
 * mapping, since it is the failure most likely to be hit right now.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && 'rawMessage' in error) {
    return String((error as { rawMessage: unknown }).rawMessage)
  }
  return error instanceof Error ? error.message : 'Something went wrong'
}
