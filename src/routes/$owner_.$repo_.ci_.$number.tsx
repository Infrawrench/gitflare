import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { RunStatus } from '~/gen/forge/v1/ci_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { RunStatusBadge } from '~/components/RunStatusBadge'
import { relativeTime, shortSha } from '~/lib/format'

export const Route = createFileRoute('/$owner_/$repo_/ci_/$number')({
  component: RunPage,
})

function RunPage() {
  const { owner, repo, number } = Route.useParams()
  const runNumber = Number(number)

  const run = useQuery({
    queryKey: ['run', owner, repo, runNumber],
    queryFn: () => api.ci.getRun({ owner, repo, number: runNumber }),
    refetchInterval: (query) => (isActive(query.state.data?.run?.status) ? 3_000 : false),
  })

  if (run.isError) return <GateNotice message={errorMessage(run.error)} />
  if (!run.data?.run) return <p className="muted">Loading…</p>

  const model = run.data.run

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="ci" />

      <div className="page-head">
        <h2 className="issue-heading">
          Run #{model.number} <span className="muted">{shortSha(model.sha)}</span>
        </h2>
      </div>

      <div className="issue-status">
        <RunStatusBadge status={model.status} />
        <span className="muted">
          {model.branch ?? model.ref}
          {model.createdAt && ` · started ${relativeTime(model.createdAt)}`}
          {model.actor && ` · ${model.actor.login}`}
        </span>
      </div>

      {model.error && (
        <div className="notice notice-error">
          <p>{model.error}</p>
        </div>
      )}

      <ol className="step-list">
        {model.steps.map((step) => (
          <li key={step.id} className="step-row">
            <RunStatusBadge status={step.status} />
            <code>{step.name}</code>
            {step.cacheHit && <span className="badge">cached</span>}
            {step.exitCode !== 0 && !step.cacheHit && (
              <span className="muted">exit {step.exitCode}</span>
            )}
            {step.startedAt && step.finishedAt && (
              <span className="muted">
                {Math.round(
                  (Number(step.finishedAt.seconds) - Number(step.startedAt.seconds)) * 10,
                ) / 10}
                s
              </span>
            )}
          </li>
        ))}
      </ol>

      <LogView owner={owner} repo={repo} number={runNumber} live={isActive(model.status)} />
    </>
  )
}

/**
 * Live log tail over the server-streaming RPC.
 *
 * The stream is opened once per run and torn down through an AbortController
 * when the component unmounts — a Connect stream held open by a page the user
 * has navigated away from keeps a connection and a server-side poll alive.
 */
function LogView({
  owner,
  repo,
  number,
  live,
}: {
  owner: string
  repo: string
  number: number
  live: boolean
}) {
  const [lines, setLines] = useState<{ step: string; text: string; isStderr: boolean }[]>([])
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const controller = new AbortController()

    const consume = async () => {
      try {
        for await (const response of api.ci.streamRunLogs(
          { owner, repo, number, afterSequence: 0n },
          { signal: controller.signal },
        )) {
          if (response.chunk) {
            const chunk = response.chunk
            setLines((current) => [
              ...current,
              { step: chunk.stepName, text: chunk.text, isStderr: chunk.isStderr },
            ])
          }
          if (response.finalStatus !== undefined) setDone(true)
        }
      } catch (caught) {
        // An abort is the expected way this ends when the user navigates away.
        if (!controller.signal.aborted) setError(errorMessage(caught))
      }
    }

    void consume()
    return () => controller.abort()
  }, [owner, repo, number])

  // Follow the tail, but stop fighting the user the moment they scroll up.
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  return (
    <section className="logs">
      <header className="logs-head muted">
        <span>Output</span>
        {live && !done && <span className="logs-live">● live</span>}
      </header>

      <div
        className="logs-body"
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40
        }}
      >
        {lines.length === 0 && !error && (
          <p className="muted logs-empty">{live ? 'Waiting for output…' : 'No output.'}</p>
        )}
        {lines.map((line, index) => (
          <div key={index} className={line.isStderr ? 'log-line log-stderr' : 'log-line'}>
            {line.text}
          </div>
        ))}
        <div ref={bottom} />
      </div>

      {error && <GateNotice message={error} />}
    </section>
  )
}

function isActive(status: RunStatus | undefined): boolean {
  return status === RunStatus.QUEUED || status === RunStatus.RUNNING
}
