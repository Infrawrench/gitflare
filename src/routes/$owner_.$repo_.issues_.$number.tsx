import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/connect'
import { IssueState } from '~/gen/forge/v1/issue_pb'
import { GateNotice } from '~/components/GateNotice'
import { RepoNav } from '~/components/RepoNav'
import { LabelChip } from '~/components/LabelChip'
import { absoluteTime, relativeTime } from '~/lib/format'

export const Route = createFileRoute('/$owner_/$repo_/issues_/$number')({
  component: IssuePage,
})

function IssuePage() {
  const { owner, repo, number } = Route.useParams()
  const issueNumber = Number(number)
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')

  const issue = useQuery({
    queryKey: ['issue', owner, repo, issueNumber],
    queryFn: () => api.issue.getIssue({ owner, repo, number: issueNumber }),
  })

  const comments = useQuery({
    queryKey: ['comments', owner, repo, issueNumber],
    queryFn: () => api.issue.listComments({ owner, repo, number: issueNumber, page: { limit: 100 } }),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['issue', owner, repo, issueNumber] })
    void queryClient.invalidateQueries({ queryKey: ['comments', owner, repo, issueNumber] })
  }

  const comment = useMutation({
    mutationFn: (body: string) =>
      api.issue.createComment({ owner, repo, number: issueNumber, body }),
    onSuccess: () => {
      setDraft('')
      invalidate()
    },
  })

  const setState = useMutation({
    mutationFn: (state: IssueState) =>
      api.issue.updateIssue({ owner, repo, number: issueNumber, state }),
    onSuccess: invalidate,
  })

  if (issue.isError) return <GateNotice message={errorMessage(issue.error)} />
  if (!issue.data?.issue) return <p className="muted">Loading…</p>

  const model = issue.data.issue
  const isOpen = model.state === IssueState.OPEN

  return (
    <>
      <RepoNav owner={owner} repo={repo} active="issues" />

      <div className="page-head">
        <h2 className="issue-heading">
          {model.title} <span className="muted">#{model.number}</span>
        </h2>
      </div>

      <div className="issue-status">
        <span className={isOpen ? 'state-badge state-open' : 'state-badge state-closed'}>
          {isOpen ? 'Open' : 'Closed'}
        </span>
        <span className="muted">
          {model.author?.login} opened this {model.createdAt && relativeTime(model.createdAt)} ·{' '}
          {model.commentCount} comment{model.commentCount === 1 ? '' : 's'}
        </span>
        {model.labels.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
      </div>

      {model.assignees.length > 0 && (
        <p className="muted">Assigned to {model.assignees.map((user) => user.login).join(', ')}</p>
      )}

      <article className="comment">
        <header className="comment-head muted">
          <strong>{model.author?.login}</strong>
          {model.createdAt && <time title={absoluteTime(model.createdAt)}>{relativeTime(model.createdAt)}</time>}
        </header>
        {/* Bodies are rendered as plain text. The server deliberately does not
            send HTML for user content, so there is nothing here to sanitize. */}
        <div className="comment-body">{model.body || <em className="muted">No description.</em>}</div>
      </article>

      {comments.data?.comments.map((item) => (
        <article key={item.id} className="comment">
          <header className="comment-head muted">
            <strong>{item.author?.login}</strong>
            {item.createdAt && <time title={absoluteTime(item.createdAt)}>{relativeTime(item.createdAt)}</time>}
            {item.edited && <span>· edited</span>}
          </header>
          <div className="comment-body">{item.body}</div>
        </article>
      ))}

      <form
        className="form comment-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (draft.trim()) comment.mutate(draft)
        }}
      >
        <label htmlFor="comment-body">Leave a comment</label>
        <textarea
          id="comment-body"
          rows={5}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={setState.isPending}
            onClick={() => setState.mutate(isOpen ? IssueState.CLOSED : IssueState.OPEN)}
          >
            {isOpen ? 'Close issue' : 'Reopen issue'}
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={comment.isPending || draft.trim() === ''}
          >
            Comment
          </button>
        </div>
      </form>

      {comment.isError && <GateNotice message={errorMessage(comment.error)} />}
      {setState.isError && <GateNotice message={errorMessage(setState.error)} />}
    </>
  )
}
