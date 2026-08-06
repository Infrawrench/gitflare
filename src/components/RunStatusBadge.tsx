import { RunStatus } from '~/gen/forge/v1/ci_pb'

/**
 * Status pill for a run or step.
 *
 * The glyph carries the meaning as well as the colour — red and green alone are
 * unreadable for the most common form of colour blindness, and a CI status is
 * exactly the thing people scan at a glance.
 */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  const { label, glyph, className } = describe(status)
  return (
    <span className={`run-badge ${className}`} title={label}>
      <span aria-hidden="true">{glyph}</span> {label}
    </span>
  )
}

function describe(status: RunStatus): { label: string; glyph: string; className: string } {
  switch (status) {
    case RunStatus.SUCCESS:
      return { label: 'Passed', glyph: '✓', className: 'run-success' }
    case RunStatus.FAILURE:
      return { label: 'Failed', glyph: '✕', className: 'run-failure' }
    case RunStatus.RUNNING:
      return { label: 'Running', glyph: '●', className: 'run-running' }
    case RunStatus.QUEUED:
      return { label: 'Queued', glyph: '○', className: 'run-queued' }
    case RunStatus.CANCELLED:
      return { label: 'Cancelled', glyph: '⊘', className: 'run-cancelled' }
    case RunStatus.CACHED:
      return { label: 'Cached', glyph: '⇄', className: 'run-success' }
    default:
      return { label: 'Unknown', glyph: '?', className: 'run-queued' }
  }
}
