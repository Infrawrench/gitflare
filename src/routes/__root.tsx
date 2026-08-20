import type { QueryClient } from '@tanstack/react-query'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { api } from '~/lib/connect'
import appCss from '~/styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Gitflare' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  component: RootComponent,
  errorComponent: ErrorPage,
  notFoundComponent: NotFound,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  return (
    <RootDocument>
      <QueryClientProvider client={queryClient}>
        <Header />
        <main className="container">
          <Outlet />
        </main>
      </QueryClientProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function Header() {
  // Failure here means "not signed in", which is a normal state rather than an
  // error worth surfacing — hence no error UI and no retry.
  const { data } = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => api.user.getCurrentUser({}),
    retry: false,
  })

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link to="/" className="brand">
          Gitflare
        </Link>
        <nav>
          <Link to="/search" search={{}} className="tab">
            Search
          </Link>
          {data?.user ? (
            <>
              <Link to="/notifications" search={{}} className="tab">
                Inbox
              </Link>
              <Link to="/settings" className="tab">
                Settings
              </Link>
              <Link to="/new" className="button button-primary">
                New repository
              </Link>
              <Link
                to="/$owner"
                params={{ owner: data.user.login }}
                className="avatar-link"
              >
                {data.user.login}
              </Link>
              {/* Plain anchors: both are Worker routes, not client routes, and
                  sign-out must reach the server to revoke the session. */}
              <a href="/auth/logout" className="tab">
                Sign out
              </a>
            </>
          ) : (
            <a href="/auth/dev-login" className="tab">
              Sign in
            </a>
          )}
        </nav>
      </div>
    </header>
  )
}

function ErrorPage({ error }: { error: Error }) {
  return (
    <div className="notice notice-error">
      <h2>Something went wrong</h2>
      <p>{error.message}</p>
    </div>
  )
}

function NotFound() {
  return (
    <div className="notice">
      <h2>Not found</h2>
      <p>
        That page does not exist, or you do not have access to it. <Link to="/">Go home</Link>.
      </p>
    </div>
  )
}
