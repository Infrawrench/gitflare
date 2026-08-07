import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'

export const Route = createFileRoute('/$owner_/$repo_/wiki')({
  validateSearch: (search: Record<string, unknown>): { page?: string; edit?: boolean } => ({
    ...(typeof search.page === 'string' ? { page: search.page } : {}),
    ...(search.edit === true || search.edit === 'true' ? { edit: true } : {}),
  }),
  component: WikiPage,
})

function WikiPage() {
  const { owner, repo } = Route.useParams()
  const { page = 'Home', edit = false } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()

  const pages = useQuery({
    queryKey: ['wiki', owner, repo],
    queryFn: () => api.wiki.listWikiPages({ owner, repo }),
  })

  const current = useQuery({
    queryKey: ['wiki-page', owner, repo, page],
    queryFn: () => api.wiki.getWikiPage({ owner, repo, slug: page, ref: '' }),
    // A page that does not exist yet is a normal state — the editor opens on it.
    retry: false,
  })

  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (current.data?.page) setDraft(current.data.page.content)
  }, [current.data])

  const save = useMutation({
    mutationFn: () =>
      api.wiki.saveWikiPage({
        owner,
        repo,
        slug: page,
        title: page,
        content: draft,
        commitMessage: `Update ${page}`,
        // Sent so the server refuses if the page changed while this was open.
        ...(current.data?.page?.commitSha
          ? { expectedCommitSha: current.data.page.commitSha }
          : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['wiki', owner, repo] })
      void queryClient.invalidateQueries({ queryKey: ['wiki-page', owner, repo, page] })
      navigate({ search: { page } })
    },
  })

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="wiki" />

      <div className="page-head">
        <h2>{page}</h2>
        <button
          type="button"
          className="button"
          onClick={() => navigate({ search: { page, ...(edit ? {} : { edit: true }) } })}
        >
          {edit ? 'Cancel' : 'Edit'}
        </button>
      </div>

      {pages.data?.initialized === false && (
        <div className="notice">
          This wiki has no pages yet. Editing one creates the wiki repository, which can then be
          cloned and pushed to like any other.
        </div>
      )}

      {pages.data && pages.data.pages.length > 0 && (
        <nav className="wiki-index">
          {pages.data.pages.map((entry) => (
            <a key={entry.slug} href={`?page=${encodeURIComponent(entry.slug)}`} className="tab">
              {entry.title}
            </a>
          ))}
        </nav>
      )}

      {pages.isError && <GateNotice message={errorMessage(pages.error)} />}

      {edit ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <label htmlFor="wiki-body">Content (Markdown)</label>
          <textarea
            id="wiki-body"
            rows={20}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save page'}
            </button>
          </div>
          {save.isError && <GateNotice message={errorMessage(save.error)} />}
        </form>
      ) : current.isError ? (
        <div className="notice">
          <p>This page does not exist yet.</p>
          <p className="muted">Use Edit to create it.</p>
        </div>
      ) : (
        /* Rendered as plain text: the server deliberately does not generate HTML
           from repository content, so there is nothing here to sanitize. */
        <pre className="wiki-body">{current.data?.page?.content ?? ''}</pre>
      )}
    </>
  )
}
