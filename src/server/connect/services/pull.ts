import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  PullService,
  PullRequestSchema,
  ReviewSchema,
  ReviewCommentSchema,
  ReviewState,
  ListReviewsResponseSchema,
  CreateReviewResponseSchema,
  RequestReviewersResponseSchema,
  PullBranchSchema,
  PullState,
  MergeableState,
  MergeMethod,
  FileStatus,
  LineKind,
  FileDiffSchema,
  DiffHunkSchema,
  DiffLineSchema,
  ListPullsResponseSchema,
  GetPullResponseSchema,
  CreatePullResponseSchema,
  UpdatePullResponseSchema,
  GetPullDiffResponseSchema,
  CompareResponseSchema,
  ListPullCommitsResponseSchema,
  MergePullResponseSchema,
} from '~/gen/forge/v1/pull_pb'
import { CommitSchema, PageResponseSchema, SignatureSchema } from '~/gen/forge/v1/common_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { ArtifactsClient } from '../../artifacts/client'
import { nextIssueNumber, requireRepo, type RepoRow, type RepoWithAccess } from '../../db/repos'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import { atLeast } from '../../auth/rbac'
import { diffText } from '../../diff/hunks'
import { DiffTooLargeError } from '../../diff/myers'
import { isProbablyBinary } from '../../git/content'
import {
  buildReceivePackRequest,
  canFastForward,
  parseReceivePackResponse,
} from '../../git/receive-pack'
import { contextFrom, type RequestContext } from '../router'
import { emit, pullPayload } from '../../events/emit'
import { notifyThread } from '../../events/notify'

/**
 * Pull requests.
 *
 * A pull request is a row in `issues` with `is_pull = 1` plus a row in
 * `pull_requests`, so it shares the per-repo number sequence with issues.
 *
 * Branch positions are re-read from Artifacts on every request rather than
 * trusted from the stored `head_sha` — either branch can move between the page
 * loading and the merge button being pressed, and a stale SHA is exactly how a
 * merge ends up clobbering someone's push.
 */

/** Files beyond this are listed but not diffed, to bound the isolate's work. */
const MAX_DIFF_FILES = 300
/** Commits walked when establishing ancestry for merge-base and fast-forward. */
const ANCESTRY_LIMIT = 500

export function registerPullService(router: ConnectRouter): void {
  router.service(PullService, {
    async listPulls(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)

      const filters = ['i.repo_id = ?1', 'i.is_pull = 1']
      const binds: unknown[] = [found.repo.id]
      const bind = (value: unknown) => {
        binds.push(value)
        return `?${binds.length}`
      }

      if (request.state !== undefined && request.state !== PullState.UNSPECIFIED) {
        // 'merged' is not a column: it is a closed issue whose PR row is marked
        // merged, so the two have to be filtered together.
        if (request.state === PullState.MERGED) filters.push('p.merged = 1')
        else if (request.state === PullState.OPEN) filters.push(`i.state = 'open'`)
        else filters.push(`i.state = 'closed' AND p.merged = 0`)
      }
      if (request.author) {
        filters.push(
          `i.author_id = (SELECT id FROM owners WHERE login_lower = ${bind(request.author.toLowerCase())})`,
        )
      }
      if (request.baseBranch) filters.push(`p.base_branch = ${bind(request.baseBranch)}`)

      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)
      const cursor = request.page?.cursor ? ` AND i.id < ${bind(request.page.cursor)}` : ''

      const [rows, counts] = await Promise.all([
        ctx.env.DB.prepare(
          `${PULL_SELECT} WHERE ${filters.join(' AND ')}${cursor}
           ORDER BY i.id DESC LIMIT ${bind(limit + 1)}`,
        )
          .bind(...binds)
          .all<PullRow>(),
        ctx.env.DB.prepare(
          `SELECT
             COUNT(*) FILTER (WHERE i.state = 'open') AS open_count,
             COUNT(*) FILTER (WHERE i.state = 'closed') AS closed_count
           FROM issues i WHERE i.repo_id = ?1 AND i.is_pull = 1`,
        )
          .bind(found.repo.id)
          .first<{ open_count: number; closed_count: number }>(),
      ])

      const results = rows.results ?? []
      const page = results.slice(0, limit)

      return create(ListPullsResponseSchema, {
        // Listing does not resolve live branch positions: that is one Artifacts
        // round trip per row, and a list does not need merge status.
        pulls: page.map((row) => toPullRequest(row, MergeableState.UNKNOWN)),
        page: create(PageResponseSchema, {
          nextCursor: results.length > limit ? (page.at(-1)?.id ?? '') : '',
        }),
        openCount: counts?.open_count ?? 0,
        closedCount: counts?.closed_count ?? 0,
      })
    },

    async getPull(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findPull(ctx, found.repo.id, request.number)
      const live = await resolveBranches(ctx, found.repo, row)

      return create(GetPullResponseSchema, {
        pull: toPullRequest(row, live.mergeable, live),
      })
    },

    async createPull(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const author = requireViewerId(ctx)

      const base = request.baseBranch || found.repo.default_branch
      // "owner:branch" addresses a fork; a bare name is same-repo.
      const [headOwner, headBranch] = request.head.includes(':')
        ? (request.head.split(':', 2) as [string, string])
        : [null, request.head]

      if (headOwner === null && headBranch === base) {
        throw ForgeError.invalid('A pull request cannot merge a branch into itself')
      }

      const headRepo = headOwner
        ? (await requireRepo(ctx.env.DB, headOwner, found.repo.name, viewerOf(ctx), 'read')).repo
        : found.repo

      const artifacts = new ArtifactsClient(ctx.env)
      const [baseSha, headSha] = await Promise.all([
        resolveBranch(artifacts, found.repo.artifacts_name, base),
        resolveBranch(artifacts, headRepo.artifacts_name, headBranch),
      ])
      if (!headSha) throw ForgeError.notFound(`Branch "${headBranch}"`)

      const number = await nextIssueNumber(ctx.env.DB, found.repo.id)
      const id = newId()
      const now = Date.now()

      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO issues (id, repo_id, number, title, body, state, author_id, is_pull, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, 1, ?7, ?7)`,
        ).bind(id, found.repo.id, number, request.title, request.body, author, now),
        ctx.env.DB.prepare(
          `INSERT INTO pull_requests (issue_id, repo_id, base_branch, base_sha, head_repo_id, head_branch, head_sha, draft)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(
          id,
          found.repo.id,
          base,
          baseSha ?? '',
          headRepo.id === found.repo.id ? null : headRepo.id,
          headBranch,
          headSha,
          request.draft ? 1 : 0,
        ),
      ])

      const row = await findPull(ctx, found.repo.id, number)

      emit(ctx, found.repo, 'pull_request', pullPayload('opened', {
        number,
        title: request.title,
        state: 'open',
        baseBranch: base,
        headBranch,
        authorLogin: ctx.viewer.login ?? '',
      }))

      return create(CreatePullResponseSchema, { pull: toPullRequest(row, MergeableState.UNKNOWN) })
    },

    async updatePull(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const viewer = requireViewerId(ctx)
      const row = await findPull(ctx, found.repo.id, request.number)

      if (row.author_id !== viewer && !atLeast(found.access.permission, 'triage')) {
        throw ForgeError.permissionDenied()
      }
      if (row.merged === 1 && request.state !== undefined) {
        // Reopening a merged pull request is meaningless — the commits are
        // already on the base branch.
        throw new ForgeError('failed_precondition', 'This pull request has already been merged')
      }

      const sets: string[] = []
      const binds: unknown[] = [row.issue_id]
      const set = (column: string, value: unknown) => {
        binds.push(value)
        sets.push(`${column} = ?${binds.length}`)
      }

      if (request.title !== undefined) set('title', request.title)
      if (request.body !== undefined) set('body', request.body)
      if (request.state !== undefined && request.state !== PullState.UNSPECIFIED) {
        const closed = request.state !== PullState.OPEN
        set('state', closed ? 'closed' : 'open')
        set('closed_at', closed ? Date.now() : null)
      }
      set('updated_at', Date.now())

      const statements = [
        ctx.env.DB.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds),
      ]
      if (request.draft !== undefined) {
        statements.push(
          ctx.env.DB.prepare(`UPDATE pull_requests SET draft = ?2 WHERE issue_id = ?1`).bind(
            row.issue_id,
            request.draft ? 1 : 0,
          ),
        )
      }
      if (request.baseBranch !== undefined) {
        statements.push(
          ctx.env.DB.prepare(`UPDATE pull_requests SET base_branch = ?2 WHERE issue_id = ?1`).bind(
            row.issue_id,
            request.baseBranch,
          ),
        )
      }
      await ctx.env.DB.batch(statements)

      const updated = await findPull(ctx, found.repo.id, request.number)

      if (row.state !== updated.state) {
        emit(ctx, found.repo, 'pull_request', pullPayload(
          updated.state === 'closed' ? 'closed' : 'reopened',
          {
            number: updated.number,
            title: updated.title,
            state: updated.state,
            baseBranch: updated.base_branch,
            headBranch: updated.head_branch,
            authorLogin: updated.author_login,
          },
        ))
      }

      return create(UpdatePullResponseSchema, { pull: toPullRequest(updated, MergeableState.UNKNOWN) })
    },

    async listPullCommits(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findPull(ctx, found.repo.id, request.number)
      const artifacts = new ArtifactsClient(ctx.env)
      const headRepo = await headRepoOf(ctx, found.repo, row)

      const live = await resolveBranches(ctx, found.repo, row)
      const commits = await commitsBetween(
        artifacts,
        headRepo.artifacts_name,
        live.headSha,
        live.mergeBaseSha,
      )

      return create(ListPullCommitsResponseSchema, { commits: commits.map(toCommit) })
    },

    async getPullDiff(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findPull(ctx, found.repo.id, request.number)
      const live = await resolveBranches(ctx, found.repo, row)
      const headRepo = await headRepoOf(ctx, found.repo, row)

      const diff = await buildDiff(ctx, {
        baseRepo: found.repo.artifacts_name,
        headRepo: headRepo.artifacts_name,
        // Diff against the merge base, not the base tip: otherwise commits that
        // landed on base after the branch point show up as if this PR reverted
        // them.
        baseSha: live.mergeBaseSha,
        headSha: live.headSha,
        path: request.path,
        contextLines: request.contextLines || 3,
      })

      return create(GetPullDiffResponseSchema, diff)
    },

    async compare(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const artifacts = new ArtifactsClient(ctx.env)

      const [baseSha, headSha] = await Promise.all([
        resolveRefToSha(artifacts, found.repo.artifacts_name, request.base),
        resolveRefToSha(artifacts, found.repo.artifacts_name, request.head),
      ])

      const mergeBase = await findMergeBase(artifacts, found.repo.artifacts_name, baseSha, headSha)
      const [commits, diff] = await Promise.all([
        commitsBetween(artifacts, found.repo.artifacts_name, headSha, mergeBase),
        buildDiff(ctx, {
          baseRepo: found.repo.artifacts_name,
          headRepo: found.repo.artifacts_name,
          baseSha: mergeBase,
          headSha,
          path: '',
          contextLines: request.contextLines || 3,
        }),
      ])

      return create(CompareResponseSchema, {
        commits: commits.map(toCommit),
        files: diff.files,
        mergeBaseSha: mergeBase,
        truncated: diff.truncated,
      })
    },

    async listReviews(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findPull(ctx, found.repo.id, request.number)
      const live = await resolveBranches(ctx, found.repo, row).catch(() => null)

      const [reviews, comments] = await Promise.all([
        ctx.env.DB.prepare(
          `SELECT r.*, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
           FROM reviews r JOIN owners o ON o.id = r.author_id
           WHERE r.issue_id = ?1 ORDER BY r.created_at`,
        )
          .bind(row.issue_id)
          .all<ReviewRow>(),
        ctx.env.DB.prepare(
          `SELECT c.*, o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar
           FROM review_comments c JOIN owners o ON o.id = c.author_id
           WHERE c.issue_id = ?1 ORDER BY c.path, c.line`,
        )
          .bind(row.issue_id)
          .all<ReviewCommentRow>(),
      ])

      const byReview = new Map<string, ReviewCommentRow[]>()
      for (const comment of comments.results ?? []) {
        const group = byReview.get(comment.review_id)
        if (group) group.push(comment)
        else byReview.set(comment.review_id, [comment])
      }

      return create(ListReviewsResponseSchema, {
        reviews: (reviews.results ?? []).map((review) =>
          create(ReviewSchema, {
            id: review.id,
            author: create(UserSchema, {
              id: review.author_id,
              login: review.author_login,
              displayName: review.author_name || review.author_login,
              avatarUrl: review.author_avatar,
            }),
            state: reviewState(review.state),
            body: review.body,
            commitSha: review.commit_sha,
            createdAt: timestampFromDate(new Date(review.created_at)),
            comments: (byReview.get(review.id) ?? []).map((comment) =>
              create(ReviewCommentSchema, {
                id: comment.id,
                author: create(UserSchema, {
                  id: comment.author_id,
                  login: comment.author_login,
                  displayName: comment.author_name || comment.author_login,
                  avatarUrl: comment.author_avatar,
                }),
                body: comment.body,
                path: comment.path,
                line: comment.line,
                // A comment written against an older head may no longer point at
                // the line it was about, so it is marked rather than moved.
                outdated: live !== null && comment.commit_sha !== live.headSha,
                createdAt: timestampFromDate(new Date(comment.created_at)),
              }),
            ),
          }),
        ),
      })
    },

    async createReview(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const author = requireViewerId(ctx)
      const row = await findPull(ctx, found.repo.id, request.number)

      // Reviewing your own pull request is not a meaningful approval, and
      // self-approval is the obvious way around a review requirement.
      if (row.author_id === author && request.state === ReviewState.APPROVED) {
        throw new ForgeError('failed_precondition', 'You cannot approve your own pull request')
      }
      if (row.merged === 1) {
        throw new ForgeError('failed_precondition', 'This pull request has already been merged')
      }

      const live = await resolveBranches(ctx, found.repo, row)
      const id = newId()
      const now = Date.now()

      const statements = [
        ctx.env.DB.prepare(
          `INSERT INTO reviews (id, issue_id, author_id, state, body, commit_sha, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        ).bind(id, row.issue_id, author, reviewStateColumn(request.state), request.body, live.headSha, now),
        // A review satisfies its own request, so the pending row goes away.
        ctx.env.DB.prepare(`DELETE FROM pull_reviewers WHERE issue_id = ?1 AND user_id = ?2`).bind(
          row.issue_id,
          author,
        ),
      ]

      for (const comment of request.comments) {
        statements.push(
          ctx.env.DB.prepare(
            `INSERT INTO review_comments (id, review_id, issue_id, author_id, body, path, line, commit_sha, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
          ).bind(newId(), id, row.issue_id, author, comment.body, comment.path, comment.line, live.headSha, now),
        )
      }
      await ctx.env.DB.batch(statements)

      emit(ctx, found.repo, 'pull_request_review', {
        action: 'submitted',
        pullRequest: { number: row.number, title: row.title },
        review: { state: reviewStateColumn(request.state), authorLogin: ctx.viewer.login ?? '' },
      })

      ctx.waitUntil(
        notifyThread(ctx.env, {
          subject: {
            repoId: found.repo.id,
            type: 'pull_request',
            id: row.issue_id,
            title: row.title,
            ref: String(row.number),
            url: `${ctx.origin}/${found.repo.owner_login}/${found.repo.name}/pulls/${row.number}`,
          },
          actorId: author,
          reason: 'comment',
          userIds: [row.author_id],
        }).catch(() => {}),
      )

      return create(CreateReviewResponseSchema, {
        review: create(ReviewSchema, {
          id,
          author: create(UserSchema, { id: author, login: ctx.viewer.login ?? '' }),
          state: request.state,
          body: request.body,
          commitSha: live.headSha,
          createdAt: timestampFromDate(new Date(now)),
        }),
      })
    },

    async requestReviewers(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      requireViewerId(ctx)
      const row = await findPull(ctx, found.repo.id, request.number)

      // Requesting a review is a triage action: it puts a task in someone's
      // inbox, so it is not open to every reader.
      if (row.author_id !== ctx.viewer.id && !atLeast(found.access.permission, 'triage')) {
        throw ForgeError.permissionDenied()
      }

      const users = await ctx.env.DB.prepare(
        `SELECT id, login FROM owners WHERE login_lower IN (${request.reviewerLogins
          .map((_, index) => `?${index + 1}`)
          .join(', ')}) AND kind = 'user'`,
      )
        .bind(...request.reviewerLogins.map((login) => login.toLowerCase()))
        .all<{ id: string; login: string }>()

      const resolved = (users.results ?? []).filter((user) => user.id !== row.author_id)
      if (resolved.length === 0) {
        return create(RequestReviewersResponseSchema, {})
      }

      await ctx.env.DB.batch(
        resolved.map((user) =>
          request.remove
            ? ctx.env.DB.prepare(
                `DELETE FROM pull_reviewers WHERE issue_id = ?1 AND user_id = ?2`,
              ).bind(row.issue_id, user.id)
            : ctx.env.DB.prepare(
                `INSERT INTO pull_reviewers (issue_id, user_id, requested_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (issue_id, user_id) DO NOTHING`,
              ).bind(row.issue_id, user.id, Date.now()),
        ),
      )

      if (!request.remove) {
        ctx.waitUntil(
          notifyThread(ctx.env, {
            subject: {
              repoId: found.repo.id,
              type: 'pull_request',
              id: row.issue_id,
              title: row.title,
              ref: String(row.number),
              url: `${ctx.origin}/${found.repo.owner_login}/${found.repo.name}/pulls/${row.number}`,
            },
            actorId: ctx.viewer.id!,
            reason: 'review_requested',
            userIds: resolved.map((user) => user.id),
          }).catch(() => {}),
        )
      }

      return create(RequestReviewersResponseSchema, {})
    },

    async mergePull(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      requireViewerId(ctx)
      if (!atLeast(found.access.permission, 'write')) {
        throw ForgeError.permissionDenied('You need write access to merge')
      }
      if (!found.access.canWrite) {
        throw new ForgeError('failed_precondition', 'This repository is archived')
      }

      const row = await findPull(ctx, found.repo.id, request.number)
      if (row.merged === 1) {
        throw new ForgeError('failed_precondition', 'This pull request has already been merged')
      }
      if (row.state === 'closed') {
        throw new ForgeError('failed_precondition', 'This pull request is closed')
      }
      if (row.draft === 1) {
        throw new ForgeError('failed_precondition', 'This pull request is a draft')
      }

      const live = await resolveBranches(ctx, found.repo, row)

      // Guard against the branch moving since the client read the page.
      if (request.expectedHeadSha && request.expectedHeadSha !== live.headSha) {
        throw new ForgeError(
          'conflict',
          'The head branch has moved since this page was loaded. Reload and try again.',
        )
      }

      if (live.mergeable === MergeableState.EMPTY) {
        throw new ForgeError('failed_precondition', 'There is nothing to merge')
      }

      // Only fast-forward merges are possible. Creating a merge commit means
      // writing new git objects, and Artifacts has no object-write API — the
      // binding creates whole repos, the REST API is read-only, and the git
      // protocol would require building a packfile with new tree and commit
      // objects. A fast-forward needs no new objects at all, so it reduces to a
      // ref update, which receive-pack can do with an empty pack.
      if (live.mergeable !== MergeableState.CLEAN) {
        throw new ForgeError(
          'failed_precondition',
          live.mergeable === MergeableState.BEHIND
            ? 'This branch is behind the base and cannot be fast-forwarded. Rebase it and push, then merge again.'
            : 'This branch has diverged from the base. Only fast-forward merges are supported — rebase onto the base branch and push, then merge again.',
        )
      }
      if (request.method !== MergeMethod.UNSPECIFIED && request.method !== MergeMethod.REBASE) {
        throw ForgeError.invalid(
          'Only fast-forward merges are supported; a merge or squash commit cannot be created through the Artifacts API.',
        )
      }

      await fastForward(ctx, found.repo, row.base_branch, live.baseSha, live.headSha)

      const now = Date.now()
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `UPDATE pull_requests SET merged = 1, merged_at = ?2, merged_by_id = ?3,
             merge_commit_sha = ?4, merge_method = 'fast-forward', head_sha = ?4, base_sha = ?4
           WHERE issue_id = ?1`,
        ).bind(row.issue_id, now, ctx.viewer.id, live.headSha),
        ctx.env.DB.prepare(
          `UPDATE issues SET state = 'closed', closed_at = ?2, updated_at = ?2 WHERE id = ?1`,
        ).bind(row.issue_id, now),
      ])

      const merged = await findPull(ctx, found.repo.id, request.number)

      emit(ctx, found.repo, 'pull_request', pullPayload('merged', {
        number: merged.number,
        title: merged.title,
        state: 'merged',
        baseBranch: merged.base_branch,
        headBranch: merged.head_branch,
        authorLogin: merged.author_login,
        mergeCommitSha: live.headSha,
      }))

      return create(MergePullResponseSchema, {
        pull: toPullRequest(merged, MergeableState.UNSPECIFIED),
        mergeCommitSha: live.headSha,
      })
    },
  })
}

// ── merging ──────────────────────────────────────────────────────────────────

/**
 * Moves the base branch to the head commit via receive-pack.
 *
 * The old SHA is sent so the server rejects the update if the branch moved in
 * between — a compare-and-swap, not a blind overwrite.
 */
async function fastForward(
  ctx: RequestContext,
  repo: RepoRow,
  branch: string,
  fromSha: string,
  toSha: string,
): Promise<void> {
  const artifacts = new ArtifactsClient(ctx.env)
  const token = await artifacts.mintToken(repo.artifacts_name, 'write', 300)
  const body = await buildReceivePackRequest({
    ref: `refs/heads/${branch}`,
    oldSha: fromSha,
    newSha: toSha,
  })

  const response = await fetch(`${artifacts.remoteFor(repo.artifacts_name)}/git-receive-pack`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-git-receive-pack-request',
      'User-Agent': 'git/2.45.0 (gitflare)',
    },
    body: body as BufferSource,
  })

  if (!response.ok) {
    throw new ForgeError('unavailable', `Artifacts rejected the merge (HTTP ${response.status})`)
  }

  // A push can fail with HTTP 200: the transport succeeded, the update did not.
  const result = parseReceivePackResponse(new Uint8Array(await response.arrayBuffer()))
  if (!result.ok) {
    throw new ForgeError('conflict', `Merge was rejected: ${result.error ?? 'unknown reason'}`)
  }
}

// ── branch resolution ────────────────────────────────────────────────────────

interface LiveBranches {
  baseSha: string
  headSha: string
  mergeBaseSha: string
  mergeable: MergeableState
}

/**
 * Reads both branches' current positions and works out whether they can merge.
 *
 * Always live: a stored SHA is only a record of where things stood when the row
 * was written, and merging against one would clobber whatever landed since.
 */
async function resolveBranches(
  ctx: RequestContext,
  repo: RepoRow,
  row: PullRow,
): Promise<LiveBranches> {
  const artifacts = new ArtifactsClient(ctx.env)
  const headRepo = await headRepoOf(ctx, repo, row)

  const [baseSha, headSha] = await Promise.all([
    resolveBranch(artifacts, repo.artifacts_name, row.base_branch),
    resolveBranch(artifacts, headRepo.artifacts_name, row.head_branch),
  ])

  if (!baseSha || !headSha) {
    return {
      baseSha: baseSha ?? '',
      headSha: headSha ?? '',
      mergeBaseSha: '',
      mergeable: MergeableState.UNKNOWN,
    }
  }

  if (baseSha === headSha) {
    return { baseSha, headSha, mergeBaseSha: baseSha, mergeable: MergeableState.EMPTY }
  }

  const ancestry = await ancestorsOf(artifacts, headRepo.artifacts_name, headSha)
  const mergeBase = await findMergeBase(artifacts, repo.artifacts_name, baseSha, headSha)

  let mergeable: MergeableState
  if (canFastForward(baseSha, headSha, ancestry)) {
    mergeable = MergeableState.CLEAN
  } else {
    // Base is not an ancestor of head. Either head is behind base (merge base
    // equals head — nothing to bring over) or they have diverged.
    mergeable = mergeBase === headSha ? MergeableState.BEHIND : MergeableState.CONFLICTED
  }

  return { baseSha, headSha, mergeBaseSha: mergeBase || baseSha, mergeable }
}

async function resolveBranch(
  artifacts: ArtifactsClient,
  name: string,
  branch: string,
): Promise<string | null> {
  const refs = await artifacts.listRefs(name)
  return refs.branches.find((item) => item.name === branch)?.sha ?? null
}

async function resolveRefToSha(
  artifacts: ArtifactsClient,
  name: string,
  ref: string,
): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(ref)) return ref
  const refs = await artifacts.listRefs(name)
  const match =
    refs.branches.find((item) => item.name === ref) ?? refs.tags.find((item) => item.name === ref)
  if (!match) throw ForgeError.notFound(`Ref "${ref}"`)
  return match.sha
}

/** First-parent-inclusive ancestry walk, bounded so a deep history cannot stall. */
async function ancestorsOf(
  artifacts: ArtifactsClient,
  name: string,
  sha: string,
): Promise<string[]> {
  const commits = await artifacts.log(name, { ref: sha, limit: ANCESTRY_LIMIT })
  return commits.map((commit) => commit.hash)
}

/**
 * Best common ancestor of two commits.
 *
 * Walks head's history and returns the first commit that also appears in base's.
 * Bounded by ANCESTRY_LIMIT, so on very long-lived branches it may return empty
 * — callers fall back to diffing against the base tip, which over-reports rather
 * than hiding changes.
 */
async function findMergeBase(
  artifacts: ArtifactsClient,
  name: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  if (baseSha === headSha) return baseSha

  const [baseAncestry, headAncestry] = await Promise.all([
    ancestorsOf(artifacts, name, baseSha),
    ancestorsOf(artifacts, name, headSha),
  ])

  const baseSet = new Set(baseAncestry)
  for (const commit of headAncestry) {
    if (baseSet.has(commit)) return commit
  }
  return ''
}

async function commitsBetween(
  artifacts: ArtifactsClient,
  name: string,
  headSha: string,
  mergeBaseSha: string,
): Promise<ArtifactsCommitObject[]> {
  if (!headSha) return []
  const commits = await artifacts.log(name, { ref: headSha, limit: ANCESTRY_LIMIT })

  const out: ArtifactsCommitObject[] = []
  for (const commit of commits) {
    if (commit.hash === mergeBaseSha) break
    out.push(commit)
  }
  return out
}

// ── diffing ──────────────────────────────────────────────────────────────────

/**
 * Diffs two commits by walking both trees and comparing blobs.
 *
 * Identical blob SHAs mean identical content, so unchanged files are skipped
 * without ever fetching them — which is what keeps this affordable on a repo
 * where a pull request touches three files out of three thousand.
 */
async function buildDiff(
  ctx: RequestContext,
  params: {
    baseRepo: string
    headRepo: string
    baseSha: string
    headSha: string
    path: string
    contextLines: number
  },
) {
  const artifacts = new ArtifactsClient(ctx.env)

  const [baseTree, headTree] = await Promise.all([
    params.baseSha ? flattenTree(artifacts, params.baseRepo, params.baseSha) : new Map(),
    flattenTree(artifacts, params.headRepo, params.headSha),
  ])

  const paths = new Set([...baseTree.keys(), ...headTree.keys()])
  const files = []
  let totalAdditions = 0
  let totalDeletions = 0
  let truncated = false

  for (const path of [...paths].sort()) {
    if (params.path && path !== params.path) continue

    const oldSha = baseTree.get(path)
    const newSha = headTree.get(path)
    if (oldSha === newSha) continue

    if (files.length >= MAX_DIFF_FILES) {
      truncated = true
      break
    }

    const status =
      oldSha === undefined
        ? FileStatus.ADDED
        : newSha === undefined
          ? FileStatus.DELETED
          : FileStatus.MODIFIED

    const [oldBytes, newBytes] = await Promise.all([
      oldSha ? artifacts.readBlob(params.baseRepo, oldSha) : Promise.resolve(null),
      newSha ? artifacts.readBlob(params.headRepo, newSha) : Promise.resolve(null),
    ])

    const binary =
      (oldBytes !== null && isProbablyBinary(oldBytes)) ||
      (newBytes !== null && isProbablyBinary(newBytes))

    if (binary) {
      files.push(
        create(FileDiffSchema, {
          path,
          status,
          isBinary: true,
          oldSha: oldSha ?? '',
          newSha: newSha ?? '',
        }),
      )
      continue
    }

    const decoder = new TextDecoder()
    let result
    try {
      result = diffText(
        oldBytes ? decoder.decode(oldBytes) : '',
        newBytes ? decoder.decode(newBytes) : '',
        params.contextLines,
      )
    } catch (error) {
      // A file too large to diff is reported as changed-but-not-shown, rather
      // than failing the whole pull request view.
      if (!(error instanceof DiffTooLargeError)) throw error
      files.push(
        create(FileDiffSchema, {
          path,
          status,
          truncated: true,
          oldSha: oldSha ?? '',
          newSha: newSha ?? '',
        }),
      )
      continue
    }

    totalAdditions += result.additions
    totalDeletions += result.deletions

    files.push(
      create(FileDiffSchema, {
        path,
        status,
        additions: result.additions,
        deletions: result.deletions,
        oldSha: oldSha ?? '',
        newSha: newSha ?? '',
        hunks: result.hunks.map((hunk) =>
          create(DiffHunkSchema, {
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            header: hunk.header,
            lines: hunk.lines.map((line) =>
              create(DiffLineSchema, {
                kind:
                  line.kind === 'add'
                    ? LineKind.ADD
                    : line.kind === 'delete'
                      ? LineKind.DELETE
                      : LineKind.CONTEXT,
                content: line.content,
                oldLine: line.oldLine,
                newLine: line.newLine,
              }),
            ),
          }),
        ),
      }),
    )
  }

  return { files, totalAdditions, totalDeletions, truncated }
}

/** Full path → blob SHA map for a commit. */
async function flattenTree(
  artifacts: ArtifactsClient,
  name: string,
  commitSha: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const commit = await artifacts.readCommit(name, commitSha)
  if (!commit) return out

  const queue: { sha: string; prefix: string }[] = [{ sha: commit.treeHash, prefix: '' }]
  while (queue.length > 0) {
    const level = queue.shift()!
    const entries = await artifacts.readTree(name, level.sha)
    if (!entries) continue

    for (const entry of entries) {
      const path = level.prefix ? `${level.prefix}/${entry.name}` : entry.name
      if (entry.type === 'tree') queue.push({ sha: entry.hash, prefix: path })
      // Submodules are gitlinks, not content; there is nothing to diff.
      else if (entry.type === 'blob') out.set(path, entry.hash)
    }
  }
  return out
}

// ── rows and mapping ─────────────────────────────────────────────────────────

const PULL_SELECT = `
  SELECT i.*, p.base_branch, p.base_sha, p.head_repo_id, p.head_branch, p.head_sha,
         p.draft, p.merged, p.merged_at, p.merged_by_id, p.merge_commit_sha,
         o.login AS author_login, o.display_name AS author_name, o.avatar_url AS author_avatar,
         ro.login AS repo_owner, r.name AS repo_name
  FROM issues i
  JOIN pull_requests p ON p.issue_id = i.id
  JOIN owners o ON o.id = i.author_id
  JOIN repos r ON r.id = i.repo_id
  JOIN owners ro ON ro.id = r.owner_id
`

interface ReviewRow {
  id: string
  issue_id: string
  author_id: string
  author_login: string
  author_name: string
  author_avatar: string
  state: string
  body: string
  commit_sha: string
  created_at: number
}

interface ReviewCommentRow {
  id: string
  review_id: string
  issue_id: string
  author_id: string
  author_login: string
  author_name: string
  author_avatar: string
  body: string
  path: string
  line: number
  commit_sha: string
  created_at: number
}

function reviewState(value: string): ReviewState {
  if (value === 'approved') return ReviewState.APPROVED
  if (value === 'changes_requested') return ReviewState.CHANGES_REQUESTED
  return ReviewState.COMMENTED
}

function reviewStateColumn(state: ReviewState): string {
  if (state === ReviewState.APPROVED) return 'approved'
  if (state === ReviewState.CHANGES_REQUESTED) return 'changes_requested'
  return 'commented'
}

interface PullRow {
  id: string
  issue_id: string
  repo_id: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  author_id: string
  author_login: string
  author_name: string
  author_avatar: string
  comment_count: number
  created_at: number
  updated_at: number
  closed_at: number | null
  base_branch: string
  base_sha: string
  head_repo_id: string | null
  head_branch: string
  head_sha: string
  draft: number
  merged: number
  merged_at: number | null
  merged_by_id: string | null
  merge_commit_sha: string
  repo_owner: string
  repo_name: string
}

async function findPull(ctx: RequestContext, repoId: string, number: number): Promise<PullRow> {
  const row = await ctx.env.DB.prepare(
    `${PULL_SELECT} WHERE i.repo_id = ?1 AND i.number = ?2`,
  )
    .bind(repoId, number)
    .first<PullRow>()
  if (!row) throw ForgeError.notFound(`Pull request #${number}`)
  // `issue_id` is the primary key of pull_requests; `i.*` supplies `id`.
  return { ...row, issue_id: row.id }
}

async function headRepoOf(ctx: RequestContext, repo: RepoRow, row: PullRow): Promise<RepoRow> {
  if (!row.head_repo_id || row.head_repo_id === repo.id) return repo
  const head = await ctx.env.DB.prepare(
    `SELECT r.*, o.login AS owner_login, o.kind AS owner_kind
     FROM repos r JOIN owners o ON o.id = r.owner_id WHERE r.id = ?1`,
  )
    .bind(row.head_repo_id)
    .first<RepoRow>()
  // A deleted fork leaves the pull request readable against the base repo
  // rather than 500ing the page.
  return head ?? repo
}

function toPullRequest(row: PullRow, mergeable: MergeableState, live?: LiveBranches) {
  const state =
    row.merged === 1 ? PullState.MERGED : row.state === 'open' ? PullState.OPEN : PullState.CLOSED

  return create(PullRequestSchema, {
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    state,
    author: create(UserSchema, {
      id: row.author_id,
      login: row.author_login,
      displayName: row.author_name || row.author_login,
      avatarUrl: row.author_avatar,
    }),
    base: create(PullBranchSchema, {
      repoFullName: `${row.repo_owner}/${row.repo_name}`,
      branch: row.base_branch,
      sha: live?.baseSha ?? row.base_sha,
    }),
    head: create(PullBranchSchema, {
      repoFullName: `${row.repo_owner}/${row.repo_name}`,
      branch: row.head_branch,
      sha: live?.headSha ?? row.head_sha,
    }),
    mergeBaseSha: live?.mergeBaseSha ?? '',
    mergeable,
    draft: row.draft === 1,
    commentCount: row.comment_count,
    createdAt: timestampFromDate(new Date(row.created_at)),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    ...(row.merged_at ? { mergedAt: timestampFromDate(new Date(row.merged_at)) } : {}),
    ...(row.closed_at ? { closedAt: timestampFromDate(new Date(row.closed_at)) } : {}),
    ...(row.merge_commit_sha ? { mergeCommitSha: row.merge_commit_sha } : {}),
  })
}

function toCommit(commit: ArtifactsCommitObject) {
  return create(CommitSchema, {
    sha: commit.hash,
    message: commit.message,
    author: create(SignatureSchema, {
      name: commit.author.name,
      email: commit.author.email,
      time: timestampFromDate(new Date(commit.author.time)),
    }),
    parents: commit.parents,
    treeSha: commit.treeHash,
  })
}

async function load(
  context: HandlerContext,
  owner: string,
  repo: string,
): Promise<{ ctx: RequestContext; found: RepoWithAccess }> {
  const ctx = contextFrom(context.values)
  const found = await requireRepo(ctx.env.DB, owner, repo, viewerOf(ctx))
  return { ctx, found }
}

function viewerOf(ctx: RequestContext) {
  return { id: ctx.viewer.id, isSiteAdmin: ctx.viewer.isSiteAdmin }
}

function requireViewerId(ctx: RequestContext): string {
  if (!ctx.viewer.id) throw ForgeError.unauthenticated()
  return ctx.viewer.id
}
