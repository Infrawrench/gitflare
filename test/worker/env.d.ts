import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare module 'vitest' {
  interface ProvidedContext {
    /** Read from disk in vitest.config.ts, because workerd has no filesystem. */
    migrations: D1Migration[]
  }
}
