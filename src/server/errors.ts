import { Code, ConnectError } from '@connectrpc/connect'

/**
 * Domain errors, translated to Connect codes at the RPC boundary and to HTTP
 * status codes on the git routes.
 *
 * Everything user-facing goes through here so an unexpected exception can never
 * leak a stack trace or an internal identifier to a client.
 */
export type ForgeErrorKind =
  | 'not_found'
  | 'already_exists'
  | 'permission_denied'
  | 'unauthenticated'
  | 'invalid_argument'
  | 'failed_precondition'
  | 'conflict'
  | 'unavailable'
  | 'unimplemented'
  | 'internal'

export class ForgeError extends Error {
  readonly kind: ForgeErrorKind

  constructor(kind: ForgeErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ForgeError'
    this.kind = kind
  }

  static notFound(what: string) {
    return new ForgeError('not_found', `${what} not found`)
  }

  static permissionDenied(action = 'You do not have permission to do that') {
    return new ForgeError('permission_denied', action)
  }

  static unauthenticated(message = 'Authentication required') {
    return new ForgeError('unauthenticated', message)
  }

  static invalid(message: string) {
    return new ForgeError('invalid_argument', message)
  }
}

const CONNECT_CODES: Record<ForgeErrorKind, Code> = {
  not_found: Code.NotFound,
  already_exists: Code.AlreadyExists,
  permission_denied: Code.PermissionDenied,
  unauthenticated: Code.Unauthenticated,
  invalid_argument: Code.InvalidArgument,
  failed_precondition: Code.FailedPrecondition,
  conflict: Code.Aborted,
  unavailable: Code.Unavailable,
  unimplemented: Code.Unimplemented,
  internal: Code.Internal,
}

const HTTP_STATUS: Record<ForgeErrorKind, number> = {
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  unauthenticated: 401,
  invalid_argument: 400,
  failed_precondition: 412,
  conflict: 409,
  unavailable: 503,
  unimplemented: 501,
  internal: 500,
}

export function httpStatusFor(error: unknown): number {
  return error instanceof ForgeError ? HTTP_STATUS[error.kind] : 500
}

/**
 * Normalizes any thrown value into a ConnectError. Unrecognized errors become a
 * generic Internal so their message never reaches the client; the original is
 * kept as `cause` for the log.
 */
export function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error
  if (error instanceof ForgeError) {
    return new ConnectError(error.message, CONNECT_CODES[error.kind], undefined, undefined, error)
  }
  if (isArtifactsError(error)) return artifactsToConnect(error)
  return new ConnectError('Internal error', Code.Internal, undefined, undefined, error)
}

export function isArtifactsError(error: unknown): error is ArtifactsError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ArtifactsError' &&
    typeof (error as { code?: unknown }).code === 'string'
  )
}

/**
 * Artifacts is in closed beta. An account without access fails every call with
 * this gate rather than a per-repo error, so it is worth naming explicitly —
 * otherwise it surfaces as an opaque internal error on every git route.
 */
export function isArtifactsFeatureGate(error: unknown): boolean {
  if (!isArtifactsError(error)) return false
  return error.numericCode === 10004 || /feature gate/i.test(error.message)
}

/**
 * True for the Artifacts availability gate however it reaches us — as a raw
 * `ArtifactsError` from the binding, or as the `ForgeError` that ArtifactsClient
 * wraps it in. Callers need both: by the time an error leaves the client it is
 * always the wrapped form, so a check for only the raw shape silently misses it.
 */
export function isGateError(error: unknown): boolean {
  if (isArtifactsFeatureGate(error)) return true
  return error instanceof ForgeError && error.message === ARTIFACTS_GATE_MESSAGE
}

export const ARTIFACTS_GATE_MESSAGE =
  'Cloudflare Artifacts is not enabled on this account. Artifacts is in closed beta; ' +
  'request access at https://developers.cloudflare.com/artifacts/ and redeploy.'

function artifactsToConnect(error: ArtifactsError): ConnectError {
  if (isArtifactsFeatureGate(error)) {
    return new ConnectError(ARTIFACTS_GATE_MESSAGE, Code.FailedPrecondition, undefined, undefined, error)
  }
  const code = ARTIFACTS_CODES[error.code] ?? Code.Internal
  return new ConnectError(error.message, code, undefined, undefined, error)
}

const ARTIFACTS_CODES: Partial<Record<ArtifactsErrorCode, Code>> = {
  ALREADY_EXISTS: Code.AlreadyExists,
  NOT_FOUND: Code.NotFound,
  // Both mean "the repo exists but is not usable yet"; clients should retry.
  IMPORT_IN_PROGRESS: Code.FailedPrecondition,
  FORK_IN_PROGRESS: Code.FailedPrecondition,
  INVALID_INPUT: Code.InvalidArgument,
  INVALID_REPO_NAME: Code.InvalidArgument,
  INVALID_TTL: Code.InvalidArgument,
  INVALID_URL: Code.InvalidArgument,
  REMOTE_AUTH_REQUIRED: Code.PermissionDenied,
  UPSTREAM_UNAVAILABLE: Code.Unavailable,
  MEMORY_LIMIT: Code.ResourceExhausted,
  INTERNAL_ERROR: Code.Internal,
}
