import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'

export const Route = createFileRoute('/$owner_/$repo_/issues_/new')({
  component: NewIssue,
})

function NewIssue() {
  const { owner, repo } = Route.useParams()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  const create = useMutation({
    mutationFn: () => api.issue.createIssue({ owner, repo, title, body }),
    onSuccess: (result) => {
      if (!result.issue) return
      navigate({
        to: '/$owner/$repo/issues/$number',
        params: { owner, repo, number: String(result.issue.number) },
      })
    },
  })

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="issues" />

      <div className="page-head">
        <h2>New issue</h2>
      </div>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <label htmlFor="issue-title">Title</label>
        <input
          id="issue-title"
          type="text"
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />

        <label htmlFor="issue-body">Description</label>
        <textarea
          id="issue-body"
          rows={10}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />

        <div className="actions">
          <button
            type="submit"
            className="button button-primary"
            // The server rejects a whitespace-only title too; this just avoids a
            // pointless round trip.
            disabled={create.isPending || title.trim() === ''}
          >
            {create.isPending ? 'Submitting…' : 'Submit new issue'}
          </button>
        </div>
      </form>

      {create.isError && <GateNotice message={errorMessage(create.error)} />}
    </>
  )
}
