import { useState } from 'react'

/**
 * Quick-setup splash for a repository with no commits.
 *
 * An empty repo has no refs at all, so the code browser's `getTree` call fails
 * with `Ref "main" not found`. That is the normal state of a freshly created
 * repo rather than a fault, and showing it as an error banner told people
 * something had broken when nothing had. `CreateRepo` never writes an initial
 * commit — `RepoService.CreateRepo.auto_init` is accepted but unimplemented —
 * so every new repo lands here first.
 */
export function EmptyRepo({
  cloneUrl,
  defaultBranch,
  repo,
}: {
  cloneUrl: string
  defaultBranch: string
  repo: string
}) {
  const branch = defaultBranch || 'main'

  return (
    <div className="empty-repo">
      <h2>Quick setup</h2>
      <p className="muted">
        This repository is empty. Push a commit from the command line to get started — over HTTPS,
        using a personal access token as the password.
      </p>

      <h3>Create a new repository on the command line</h3>
      <Commands
        lines={[
          `echo "# ${repo}" >> README.md`,
          'git init',
          'git add README.md',
          'git commit -m "first commit"',
          `git branch -M ${branch}`,
          `git remote add origin ${cloneUrl}`,
          `git push -u origin ${branch}`,
        ]}
      />

      <h3>…or push an existing repository</h3>
      <Commands
        lines={[
          `git remote add origin ${cloneUrl}`,
          `git branch -M ${branch}`,
          `git push -u origin ${branch}`,
        ]}
      />
    </div>
  )
}

function Commands({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false)
  const text = lines.join('\n')

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="commands">
      <pre>{text}</pre>
      <button type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
