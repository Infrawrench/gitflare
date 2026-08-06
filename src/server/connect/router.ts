import { createConnectRouter, ConnectError, Code, createContextValues } from '@connectrpc/connect'
import type { ConnectRouter, ContextValues, Interceptor } from '@connectrpc/connect'
import {
  universalServerRequestFromFetch,
  universalServerResponseToFetch,
} from '@connectrpc/connect/protocol'
import type { Env } from '../env'
import { toConnectError } from '../errors'
import { resolveViewer, type Viewer } from '../auth/context'

/**
 * Serves the Connect router from a Worker.
 *
 * Connect-ES has no Workers adapter, so this is the small amount of glue
 * between `fetch` and its universal handler interface. The router speaks
 * Connect, gRPC-web, and gRPC on the same routes; Cloudflare's edge translates
 * native gRPC to gRPC-web on the way in, so a browser using
 * `createGrpcWebTransport` and a CLI speaking real gRPC both reach the same
 * handlers unchanged.
 *
 * Routes are dispatched from a prebuilt map rather than by scanning the handler
 * list, so adding services does not make every request slower.
 */

export const API_PREFIX = '/api'

export interface RequestContext {
  env: Env
  viewer: Viewer
  waitUntil(promise: Promise<unknown>): void
  /** Origin of the incoming request, for building absolute URLs in responses. */
  origin: string
}

/**
 * Context key for the per-request context. Connect passes `ContextValues`
 * through to handlers, which is how a service reaches bindings and the caller's
 * identity without any module-level state.
 */
export const requestContextKey = {
  id: Symbol.for('gitflare.requestContext'),
  defaultValue: undefined as unknown as RequestContext,
}

export function contextFrom(values: ContextValues): RequestContext {
  const context = values.get(requestContextKey)
  if (!context) {
    throw new ConnectError('Request context is missing', Code.Internal)
  }
  return context
}

export type ServiceRegistrar = (router: ConnectRouter) => void

export interface ConnectHandler {
  (request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null>
}

/**
 * Builds a fetch handler for the given services.
 *
 * Returns null when the path is not an API route, so the caller can fall
 * through to SSR or the git routes rather than this having to know about them.
 */
/**
 * Maps domain errors to Connect codes.
 *
 * This has to be an interceptor rather than a try/catch around the handler
 * call: Connect's router catches whatever a method throws and turns anything it
 * does not recognize into `internal` before the caller ever sees it. Without
 * this, a `ForgeError` for "not signed in" reaches the client as
 * `internal: internal error`, which is both wrong and unactionable.
 */
const mapErrors: Interceptor = (next) => async (request) => {
  try {
    return await next(request)
  } catch (error) {
    const connectError = toConnectError(error)
    // Anything that maps to Internal is a bug rather than a client mistake, and
    // the client only ever sees "Internal error". Without logging the original
    // here it would be undiagnosable in production — which is exactly what
    // happened the first time this fired.
    if (connectError.code === Code.Internal) {
      console.error(`[connect] ${request.method.parent.typeName}/${request.method.name}`, error)
    }
    throw connectError
  }
}

export function createConnectHandler(register: ServiceRegistrar): ConnectHandler {
  const router = createConnectRouter({ interceptors: [mapErrors] })
  register(router)

  const byPath = new Map(router.handlers.map((handler) => [handler.requestPath, handler]))

  return async (request, env, ctx) => {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) return null

    // Handlers are registered at "/forge.v1.Service/Method"; the API prefix is
    // ours and is stripped before lookup.
    const handler = byPath.get(url.pathname.slice(API_PREFIX.length))
    if (!handler) {
      return new Response('Unknown RPC\n', { status: 404 })
    }
    if (!handler.allowedMethods.includes(request.method)) {
      return new Response('Method not allowed\n', {
        status: 405,
        headers: { Allow: handler.allowedMethods.join(', ') },
      })
    }

    const viewer = await resolveViewer(request, env)
    const values = createContextValues().set(requestContextKey, {
      env,
      viewer,
      waitUntil: (promise) => ctx.waitUntil(promise),
      origin: url.origin,
    } satisfies RequestContext)

    try {
      const universalResponse = await handler({
        ...universalServerRequestFromFetch(request, {}),
        contextValues: values,
      })
      return universalServerResponseToFetch(universalResponse)
    } catch (error) {
      // A throw that escapes the handler means the protocol layer itself failed;
      // normalizing here keeps an internal message from reaching the client.
      throw toConnectError(error)
    }
  }
}
