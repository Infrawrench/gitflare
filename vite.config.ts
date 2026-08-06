import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `vite dev` sets this; `vite build` does not.
const isDev = process.env.NODE_ENV !== 'production' && process.argv.includes('dev')

export default defineConfig({
  resolve: {
    // Mirrors the `~/*` path in tsconfig.json. Declared here too because the
    // dev SSR runner resolves modules itself and does not read tsconfig paths.
    alias: { '~': new URL('./src/', import.meta.url).pathname },
  },
  plugins: [
    // The Cloudflare plugin must come before tanstackStart(); it owns the `ssr`
    // environment that Start then builds into.
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // The Artifacts binding cannot be simulated locally, so `vite dev` would
      // open a remote proxy session and fail on a gated account. wrangler.dev.jsonc
      // omits it; see the comment at the top of that file.
      configPath: isDev ? './wrangler.dev.jsonc' : './wrangler.jsonc',
      auxiliaryWorkers: [
        // The CI Worker needs Artifacts and a container, neither of which runs
        // locally, so it is only built for deploys.
        ...(isDev ? [] : [{ configPath: './wrangler.ci.jsonc' }]),
        // The SSH worker needs Spectrum plus the inbound-TCP private beta, so it
        // stays out of the build until GITFLARE_SSH_ENABLED is set. See ssh/README.md.
        ...(process.env.GITFLARE_SSH_ENABLED === '1'
          ? [{ configPath: './wrangler.ssh.jsonc' }]
          : []),
      ],
    }),
    tanstackStart(),
    react(),
  ],
})
