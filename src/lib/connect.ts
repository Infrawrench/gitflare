import { createGrpcWebTransport } from '@connectrpc/connect-web'
import { createClient, type Client } from '@connectrpc/connect'
import type { DescService } from '@bufbuild/protobuf'
import { CIService } from '~/gen/forge/v1/ci_pb'
import { NotificationService } from '~/gen/forge/v1/notification_pb'
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
const transport = createGrpcWebTransport({
  baseUrl: '/api',
  // Cookies carry the session, and Access's own cookie rides along with them.
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
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
