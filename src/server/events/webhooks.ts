import type { Env, WebhookJob } from '../env'
import { newId } from '../ids'

/**
 * Webhook delivery.
 *
 * Deliveries go through a Queue rather than `waitUntil` so a slow or dead
 * endpoint cannot delay the request that triggered it, and so retries survive
 * the Worker that produced them.
 *
 * Every delivery is signed and recorded. The signature lets a receiver verify
 * the payload came from us; the record is what makes a failing integration
 * debuggable without asking the receiver what they saw.
 */

/** Receivers should reject a request that takes longer than this to arrive. */
const TIMEOUT_MS = 10_000
const MAX_ATTEMPTS = 5
/** Response bodies are truncated before storage; some endpoints return HTML pages. */
const MAX_STORED_BODY = 8 * 1024

export interface WebhookRow {
  id: string
  url: string
  content_type: string
  secret: string
  events: string
  active: number
}

/**
 * Fans an event out to every hook that subscribes to it.
 *
 * Matching happens here rather than in the consumer so a repo with no hooks
 * costs one query and no queue traffic at all.
 */
export async function dispatchEvent(
  env: Env,
  params: { repoId: string; ownerId: string; event: string; payload: unknown },
): Promise<void> {
  const hooks = await env.DB.prepare(
    `SELECT id, url, content_type, secret, events, active FROM webhooks
     WHERE active = 1 AND (repo_id = ?1 OR owner_id = ?2)`,
  )
    .bind(params.repoId, params.ownerId)
    .all<WebhookRow>()

  const matching = (hooks.results ?? []).filter((hook) => subscribes(hook, params.event))
  if (matching.length === 0) return

  await env.WEBHOOKS.sendBatch(
    matching.map((hook) => ({
      body: {
        webhookId: hook.id,
        event: params.event,
        payload: params.payload,
        attempt: 1,
      } satisfies WebhookJob,
    })),
  )
}

function subscribes(hook: WebhookRow, event: string): boolean {
  try {
    const events: unknown = JSON.parse(hook.events)
    return Array.isArray(events) && events.includes(event)
  } catch {
    // A malformed subscription list means the hook fires for nothing, rather
    // than for everything.
    return false
  }
}

/**
 * Delivers one queued job.
 *
 * Returns whether the message should be acked. A transient failure is left to
 * the queue's own retry, up to MAX_ATTEMPTS, after which the message is acked
 * and the delivery recorded as failed — endlessly retrying a permanently broken
 * endpoint just fills the queue.
 */
export async function deliver(env: Env, job: WebhookJob): Promise<{ ack: boolean }> {
  const hook = await env.DB.prepare(
    `SELECT id, url, content_type, secret, events, active FROM webhooks WHERE id = ?1`,
  )
    .bind(job.webhookId)
    .first<WebhookRow>()

  // The hook was deleted or disabled after the job was queued. Nothing to do,
  // and no reason to retry.
  if (!hook || hook.active !== 1) return { ack: true }

  const body = JSON.stringify(job.payload)
  const headers = new Headers({
    'Content-Type': hook.content_type || 'application/json',
    'User-Agent': 'Gitflare-Hookshot',
    'X-Gitflare-Event': job.event,
    'X-Gitflare-Delivery': newId(),
  })
  if (hook.secret) {
    headers.set('X-Gitflare-Signature-256', `sha256=${await sign(hook.secret, body)}`)
  }

  const started = Date.now()
  let statusCode = 0
  let responseBody = ''
  let error = ''

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    statusCode = response.status
    responseBody = (await response.text().catch(() => '')).slice(0, MAX_STORED_BODY)
  } catch (caught) {
    // DNS failure, TLS error, timeout — the request never completed, so there is
    // no status to record.
    error = caught instanceof Error ? caught.message : String(caught)
  }

  const succeeded = statusCode >= 200 && statusCode < 300
  const exhausted = job.attempt >= MAX_ATTEMPTS

  await recordDelivery(env, {
    webhookId: hook.id,
    event: job.event,
    statusCode,
    error,
    durationMs: Date.now() - started,
    attempt: job.attempt,
    requestBody: body.slice(0, MAX_STORED_BODY),
    responseBody,
  })

  if (succeeded || exhausted) return { ack: true }

  // Retried by the queue with the attempt counter advanced.
  await env.WEBHOOKS.send({ ...job, attempt: job.attempt + 1 })
  return { ack: true }
}

/**
 * HMAC-SHA256 over the exact bytes sent.
 *
 * Signing the serialized body rather than the object is the whole point: a
 * receiver verifies against the bytes it received, and re-serializing could
 * produce different key order or spacing.
 */
export async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))

  let hex = ''
  for (const byte of new Uint8Array(signature)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

async function recordDelivery(
  env: Env,
  delivery: {
    webhookId: string
    event: string
    statusCode: number
    error: string
    durationMs: number
    attempt: number
    requestBody: string
    responseBody: string
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, event, status_code, error, duration_ms, attempt, request_body, response_body, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      newId(),
      delivery.webhookId,
      delivery.event,
      delivery.statusCode,
      delivery.error,
      delivery.durationMs,
      delivery.attempt,
      delivery.requestBody,
      delivery.responseBody,
      Date.now(),
    )
    .run()
}
