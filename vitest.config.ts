import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Migrations are read here, in Node, and handed to the tests through `provide`.
// workerd has no filesystem, so a test cannot read them itself — applying the
// real files is what makes these tests fail when a migration and a query drift
// apart, which is the entire reason for testing against D1 rather than mocks.
const migrations = await readD1Migrations(
  fileURLToPath(new URL('./migrations', import.meta.url)),
)

const alias = { '~': new URL('./src/', import.meta.url).pathname }

// Two projects, because most of this codebase is pure logic that does not need a
// workerd isolate. Running pkt-line parsing or diffing through the Workers pool
// would only make the suite slower and harder to debug.
//
//   unit    - parsers, diffing, name encoding, CI plan building
//   worker  - anything touching D1, KV, R2, or the Artifacts binding
//
// vitest-pool-workers 0.20 (the Vitest 4 rewrite) replaced defineWorkersProject
// with the cloudflareTest() plugin; the old `@cloudflare/vitest-pool-workers/config`
// entrypoint no longer exists.
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.test.jsonc' },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          setupFiles: ['./test/worker/setup.ts'],
          provide: { migrations },
        },
      },
    ],
  },
})
