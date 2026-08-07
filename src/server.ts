import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import type { Env } from './server/env'
import { handleApiRequest } from './server/handler'
import { deliver } from './server/events/webhooks'
import type { WebhookJob } from './server/env'

/**
 * Worker entry.
 *
 * Replaces `@tanstack/react-start/server-entry` so that git and API routes are
 * handled before SSR sees them. Git paths (`/:owner/:repo.git/...`) live at the
 * root of the namespace and would otherwise be captured by the repo page route,
 * and `/api/*` must reach the Connect router rather than render HTML.
 */
const renderStart = createStartHandler(defaultStreamHandler)

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const handled = await handleApiRequest(request, env, ctx)
    if (handled) return handled

    // Route loaders call the Connect API during SSR, and a relative URL has no
    // meaning there. Recording the origin lets the same client code run on both
    // sides. Set per request because a Worker serves many hostnames.
    globalThis.__GITFLARE_ORIGIN__ = new URL(request.url).origin
    return renderStart(request)
  },

  /**
   * Webhook delivery.
   *
   * wrangler.jsonc declares this consumer, so without a handler here every
   * queued delivery would be dropped.
   *
   * Messages are settled individually rather than by throwing: one dead endpoint
   * in a batch must not force the whole batch to be redelivered, which would
   * duplicate every other delivery in it.
   */
  async queue(batch: MessageBatch<WebhookJob>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        try {
          const { ack } = await deliver(env, message.body)
          if (ack) message.ack()
          else message.retry()
        } catch (error) {
          // An unexpected failure is ours, not the receiver's, so let the queue
          // redeliver rather than silently losing the event.
          console.error('[webhooks] delivery failed', error)
          message.retry()
        }
      }),
    )
  },
}

// Bound as CI_LOGS in wrangler.jsonc, and cross-script from the CI Worker.
export { CiLogStream } from './server/ci/log-stream'
