import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { GateNotice } from '~/components/GateNotice'
import { relativeTime } from '~/lib/format'

export const Route = createFileRoute('/settings')({
  component: Settings,
})

function Settings() {
  const me = useQuery({
    queryKey: ['currentUser'],
    queryFn: () => api.user.getCurrentUser({}),
  })

  if (me.isError) return <GateNotice message={errorMessage(me.error)} />
  if (!me.data?.user) return <p className="muted">Loading…</p>

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <p className="muted">
        Signed in as <strong>{me.data.user.login}</strong>
        {me.data.user.email && ` (${me.data.user.email})`}
      </p>

      {!me.data.isSession && (
        <div className="notice notice-warning">
          You are authenticated with a personal access token. Creating new tokens requires a
          signed-in session, so that a leaked token cannot renew itself.
        </div>
      )}

      <AccessTokens canCreate={me.data.isSession} />
      <SshKeys />
    </>
  )
}

function AccessTokens({ canCreate }: { canCreate: boolean }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [plaintext, setPlaintext] = useState<string | null>(null)

  const tokens = useQuery({
    queryKey: ['tokens'],
    queryFn: () => api.user.listAccessTokens({}),
  })

  const create = useMutation({
    mutationFn: () => api.user.createAccessToken({ name, scopes: [] }),
    onSuccess: (result) => {
      // Shown once, here, because only a hash is stored — there is no way to
      // retrieve it later, and saying so at the moment it appears is the only
      // useful time to say it.
      setPlaintext(result.plaintext)
      setName('')
      void queryClient.invalidateQueries({ queryKey: ['tokens'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.user.deleteAccessToken({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  })

  return (
    <section className="settings-section">
      <h2>Personal access tokens</h2>
      <p className="muted">
        Use a token as the password when cloning over HTTPS, and as a bearer token for the API.
      </p>

      {plaintext && (
        <div className="notice notice-warning">
          <p>
            <strong>Copy this now — it will not be shown again.</strong>
          </p>
          <p>
            <code className="token-reveal">{plaintext}</code>
          </p>
        </div>
      )}

      {canCreate && (
        <form
          className="repo-toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim()) create.mutate()
          }}
        >
          <input
            type="text"
            className="search-input"
            placeholder="Token name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Token name"
          />
          <button type="submit" className="button button-primary" disabled={create.isPending}>
            Generate token
          </button>
        </form>
      )}

      {create.isError && <GateNotice message={errorMessage(create.error)} />}

      <ul className="issue-list">
        {tokens.data?.tokens.map((token) => (
          <li key={token.id} className="issue-row">
            <div>
              <span className="issue-title">{token.name}</span>
              <div className="muted issue-meta">
                Created {token.createdAt && relativeTime(token.createdAt)}
                {token.lastUsedAt
                  ? ` · last used ${relativeTime(token.lastUsedAt)}`
                  : ' · never used'}
              </div>
            </div>
            <button type="button" className="button" onClick={() => remove.mutate(token.id)}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {tokens.data?.tokens.length === 0 && <p className="muted">No tokens yet.</p>}
    </section>
  )
}

function SshKeys() {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [publicKey, setPublicKey] = useState('')

  const keys = useQuery({
    queryKey: ['sshKeys'],
    queryFn: () => api.user.listSshKeys({}),
  })

  const add = useMutation({
    mutationFn: () => api.user.createSshKey({ title, publicKey, readOnly: false }),
    onSuccess: () => {
      setTitle('')
      setPublicKey('')
      void queryClient.invalidateQueries({ queryKey: ['sshKeys'] })
    },
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.user.deleteSshKey({ id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sshKeys'] }),
  })

  return (
    <section className="settings-section">
      <h2>SSH keys</h2>
      <div className="notice notice-warning">
        Git over SSH is not enabled on this deployment. It needs the Workers inbound-TCP beta and a
        Spectrum application, so keys added here are stored but unused. Clone over HTTPS instead.
      </div>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          if (publicKey.trim()) add.mutate()
        }}
      >
        <label htmlFor="key-title">Title</label>
        <input
          id="key-title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />

        <label htmlFor="key-body">Public key</label>
        <textarea
          id="key-body"
          rows={4}
          placeholder="ssh-ed25519 AAAA… you@example.com"
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
        />
        <p className="hint">Paste the contents of your .pub file, never the private key.</p>

        <div className="actions">
          <button type="submit" className="button button-primary" disabled={add.isPending}>
            Add key
          </button>
        </div>
      </form>

      {add.isError && <GateNotice message={errorMessage(add.error)} />}

      <ul className="issue-list">
        {keys.data?.keys.map((key) => (
          <li key={key.id} className="issue-row">
            <div>
              <span className="issue-title">{key.title}</span>
              <div className="muted issue-meta">
                <code>{key.fingerprint}</code>
              </div>
            </div>
            <button type="button" className="button" onClick={() => remove.mutate(key.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {keys.data?.keys.length === 0 && <p className="muted">No keys yet.</p>}
    </section>
  )
}
