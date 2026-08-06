import { useState } from 'react'

/**
 * Clone URL picker.
 *
 * HTTPS is the default and SSH is labelled as unavailable, because it is: the
 * inbound-TCP handler behind git-over-SSH is in private beta and needs Spectrum.
 * Offering a URL that cannot connect would send people debugging their own keys.
 */
export function CloneBox({ cloneUrl, sshUrl }: { cloneUrl: string; sshUrl: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(cloneUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="clone-box">
      <input readOnly value={cloneUrl} aria-label="Clone URL" onFocus={(e) => e.target.select()} />
      <button type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <details className="clone-help">
        <summary>SSH</summary>
        <p>
          <code>{sshUrl}</code>
        </p>
        <p className="muted">
          SSH is not enabled on this deployment — it needs the Workers inbound-TCP beta and a
          Spectrum application. Use the HTTPS URL with a personal access token as the password.
        </p>
      </details>
    </div>
  )
}
