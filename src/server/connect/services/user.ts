import { create } from '@bufbuild/protobuf'
import { timestampFromDate } from '@bufbuild/protobuf/wkt'
import type { ConnectRouter } from '@connectrpc/connect'
import {
  UserService,
  UserSchema,
  SshKeySchema,
  AccessTokenSchema,
  GetCurrentUserResponseSchema,
  GetUserResponseSchema,
  UpdateCurrentUserResponseSchema,
  ListSshKeysResponseSchema,
  CreateSshKeyResponseSchema,
  DeleteSshKeyResponseSchema,
  ListAccessTokensResponseSchema,
  CreateAccessTokenResponseSchema,
  DeleteAccessTokenResponseSchema,
} from '~/gen/forge/v1/user_pb'
import { findUser, type UserRow } from '../../db/owners'
import { ForgeError } from '../../errors'
import { newId } from '../../ids'
import { generatePat } from '../../auth/tokens'
import { fingerprintSshKey, parseSshPublicKey } from '../../auth/ssh-keys'
import { contextFrom, type RequestContext } from '../router'

/**
 * Account, SSH key, and personal access token management.
 *
 * All of it is self-scoped: there is no path here that reads or writes another
 * user's keys or tokens, which is why none of these methods take a user
 * parameter.
 */

export function registerUserService(router: ConnectRouter): void {
  router.service(UserService, {
    async getCurrentUser(_request, context) {
      const ctx = contextFrom(context.values)
      if (!ctx.viewer.login) throw ForgeError.unauthenticated()

      const user = await findUser(ctx.env.DB, ctx.viewer.login)
      if (!user) throw ForgeError.notFound('User')

      return create(GetCurrentUserResponseSchema, {
        user: toUser(user),
        // False when the caller used a PAT. The UI hides session-only actions,
        // since a token is not a browser session.
        isSession: ctx.viewer.isSession,
      })
    },

    async getUser(request, context) {
      const ctx = contextFrom(context.values)
      const user = await findUser(ctx.env.DB, request.login)
      if (!user) throw ForgeError.notFound('User')
      return create(GetUserResponseSchema, { user: toUser(user) })
    },

    async updateCurrentUser(request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)

      const sets: string[] = []
      const binds: unknown[] = [viewerId]
      if (request.displayName !== undefined) {
        binds.push(request.displayName)
        sets.push(`display_name = ?${binds.length}`)
      }
      if (request.avatarUrl !== undefined) {
        binds.push(request.avatarUrl)
        sets.push(`avatar_url = ?${binds.length}`)
      }

      if (sets.length > 0) {
        binds.push(Date.now())
        await ctx.env.DB.prepare(
          `UPDATE owners SET ${sets.join(', ')}, updated_at = ?${binds.length} WHERE id = ?1`,
        )
          .bind(...binds)
          .run()
      }

      const user = await findUser(ctx.env.DB, ctx.viewer.login!)
      if (!user) throw ForgeError.notFound('User')
      return create(UpdateCurrentUserResponseSchema, { user: toUser(user) })
    },

    async listSshKeys(_request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)

      const rows = await ctx.env.DB.prepare(
        `SELECT * FROM ssh_keys WHERE user_id = ?1 ORDER BY created_at DESC`,
      )
        .bind(viewerId)
        .all<SshKeyRow>()

      return create(ListSshKeysResponseSchema, {
        keys: (rows.results ?? []).map(toSshKey),
      })
    },

    async createSshKey(request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)

      // Parsing rather than storing the string verbatim: a malformed key would
      // otherwise sit in the table and fail silently at SSH time, long after the
      // user could connect the two events.
      const parsed = parseSshPublicKey(request.publicKey)
      const fingerprint = await fingerprintSshKey(parsed)

      const existing = await ctx.env.DB.prepare(
        `SELECT user_id FROM ssh_keys WHERE fingerprint = ?1`,
      )
        .bind(fingerprint)
        .first<{ user_id: string }>()

      if (existing) {
        // Global uniqueness matters: sshd resolves a key to a user by
        // fingerprint alone, so the same key on two accounts would be ambiguous.
        throw new ForgeError(
          'already_exists',
          existing.user_id === viewerId
            ? 'You have already added this key'
            : 'This key is already registered to another account',
        )
      }

      const id = newId()
      const now = Date.now()
      await ctx.env.DB.prepare(
        `INSERT INTO ssh_keys (id, user_id, title, public_key, fingerprint, key_type, read_only, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
        .bind(
          id,
          viewerId,
          request.title || parsed.comment || parsed.type,
          `${parsed.type} ${parsed.body}`,
          fingerprint,
          parsed.type,
          request.readOnly ? 1 : 0,
          now,
        )
        .run()

      return create(CreateSshKeyResponseSchema, {
        key: create(SshKeySchema, {
          id,
          title: request.title || parsed.comment || parsed.type,
          publicKey: `${parsed.type} ${parsed.body}`,
          fingerprint,
          readOnly: request.readOnly,
          createdAt: timestampFromDate(new Date(now)),
        }),
      })
    },

    async deleteSshKey(request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)
      // Scoped by user_id so an id from another account cannot be deleted.
      await ctx.env.DB.prepare(`DELETE FROM ssh_keys WHERE id = ?1 AND user_id = ?2`)
        .bind(request.id, viewerId)
        .run()
      return create(DeleteSshKeyResponseSchema, {})
    },

    async listAccessTokens(_request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)

      const rows = await ctx.env.DB.prepare(
        `SELECT * FROM access_tokens WHERE user_id = ?1 ORDER BY created_at DESC`,
      )
        .bind(viewerId)
        .all<AccessTokenRow>()

      return create(ListAccessTokensResponseSchema, {
        tokens: (rows.results ?? []).map(toAccessToken),
      })
    },

    async createAccessToken(request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)

      // A PAT is the credential for git-over-HTTPS, so minting one from a
      // request that itself only presented a PAT would let a leaked token renew
      // itself indefinitely. Require a real session.
      if (!ctx.viewer.isSession) {
        throw ForgeError.permissionDenied('Access tokens can only be created from a signed-in session')
      }

      const generated = await generatePat()
      const id = newId()
      const now = Date.now()
      const expiresAt = request.ttlSeconds ? now + Number(request.ttlSeconds) * 1000 : null

      await ctx.env.DB.prepare(
        `INSERT INTO access_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
        .bind(
          id,
          viewerId,
          request.name || 'token',
          generated.hash,
          generated.prefix,
          JSON.stringify(request.scopes),
          now,
          expiresAt,
        )
        .run()

      return create(CreateAccessTokenResponseSchema, {
        token: create(AccessTokenSchema, {
          id,
          name: request.name || 'token',
          scopes: request.scopes,
          createdAt: timestampFromDate(new Date(now)),
          ...(expiresAt ? { expiresAt: timestampFromDate(new Date(expiresAt)) } : {}),
        }),
        // Returned exactly once. Only the hash is persisted, so this value can
        // never be recovered afterwards.
        plaintext: generated.plaintext,
      })
    },

    async deleteAccessToken(request, context) {
      const ctx = contextFrom(context.values)
      const viewerId = requireViewerId(ctx)
      await ctx.env.DB.prepare(`DELETE FROM access_tokens WHERE id = ?1 AND user_id = ?2`)
        .bind(request.id, viewerId)
        .run()
      return create(DeleteAccessTokenResponseSchema, {})
    },
  })
}

interface SshKeyRow {
  id: string
  title: string
  public_key: string
  fingerprint: string
  read_only: number
  created_at: number
  last_used_at: number | null
}

interface AccessTokenRow {
  id: string
  name: string
  scopes: string
  created_at: number
  expires_at: number | null
  last_used_at: number | null
}

function requireViewerId(ctx: RequestContext): string {
  if (!ctx.viewer.id) throw ForgeError.unauthenticated()
  return ctx.viewer.id
}

function toUser(row: UserRow) {
  return create(UserSchema, {
    id: row.id,
    login: row.login,
    email: row.email,
    displayName: row.display_name || row.login,
    avatarUrl: row.avatar_url,
    isAdmin: row.is_admin === 1,
    createdAt: timestampFromDate(new Date(row.created_at)),
  })
}

function toSshKey(row: SshKeyRow) {
  return create(SshKeySchema, {
    id: row.id,
    title: row.title,
    publicKey: row.public_key,
    fingerprint: row.fingerprint,
    readOnly: row.read_only === 1,
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.last_used_at ? { lastUsedAt: timestampFromDate(new Date(row.last_used_at)) } : {}),
  })
}

function toAccessToken(row: AccessTokenRow) {
  return create(AccessTokenSchema, {
    id: row.id,
    name: row.name,
    scopes: safeParseScopes(row.scopes),
    createdAt: timestampFromDate(new Date(row.created_at)),
    ...(row.expires_at ? { expiresAt: timestampFromDate(new Date(row.expires_at)) } : {}),
    ...(row.last_used_at ? { lastUsedAt: timestampFromDate(new Date(row.last_used_at)) } : {}),
  })
}

function safeParseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}
