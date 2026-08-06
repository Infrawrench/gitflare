import { QueryClient } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/**
 * Router factory. TanStack Start calls this on both the server and the client,
 * so a fresh QueryClient is created per request rather than shared at module
 * scope — a module-level client on the server would leak one user's cached data
 * into another's render.
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Repo pages read git data that only changes on push; a short window
        // avoids refetching the tree on every navigation without going stale.
        staleTime: 30_000,
        retry: false,
      },
    },
  })

  return createTanStackRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
