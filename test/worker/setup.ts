import { applyD1Migrations } from 'cloudflare:test'
import { inject } from 'vitest'
import { testEnv } from './helpers'

/**
 * Applies the real migration files once, before any worker test runs.
 *
 * The files are read in Node by `vitest.config.ts` and passed through `provide`,
 * because workerd has no filesystem. Applying the actual migrations — rather
 * than a schema written out by hand for tests — is what makes these tests fail
 * if a migration and the queries that depend on it ever drift apart.
 */
await applyD1Migrations(testEnv.DB, inject('migrations'))
