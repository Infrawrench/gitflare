import { useMutation } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { Visibility } from '~/gen/forge/v1/common_pb'
import { GateNotice } from '~/components/GateNotice'

export const Route = createFileRoute('/new')({
  component: NewRepo,
})

type Mode = 'create' | 'import'

function NewRepo() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('create')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [cloneUrl, setCloneUrl] = useState('')

  const create = useMutation({
    mutationFn: async () => {
      const visibility = isPrivate ? Visibility.PRIVATE : Visibility.PUBLIC
      if (mode === 'import') {
        const result = await api.repo.importRepo({
          owner: '',
          name,
          cloneUrl,
          description,
          visibility,
        })
        return result.repo
      }
      const result = await api.repo.createRepo({
        owner: '',
        name,
        description,
        visibility,
        defaultBranch: 'main',
        autoInit: true,
        hasWiki: true,
        hasIssues: true,
      })
      return result.repo
    },
    onSuccess: (repo) => {
      if (!repo?.owner) return
      navigate({
        to: '/$owner/$repo',
        params: { owner: repo.owner.login, repo: repo.name },
        search: {},
      })
    },
  })

  return (
    <>
      <div className="page-head">
        <h1>New repository</h1>
      </div>

      <div className="repo-toolbar">
        <button
          type="button"
          className="button"
          aria-pressed={mode === 'create'}
          onClick={() => setMode('create')}
        >
          Create empty
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={mode === 'import'}
          onClick={() => setMode('import')}
        >
          Import from a git remote
        </button>
      </div>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        {mode === 'import' && (
          <>
            <label htmlFor="clone-url">Source URL</label>
            <input
              id="clone-url"
              type="text"
              required
              placeholder="https://github.com/owner/repo.git"
              value={cloneUrl}
              onChange={(event) => setCloneUrl(event.target.value)}
            />
            <p className="hint">
              Must be a public HTTPS git remote — Artifacts clones it server-side and cannot prompt
              for credentials.
            </p>
          </>
        )}

        <label htmlFor="repo-name">Repository name</label>
        <input
          id="repo-name"
          type="text"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="hint">
          Letters, numbers, dots, hyphens, and underscores. Consecutive hyphens are not allowed —
          repository storage encodes <code>owner/repo</code> as <code>owner--repo</code>, so they
          would be ambiguous.
        </p>

        <label htmlFor="repo-description">Description</label>
        <input
          id="repo-description"
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <label>
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(event) => setIsPrivate(event.target.checked)}
          />{' '}
          Private
        </label>

        <div className="actions">
          <button type="submit" className="button button-primary" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : mode === 'import' ? 'Import' : 'Create repository'}
          </button>
        </div>
      </form>

      {create.isError && <GateNotice message={errorMessage(create.error)} />}
    </>
  )
}
