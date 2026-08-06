import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  CIService,
  RunSchema,
  RunStepSchema,
  RunStatus,
  TriggerKind,
  LogChunkSchema,
  ListRunsResponseSchema,
  GetRunResponseSchema,
  GetRunForCommitResponseSchema,
  StreamRunLogsResponseSchema,
  RerunResponseSchema,
  CancelRunResponseSchema,
} from '~/gen/forge/v1/ci_pb'
import { PageResponseSchema } from '~/gen/forge/v1/common_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { requireRepo, type RepoWithAccess } from '../../db/repos'
import { ForgeError } from '../../errors'
import { atLeast } from '../../auth/rbac'
import { contextFrom, type RequestContext } from '../router'

/**
 * CI run history and live logs.
 *
 * Reads come from D1 rather than the Workflows API: a run list should not cost
 * one control-plane call per row, and the rows are written as the pipeline
 * progresses anyway (see ci/record.ts).
 *
 * Logs are the exception — those live in the CiLogStream Durable Object, which
 * is the only thing that sees output while a step is still running.
 */

export function registerCIService(router: ConnectRouter): void {
  router.service(CIService, {
    async listRuns(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)

      const filters = ['r.repo_id = ?1']
      const binds: unknown[] = [found.repo.id]
      const bind = (value: unknown) => {
        binds.push(value)
        return `?${binds.length}`
      }

      if (request.branch) filters.push(`r.branch = ${bind(request.branch)}`)
      if (request.status !== undefined && request.status !== RunStatus.UNSPECIFIED) {
        filters.push(`r.status = ${bind(statusToColumn(request.status))}`)
      }
      if (request.page?.cursor) filters.push(`r.id < ${bind(request.page.cursor)}`)

      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)
      const rows = await ctx.env.DB.prepare(
        `SELECT r.*, o.login AS actor_login FROM ci_runs r
         LEFT JOIN owners o ON o.id = r.actor_id
         WHERE ${filters.join(' AND ')}
         ORDER BY r.id DESC LIMIT ${bind(limit + 1)}`,
      )
        .bind(...binds)
        .all<RunRow>()

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      // Steps are fetched for the whole page in one query; per-run lookups would
      // be 30 round trips for a single list.
      const steps = await loadSteps(
        ctx,
        page.map((row) => row.id),
      )

      return create(ListRunsResponseSchema, {
        runs: page.map((row) => toRun(row, found, steps.get(row.id) ?? [])),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
      })
    },

    async getRun(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findRun(ctx, found.repo.id, request.number)
      const steps = await loadSteps(ctx, [row.id])
      return create(GetRunResponseSchema, { run: toRun(row, found, steps.get(row.id) ?? []) })
    },

    async getRunForCommit(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)

      // Most recent wins: a commit can be built more than once through a rerun.
      const row = await ctx.env.DB.prepare(
        `SELECT r.*, o.login AS actor_login FROM ci_runs r
         LEFT JOIN owners o ON o.id = r.actor_id
         WHERE r.repo_id = ?1 AND r.sha = ?2 ORDER BY r.id DESC LIMIT 1`,
      )
        .bind(found.repo.id, request.sha)
        .first<RunRow>()

      if (!row) return create(GetRunForCommitResponseSchema, {})
      const steps = await loadSteps(ctx, [row.id])
      return create(GetRunForCommitResponseSchema, {
        run: toRun(row, found, steps.get(row.id) ?? []),
      })
    },

    /**
     * Server-streaming log tail.
     *
     * History is read before subscribing, and the subscription is filtered to
     * chunks after the last one replayed — otherwise a chunk appended between
     * the two calls would either be lost or delivered twice.
     */
    async *streamRunLogs(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findRun(ctx, found.repo.id, request.number)

      const stub = ctx.env.CI_LOGS.get(ctx.env.CI_LOGS.idFromName(row.id))
      let cursor = Number(request.afterSequence)

      const history = await stub.history(cursor, request.stepName || undefined)
      for (const chunk of history) {
        cursor = Math.max(cursor, chunk.sequence)
        yield create(StreamRunLogsResponseSchema, { chunk: toLogChunk(chunk) })
      }

      // A finished run has nothing more to send; returning here closes the
      // stream instead of holding a connection open forever.
      if (isTerminal(row.status)) {
        yield create(StreamRunLogsResponseSchema, {
          finalStatus: statusFromColumn(row.status),
        })
        return
      }

      // Poll rather than hold a DO subscription: a Connect stream can be
      // abandoned by the client at any point, and a callback registered in the
      // DO would outlive it. `signal` ends the loop when the client goes away.
      const signal = context.signal
      while (!signal.aborted) {
        await sleep(500, signal)
        if (signal.aborted) return

        const chunks = await stub.history(cursor, request.stepName || undefined)
        for (const chunk of chunks) {
          cursor = Math.max(cursor, chunk.sequence)
          yield create(StreamRunLogsResponseSchema, { chunk: toLogChunk(chunk) })
        }

        const current = await ctx.env.DB.prepare(`SELECT status FROM ci_runs WHERE id = ?1`)
          .bind(row.id)
          .first<{ status: string }>()

        if (current && isTerminal(current.status)) {
          yield create(StreamRunLogsResponseSchema, {
            finalStatus: statusFromColumn(current.status),
          })
          return
        }
      }
    },

    async rerun(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo, 'write')
      const row = await findRun(ctx, found.repo.id, request.number)

      if (!isTerminal(row.status)) {
        throw new ForgeError('failed_precondition', 'This run is still in progress')
      }
      // Restarting is the CI Worker's job — it owns the Workflow instance and
      // the sandbox. Without that binding there is nothing to ask.
      if (!ctx.env.CI) {
        throw new ForgeError('unavailable', 'The CI service is not configured for this deployment')
      }

      const response = await ctx.env.CI.fetch('https://ci.internal/rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: row.id, instanceId: row.workflow_instance_id }),
      })
      if (!response.ok) {
        throw new ForgeError('unavailable', `Could not restart the run (${response.status})`)
      }

      const updated = await findRun(ctx, found.repo.id, request.number)
      const steps = await loadSteps(ctx, [updated.id])
      return create(RerunResponseSchema, { run: toRun(updated, found, steps.get(updated.id) ?? []) })
    },

    async cancelRun(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo, 'write')
      const row = await findRun(ctx, found.repo.id, request.number)

      if (isTerminal(row.status)) {
        throw new ForgeError('failed_precondition', 'This run has already finished')
      }

      const now = Date.now()
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `UPDATE ci_runs SET status = 'cancelled', finished_at = ?2 WHERE id = ?1`,
        ).bind(row.id, now),
        ctx.env.DB.prepare(
          `UPDATE ci_steps SET status = 'cancelled', finished_at = ?2
           WHERE run_id = ?1 AND status IN ('queued', 'running')`,
        ).bind(row.id, now),
      ])

      const updated = await findRun(ctx, found.repo.id, request.number)
      const steps = await loadSteps(ctx, [updated.id])
      return create(CancelRunResponseSchema, {
        run: toRun(updated, found, steps.get(updated.id) ?? []),
      })
    },
  })
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string
  repo_id: string
  number: number
  workflow_instance_id: string
  status: string
  trigger: string
  ref: string
  branch: string | null
  tag: string | null
  sha: string
  commit_message: string
  actor_id: string | null
  actor_login: string | null
  error: string
  created_at: number
  started_at: number | null
  finished_at: number | null
}

interface StepRow {
  id: string
  run_id: string
  name: string
  command: string
  status: string
  exit_code: number
  needs: string
  attempt: number
  cache_hit: number
  started_at: number | null
  finished_at: number | null
}

async function load(
  context: HandlerContext,
  owner: string,
  repo: string,
  required: 'read' | 'write' = 'read',
): Promise<{ ctx: RequestContext; found: RepoWithAccess }> {
  const ctx = contextFrom(context.values)
  const found = await requireRepo(
    ctx.env.DB,
    owner,
    repo,
    { id: ctx.viewer.id, isSiteAdmin: ctx.viewer.isSiteAdmin },
    required,
  )
  if (required === 'write' && !atLeast(found.access.permission, 'write')) {
    throw ForgeError.permissionDenied()
  }
  return { ctx, found }
}

async function findRun(ctx: RequestContext, repoId: string, number: number): Promise<RunRow> {
  const row = await ctx.env.DB.prepare(
    `SELECT r.*, o.login AS actor_login FROM ci_runs r
     LEFT JOIN owners o ON o.id = r.actor_id
     WHERE r.repo_id = ?1 AND r.number = ?2`,
  )
    .bind(repoId, number)
    .first<RunRow>()
  if (!row) throw ForgeError.notFound(`Run #${number}`)
  return row
}

async function loadSteps(ctx: RequestContext, runIds: string[]): Promise<Map<string, StepRow[]>> {
  const byRun = new Map<string, StepRow[]>()
  if (runIds.length === 0) return byRun

  const placeholders = runIds.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await ctx.env.DB.prepare(
    `SELECT * FROM ci_steps WHERE run_id IN (${placeholders}) ORDER BY ordinal`,
  )
    .bind(...runIds)
    .all<StepRow>()

  for (const row of rows.results ?? []) {
    const group = byRun.get(row.run_id)
    if (group) group.push(row)
    else byRun.set(row.run_id, [row])
  }
  return byRun
}

// ── mapping ──────────────────────────────────────────────────────────────────

const TERMINAL = new Set(['success', 'failure', 'cancelled'])

function isTerminal(status: string): boolean {
  return TERMINAL.has(status)
}

function statusFromColumn(status: string): RunStatus {
  switch (status) {
    case 'queued':
      return RunStatus.QUEUED
    case 'running':
      return RunStatus.RUNNING
    case 'success':
      return RunStatus.SUCCESS
    case 'failure':
      return RunStatus.FAILURE
    case 'cancelled':
      return RunStatus.CANCELLED
    case 'cached':
      return RunStatus.CACHED
    default:
      return RunStatus.UNSPECIFIED
  }
}

function statusToColumn(status: RunStatus): string {
  switch (status) {
    case RunStatus.QUEUED:
      return 'queued'
    case RunStatus.RUNNING:
      return 'running'
    case RunStatus.SUCCESS:
      return 'success'
    case RunStatus.FAILURE:
      return 'failure'
    case RunStatus.CANCELLED:
      return 'cancelled'
    default:
      return 'queued'
  }
}

function toRun(row: RunRow, found: RepoWithAccess, steps: StepRow[]) {
  return create(RunSchema, {
    id: row.id,
    number: row.number,
    repoFullName: `${found.repo.owner_login}/${found.repo.name}`,
    workflowInstanceId: row.workflow_instance_id,
    status: statusFromColumn(row.status),
    trigger:
      row.trigger === 'tag'
        ? TriggerKind.TAG
        : row.trigger === 'manual'
          ? TriggerKind.MANUAL
          : TriggerKind.PUSH,
    ref: row.ref,
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.tag ? { tag: row.tag } : {}),
    sha: row.sha,
    commitMessage: row.commit_message,
    ...(row.actor_id && row.actor_login
      ? { actor: create(UserSchema, { id: row.actor_id, login: row.actor_login }) }
      : {}),
    steps: steps.map((step) =>
      create(RunStepSchema, {
        id: step.id,
        name: step.name,
        command: step.command,
        status: statusFromColumn(step.status),
        exitCode: step.exit_code,
        needs: safeParseNeeds(step.needs),
        attempt: step.attempt,
        cacheHit: step.cache_hit === 1,
        ...(step.started_at ? { startedAt: timestampFromDate(new Date(step.started_at)) } : {}),
        ...(step.finished_at ? { finishedAt: timestampFromDate(new Date(step.finished_at)) } : {}),
      }),
    ),
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.started_at ? { startedAt: timestampFromDate(new Date(row.started_at)) } : {}),
    ...(row.finished_at ? { finishedAt: timestampFromDate(new Date(row.finished_at)) } : {}),
    ...(row.error ? { error: row.error } : {}),
  })
}

function toLogChunk(chunk: {
  sequence: number
  stepName: string
  text: string
  isStderr: boolean
  at: number
}) {
  return create(LogChunkSchema, {
    stepName: chunk.stepName,
    text: chunk.text,
    isStderr: chunk.isStderr,
    sequence: BigInt(chunk.sequence),
    at: timestampFromDate(new Date(chunk.at)),
  })
}

function safeParseNeeds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Sleep that resolves early when the client disconnects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
