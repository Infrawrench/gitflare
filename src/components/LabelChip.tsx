import type { Label } from '~/gen/forge/v1/issue_pb'

/**
 * A label pill.
 *
 * Text colour is chosen from the background's luminance rather than being fixed:
 * a user can pick any hex, and black-on-navy or white-on-yellow is unreadable.
 */
export function LabelChip({ label }: { label: Label }) {
  const background = `#${label.color}`
  return (
    <span
      className="label-chip"
      style={{ background, color: readableTextColor(label.color) }}
      title={label.description || undefined}
    >
      {label.name}
    </span>
  )
}

/**
 * Relative luminance per WCAG, then black or white for the better contrast.
 * The 0.179 threshold is where the two contrast ratios cross.
 */
function readableTextColor(hex: string): string {
  const value = Number.parseInt(hex, 16)
  if (!Number.isFinite(value) || hex.length !== 6) return '#000'

  const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
  return luminance > 0.179 ? '#000' : '#fff'
}
