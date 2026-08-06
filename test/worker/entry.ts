import type { Env } from '~/server/env'
import { handleApiRequest } from '~/server/handler'

/**
 * Test-only Worker entrypoint.
 *
 * The production entry is `src/server.ts`, which pulls in TanStack Start's whole
 * SSR runtime. Integration tests only need the API and git routes, so this skips
 * the renderer and falls through to a 404 instead of HTML.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handled = await handleApiRequest(request, env, ctx)
    return handled ?? new Response('Not found\n', { status: 404 })
  },
}

export { CiLogStream } from '~/server/ci/log-stream'
export { GitflareSandbox } from '~/server/ci/sandbox'
