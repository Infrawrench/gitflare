import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  WebhookService,
  WebhookSchema,
  WebhookEvent,
  DeliverySchema,
  ListWebhooksResponseSchema,
  CreateWebhookResponseSchema,
  UpdateWebhookResponseSchema,
  DeleteWebhookResponseSchema,
  ListDeliveriesResponseSchema,
  RedeliverResponseSchema,
  PingWebhookResponseSchema,
} from '~/gen/forge/v1/webhook_pb'
import { PageResponseSchema } from '~/gen/forge/v1/common_pb'
import { requireRepo } from '../../db/repos'
import { requireOrgOwner, requireOwner } from '../../db/owners'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import { contextFrom, type RequestContext } from '../router'

/**
 * Webhook management.
 *
 * Configuring a hook means pointing part of this server at a URL of the
 * caller's choosing, so it requires admin on the repo (or ownership of the org)
 * — not merely write. Delivery itself lives in events/webhooks.ts.
 *
 * A secret is never read back. `hasSecret` tells the UI whether one is set,
 * which is all it needs to render the field.
 */

export function registerWebhookService(router: ConnectRouter): void {
  router.service(WebhookService, {
    async listWebhooks(request, context) {
      const ctx = contextFrom(context.values)
      const scope = await requireScope(ctx, request.owner, request.repo)

      const rows = await ctx.env.DB.prepare(
        `SELECT w.*,
           (SELECT created_at FROM webhook_deliveries d WHERE d.webhook_id = w.id
            ORDER BY d.id DESC LIMIT 1) AS last_delivery_at,
           (SELECT status_code FROM webhook_deliveries d WHERE d.webhook_id = w.id
            ORDER BY d.id DESC LIMIT 1) AS last_status_code
         FROM webhooks w
         WHERE ${scope.repoId ? 'w.repo_id = ?1' : 'w.owner_id = ?1'}
         ORDER BY w.created_at DESC`,
      )
        .bind(scope.repoId ?? scope.ownerId)
        .all<WebhookRow>()

      return create(ListWebhooksResponseSchema, {
        webhooks: (rows.results ?? []).map(toWebhook),
      })
    },

    async createWebhook(request, context) {
      const ctx = contextFrom(context.values)
      const scope = await requireScope(ctx, request.owner, request.repo)

      assertDeliverableUrl(request.url)

      const id = newId()
      await ctx.env.DB.prepare(
        `INSERT INTO webhooks (id, repo_id, owner_id, url, content_type, secret, events, active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(
          id,
          scope.repoId,
          scope.repoId ? null : scope.ownerId,
          request.url,
          request.contentType || 'application/json',
          request.secret,
          JSON.stringify(request.events.map(eventName)),
          request.active ? 1 : 0,
          Date.now(),
        )
        .run()

      return create(CreateWebhookResponseSchema, {
        webhook: create(WebhookSchema, {
          id,
          url: request.url,
          contentType: request.contentType || 'application/json',
          events: request.events,
          active: request.active,
          hasSecret: request.secret !== '',
        }),
      })
    },

    async updateWebhook(request, context) {
      const ctx = contextFrom(context.values)
      const hook = await requireWebhook(ctx, request.webhookId)

      const sets: string[] = []
      const binds: unknown[] = [hook.id]
      const set = (column: string, value: unknown) => {
        binds.push(value)
        sets.push(`${column} = ?${binds.length}`)
      }

      if (request.url !== undefined) {
        assertDeliverableUrl(request.url)
        set('url', request.url)
      }
      if (request.contentType !== undefined) set('content_type', request.contentType)
      // An empty string clears the secret; absent leaves it alone. That
      // distinction is why the field is optional rather than defaulted.
      if (request.secret !== undefined) set('secret', request.secret)
      if (request.setEvents) set('events', JSON.stringify(request.events.map(eventName)))
      if (request.active !== undefined) set('active', request.active ? 1 : 0)

      if (sets.length > 0) {
        await ctx.env.DB.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?1`)
          .bind(...binds)
          .run()
      }

      return create(UpdateWebhookResponseSchema, {
        webhook: toWebhook(await requireWebhook(ctx, request.webhookId)),
      })
    },

    async deleteWebhook(request, context) {
      const ctx = contextFrom(context.values)
      const hook = await requireWebhook(ctx, request.webhookId)
      await ctx.env.DB.prepare(`DELETE FROM webhooks WHERE id = ?1`).bind(hook.id).run()
      return create(DeleteWebhookResponseSchema, {})
    },

    async listDeliveries(request, context) {
      const ctx = contextFrom(context.values)
      const hook = await requireWebhook(ctx, request.webhookId)
      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)

      const rows = await ctx.env.DB.prepare(
        `SELECT * FROM webhook_deliveries WHERE webhook_id = ?1
         ${request.page?.cursor ? 'AND id < ?3' : ''}
         ORDER BY id DESC LIMIT ?2`,
      )
        .bind(...[hook.id, limit + 1, ...(request.page?.cursor ? [request.page.cursor] : [])])
        .all<DeliveryRow>()

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      return create(ListDeliveriesResponseSchema, {
        deliveries: page.map(toDelivery),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
      })
    },

    async redeliver(request, context) {
      const ctx = contextFrom(context.values)
      const original = await ctx.env.DB.prepare(
        `SELECT * FROM webhook_deliveries WHERE id = ?1`,
      )
        .bind(request.deliveryId)
        .first<DeliveryRow>()
      if (!original) throw ForgeError.notFound('Delivery')

      const hook = await requireWebhook(ctx, original.webhook_id)

      // Requeued rather than sent inline: redelivery should behave exactly like
      // the original, including retries, and the caller should not wait for it.
      await ctx.env.WEBHOOKS.send({
        webhookId: hook.id,
        event: original.event,
        payload: safeParse(original.request_body),
        attempt: 1,
        redeliveryOf: original.id,
      })

      return create(RedeliverResponseSchema, { delivery: toDelivery(original) })
    },

    async pingWebhook(request, context) {
      const ctx = contextFrom(context.values)
      const hook = await requireWebhook(ctx, request.webhookId)

      await ctx.env.WEBHOOKS.send({
        webhookId: hook.id,
        event: 'ping',
        payload: { zen: 'Design for failure.', hookId: hook.id },
        attempt: 1,
      })

      // The delivery row appears once the queue runs; returning an empty record
      // is honest about the fact that nothing has been sent yet.
      return create(PingWebhookResponseSchema, {})
    },
  })
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface WebhookRow {
  id: string
  repo_id: string | null
  owner_id: string | null
  url: string
  content_type: string
  secret: string
  events: string
  active: number
  created_at: number
  last_delivery_at?: number | null
  last_status_code?: number | null
}

interface DeliveryRow {
  id: string
  webhook_id: string
  event: string
  status_code: number
  error: string
  duration_ms: number
  attempt: number
  request_body: string
  response_body: string
  created_at: number
}

/**
 * Resolves and authorizes the hook's scope.
 *
 * Repo hooks need admin on the repo; owner-level hooks fire for every repo an
 * org has, so they need org ownership.
 */
async function requireScope(
  ctx: RequestContext,
  owner: string,
  repo: string,
): Promise<{ repoId: string | null; ownerId: string }> {
  if (repo) {
    const found = await requireRepo(
      ctx.env.DB,
      owner,
      repo,
      { id: ctx.viewer.id, isSiteAdmin: ctx.viewer.isSiteAdmin },
      'admin',
    )
    return { repoId: found.repo.id, ownerId: found.repo.owner_id }
  }

  const record = await requireOwner(ctx.env.DB, owner)
  if (record.kind === 'org') {
    await requireOrgOwner(ctx.env.DB, record.id, ctx.viewer)
  } else if (record.id !== ctx.viewer.id && !ctx.viewer.isSiteAdmin) {
    throw ForgeError.permissionDenied()
  }
  return { repoId: null, ownerId: record.id }
}

async function requireWebhook(ctx: RequestContext, webhookId: string): Promise<WebhookRow> {
  const hook = await ctx.env.DB.prepare(`SELECT * FROM webhooks WHERE id = ?1`)
    .bind(webhookId)
    .first<WebhookRow>()
  if (!hook) throw ForgeError.notFound('Webhook')

  // Re-authorize against the hook's own scope: the id alone must not be enough.
  if (hook.repo_id) {
    const repo = await ctx.env.DB.prepare(
      `SELECT o.login AS owner, r.name FROM repos r JOIN owners o ON o.id = r.owner_id
       WHERE r.id = ?1`,
    )
      .bind(hook.repo_id)
      .first<{ owner: string; name: string }>()
    if (!repo) throw ForgeError.notFound('Webhook')
    await requireScope(ctx, repo.owner, repo.name)
  } else if (hook.owner_id) {
    const owner = await ctx.env.DB.prepare(`SELECT login FROM owners WHERE id = ?1`)
      .bind(hook.owner_id)
      .first<{ login: string }>()
    if (!owner) throw ForgeError.notFound('Webhook')
    await requireScope(ctx, owner.login, '')
  }

  return hook
}

/**
 * Rejects URLs a hook must not be pointed at.
 *
 * A webhook is a server-side request to a caller-supplied address, which is the
 * classic SSRF shape. Cloudflare blocks private ranges from Workers, but a
 * plaintext or non-HTTP target is still worth refusing outright rather than
 * discovering at delivery time.
 */
function assertDeliverableUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw ForgeError.invalid('Webhook URL is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw ForgeError.invalid('Webhook URL must be http or https')
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1') {
    throw ForgeError.invalid('Webhook URL must not point at the local machine')
  }
}

function toWebhook(row: WebhookRow) {
  return create(WebhookSchema, {
    id: row.id,
    url: row.url,
    contentType: row.content_type,
    events: parseEvents(row.events),
    active: row.active === 1,
    // The secret itself is never returned, only whether one exists.
    hasSecret: row.secret !== '',
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.last_delivery_at
      ? { lastDeliveryAt: timestampFromDate(new Date(row.last_delivery_at)) }
      : {}),
    ...(row.last_status_code ? { lastStatusCode: row.last_status_code } : {}),
  })
}

function toDelivery(row: DeliveryRow) {
  return create(DeliverySchema, {
    id: row.id,
    event: eventValue(row.event),
    statusCode: row.status_code,
    error: row.error,
    durationMs: row.duration_ms,
    attempt: row.attempt,
    requestBody: row.request_body,
    responseBody: row.response_body,
    createdAt: timestampFromDate(new Date(row.created_at)),
  })
}

/** Stored as readable names rather than enum numbers, so the rows survive a renumber. */
function eventName(event: WebhookEvent): string {
  return WebhookEvent[event]?.toLowerCase() ?? 'unspecified'
}

function eventValue(name: string): WebhookEvent {
  const value = WebhookEvent[name.toUpperCase() as keyof typeof WebhookEvent]
  return typeof value === 'number' ? value : WebhookEvent.UNSPECIFIED
}

function parseEvents(value: string): WebhookEvent[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((name) => eventValue(String(name))) : []
  } catch {
    return []
  }
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

export type { HandlerContext }
