/**
 * Error banner that recognizes the Cloudflare Artifacts closed-beta gate.
 *
 * That failure is expected right now and affects every git-backed view, so it
 * gets an explanation of what to do rather than being rendered as a generic
 * error the reader would reasonably assume is a bug in this app.
 */
export function GateNotice({ message }: { message: string }) {
  const isGate = /Artifacts is not enabled|closed beta/i.test(message)

  if (!isGate) {
    return (
      <div className="notice notice-error">
        <p>{message}</p>
      </div>
    )
  }

  return (
    <div className="notice notice-warning">
      <h2>Git storage is not available</h2>
      <p>{message}</p>
      <p className="muted">
        Everything that does not touch git — accounts, repository metadata, issues — still works.
        Cloning, browsing code, and CI need Artifacts.
      </p>
    </div>
  )
}
