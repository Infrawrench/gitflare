import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter, HandlerContext } from '@connectrpc/connect'
import {
  ReleaseService,
  ReleaseSchema,
  ReleaseAssetSchema,
  ListReleasesResponseSchema,
  GetReleaseResponseSchema,
  CreateReleaseResponseSchema,
  UpdateReleaseResponseSchema,
  DeleteReleaseResponseSchema,
  CreateAssetUploadResponseSchema,
  DeleteAssetResponseSchema,
} from '~/gen/forge/v1/release_pb'
import { PageResponseSchema } from '~/gen/forge/v1/common_pb'
import { UserSchema } from '~/gen/forge/v1/user_pb'
import { requireRepo, type RepoWithAccess } from '../../db/repos'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import { atLeast } from '../../auth/rbac'
import { contextFrom, type RequestContext } from '../router'
import { emit } from '../../events/emit'

/**
 * Releases and their attached files.
 *
 * Metadata lives in D1 and asset bodies in R2, which is deliberate: R2 is not
 * gated the way Artifacts is, so releases work today even though the tag they
 * name cannot be read yet.
 *
 * Asset uploads go over a plain HTTP PUT rather than through gRPC. gRPC-web
 * cannot stream a request body from a browser, so an upload would have to be
 * buffered entirely in memory — which is exactly wrong for the one part of this
 * API that handles large files.
 */

/** Above this, an upload is refused rather than buffered anywhere. */
const MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024

export function registerReleaseService(router: ConnectRouter): void {
  router.service(ReleaseService, {
    async listReleases(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const limit = Math.min(Math.max(request.page?.limit || 30, 1), 100)

      // Drafts are visible only to people who could publish them.
      const canSeeDrafts = atLeast(found.access.permission, 'write')
      const rows = await ctx.env.DB.prepare(
        `SELECT r.*, o.login AS author_login FROM releases r
         JOIN owners o ON o.id = r.author_id
         WHERE r.repo_id = ?1 ${canSeeDrafts && request.includeDrafts ? '' : 'AND r.draft = 0'}
         ORDER BY r.created_at DESC LIMIT ?2`,
      )
        .bind(found.repo.id, limit)
        .all<ReleaseRow>()

      const releases = rows.results ?? []
      const assets = await loadAssets(ctx, releases.map((row) => row.id))

      return create(ListReleasesResponseSchema, {
        releases: releases.map((row) => toRelease(row, assets.get(row.id) ?? [], ctx, found)),
        page: create(PageResponseSchema, {}),
      })
    },

    async getRelease(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo)
      const row = await findRelease(ctx, found.repo.id, request.tagName)
      if (row.draft === 1 && !atLeast(found.access.permission, 'write')) {
        throw ForgeError.notFound('Release')
      }
      const assets = await loadAssets(ctx, [row.id])
      return create(GetReleaseResponseSchema, {
        release: toRelease(row, assets.get(row.id) ?? [], ctx, found),
      })
    },

    async createRelease(request, context) {
      const { ctx, found } = await load(context, request.owner, request.repo, 'write')
      const author = requireViewerId(ctx)

      if (request.tagName.trim() === '') throw ForgeError.invalid('A tag name is required')

      const id = newId()
      const now = Date.now()
      try {
        await ctx.env.DB.prepare(
          `INSERT INTO releases (id, repo_id, tag_name, target, name, body, draft, prerelease, author_id, created_at, published_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
          .bind(
            id,
            found.repo.id,
            request.tagName,
            request.target || found.repo.default_branch,
            request.name || request.tagName,
            request.body,
            request.draft ? 1 : 0,
            request.prerelease ? 1 : 0,
            author,
            now,
            // A draft has no publication date until it is published.
            request.draft ? null : now,
          )
          .run()
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
          throw new ForgeError('already_exists', `A release for "${request.tagName}" already exists`)
        }
        throw error
      }

      if (!request.draft) {
        emit(ctx, found.repo, 'release', {
          action: 'published',
          release: { tagName: request.tagName, name: request.name || request.tagName },
        })
      }

      const row = await findRelease(ctx, found.repo.id, request.tagName)
      return create(CreateReleaseResponseSchema, { release: toRelease(row, [], ctx, found) })
    },

    async updateRelease(request, context) {
      const ctx = contextFrom(context.values)
      const { row, found } = await requireReleaseById(ctx, request.releaseId, 'write')

      const wasDraft = row.draft === 1
      const nowDraft = request.draft ?? wasDraft

      await ctx.env.DB.prepare(
        `UPDATE releases SET name = ?2, body = ?3, draft = ?4, prerelease = ?5, published_at = ?6
         WHERE id = ?1`,
      )
        .bind(
          row.id,
          request.name ?? row.name,
          request.body ?? row.body,
          nowDraft ? 1 : 0,
          request.prerelease !== undefined ? (request.prerelease ? 1 : 0) : row.prerelease,
          // Publishing stamps the date; unpublishing back to a draft clears it.
          nowDraft ? null : (row.published_at ?? Date.now()),
        )
        .run()

      if (wasDraft && !nowDraft) {
        emit(ctx, found.repo, 'release', {
          action: 'published',
          release: { tagName: row.tag_name, name: request.name ?? row.name },
        })
      }

      const updated = await findRelease(ctx, found.repo.id, row.tag_name)
      const assets = await loadAssets(ctx, [updated.id])
      return create(UpdateReleaseResponseSchema, {
        release: toRelease(updated, assets.get(updated.id) ?? [], ctx, found),
      })
    },

    async deleteRelease(request, context) {
      const ctx = contextFrom(context.values)
      const { row } = await requireReleaseById(ctx, request.releaseId, 'maintain')

      // R2 objects are removed first: a release row deleted while its bodies
      // remain would leave objects nothing references and nothing can find.
      const assets = await ctx.env.DB.prepare(
        `SELECT r2_key FROM release_assets WHERE release_id = ?1`,
      )
        .bind(row.id)
        .all<{ r2_key: string }>()

      await Promise.all(
        (assets.results ?? []).map((asset) => ctx.env.ASSETS_BUCKET.delete(asset.r2_key)),
      )
      await ctx.env.DB.prepare(`DELETE FROM releases WHERE id = ?1`).bind(row.id).run()

      return create(DeleteReleaseResponseSchema, {})
    },

    async createAssetUpload(request, context) {
      const ctx = contextFrom(context.values)
      const { row, found } = await requireReleaseById(ctx, request.releaseId, 'write')

      if (request.size > MAX_ASSET_BYTES) {
        throw ForgeError.invalid('Asset exceeds the 2 GiB limit')
      }
      if (request.name.includes('/') || request.name.includes('\\')) {
        // The name becomes part of an R2 key and a download URL; a path
        // separator would let one release write into another's prefix.
        throw ForgeError.invalid('Asset name must not contain a path separator')
      }

      const assetId = newId()
      const key = `releases/${found.repo.id}/${row.id}/${assetId}/${request.name}`

      await ctx.env.DB.prepare(
        `INSERT INTO release_assets (id, release_id, name, r2_key, size, content_type, uploaded, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)
         ON CONFLICT (release_id, name) DO UPDATE SET
           r2_key = excluded.r2_key, size = excluded.size, content_type = excluded.content_type, uploaded = 0`,
      )
        .bind(assetId, row.id, request.name, key, request.size, request.contentType, Date.now())
        .run()

      return create(CreateAssetUploadResponseSchema, {
        assetId,
        // The client PUTs the bytes here; the route marks the row uploaded when
        // the body lands, so a half-finished upload never appears in a listing.
        uploadUrl: `${ctx.origin}/${found.repo.owner_login}/${found.repo.name}/releases/assets/${assetId}`,
      })
    },

    async deleteAsset(request, context) {
      const ctx = contextFrom(context.values)
      const asset = await ctx.env.DB.prepare(
        `SELECT a.*, r.repo_id FROM release_assets a JOIN releases r ON r.id = a.release_id
         WHERE a.id = ?1`,
      )
        .bind(request.assetId)
        .first<AssetRow & { repo_id: string }>()
      if (!asset) throw ForgeError.notFound('Asset')

      await requireReleaseAccess(ctx, asset.repo_id, 'write')
      await ctx.env.ASSETS_BUCKET.delete(asset.r2_key)
      await ctx.env.DB.prepare(`DELETE FROM release_assets WHERE id = ?1`)
        .bind(request.assetId)
        .run()

      return create(DeleteAssetResponseSchema, {})
    },
  })
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface ReleaseRow {
  id: string
  repo_id: string
  tag_name: string
  target: string
  name: string
  body: string
  draft: number
  prerelease: number
  author_id: string
  author_login: string
  created_at: number
  published_at: number | null
}

interface AssetRow {
  id: string
  release_id: string
  name: string
  r2_key: string
  size: number
  content_type: string
  download_count: number
  uploaded: number
  created_at: number
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
  return { ctx, found }
}

function requireViewerId(ctx: RequestContext): string {
  if (!ctx.viewer.id) throw ForgeError.unauthenticated()
  return ctx.viewer.id
}

async function findRelease(
  ctx: RequestContext,
  repoId: string,
  tagName: string,
): Promise<ReleaseRow> {
  const row = await ctx.env.DB.prepare(
    `SELECT r.*, o.login AS author_login FROM releases r
     JOIN owners o ON o.id = r.author_id
     WHERE r.repo_id = ?1 AND r.tag_name = ?2`,
  )
    .bind(repoId, tagName)
    .first<ReleaseRow>()
  if (!row) throw ForgeError.notFound('Release')
  return row
}

/** Loads a release by id and re-authorizes against its repo. */
async function requireReleaseById(
  ctx: RequestContext,
  releaseId: string,
  required: 'write' | 'maintain',
): Promise<{ row: ReleaseRow; found: RepoWithAccess }> {
  const row = await ctx.env.DB.prepare(
    `SELECT r.*, o.login AS author_login FROM releases r
     JOIN owners o ON o.id = r.author_id WHERE r.id = ?1`,
  )
    .bind(releaseId)
    .first<ReleaseRow>()
  if (!row) throw ForgeError.notFound('Release')

  const found = await requireReleaseAccess(ctx, row.repo_id, required)
  return { row, found }
}

async function requireReleaseAccess(
  ctx: RequestContext,
  repoId: string,
  required: 'write' | 'maintain',
): Promise<RepoWithAccess> {
  const repo = await ctx.env.DB.prepare(
    `SELECT o.login AS owner, r.name FROM repos r JOIN owners o ON o.id = r.owner_id
     WHERE r.id = ?1`,
  )
    .bind(repoId)
    .first<{ owner: string; name: string }>()
  if (!repo) throw ForgeError.notFound('Release')

  return requireRepo(
    ctx.env.DB,
    repo.owner,
    repo.name,
    { id: ctx.viewer.id, isSiteAdmin: ctx.viewer.isSiteAdmin },
    required,
  )
}

async function loadAssets(
  ctx: RequestContext,
  releaseIds: string[],
): Promise<Map<string, AssetRow[]>> {
  const byRelease = new Map<string, AssetRow[]>()
  if (releaseIds.length === 0) return byRelease

  const placeholders = releaseIds.map((_, index) => `?${index + 1}`).join(', ')
  const rows = await ctx.env.DB.prepare(
    // Incomplete uploads are hidden: an asset row exists from the moment the
    // upload URL is issued, but there is nothing to download until it lands.
    `SELECT * FROM release_assets WHERE release_id IN (${placeholders}) AND uploaded = 1
     ORDER BY name`,
  )
    .bind(...releaseIds)
    .all<AssetRow>()

  for (const row of rows.results ?? []) {
    const group = byRelease.get(row.release_id)
    if (group) group.push(row)
    else byRelease.set(row.release_id, [row])
  }
  return byRelease
}

function toRelease(
  row: ReleaseRow,
  assets: AssetRow[],
  ctx: RequestContext,
  found: RepoWithAccess,
) {
  const base = `${ctx.origin}/${found.repo.owner_login}/${found.repo.name}`
  return create(ReleaseSchema, {
    id: row.id,
    tagName: row.tag_name,
    target: row.target,
    name: row.name,
    body: row.body,
    bodyHtml: '',
    draft: row.draft === 1,
    prerelease: row.prerelease === 1,
    author: create(UserSchema, { id: row.author_id, login: row.author_login }),
    assets: assets.map((asset) =>
      create(ReleaseAssetSchema, {
        id: asset.id,
        name: asset.name,
        size: BigInt(asset.size),
        contentType: asset.content_type,
        downloadCount: asset.download_count,
        downloadUrl: `${base}/releases/assets/${asset.id}`,
        createdAt: timestampFromDate(new Date(asset.created_at)),
      }),
    ),
    // Generated on demand from the tag's tree rather than stored.
    tarballUrl: `${base}/archive/${row.tag_name}.tar.gz`,
    zipballUrl: `${base}/archive/${row.tag_name}.zip`,
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.published_at ? { publishedAt: timestampFromDate(new Date(row.published_at)) } : {}),
  })
}
