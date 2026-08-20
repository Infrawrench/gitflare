/**
 * Parsing a git signature timestamp from Artifacts.
 *
 * The binding's object readers are undeclared in the shipped types, so the exact
 * shape of a signature's `time` is not contractual. It was assumed to be an ISO
 * string; against the real service it is not, and `new Date(...)` produced an
 * Invalid Date whose epoch is NaN. That surfaced as
 * `RangeError: NaN cannot be converted to a BigInt` deep inside protobuf
 * serialization, nowhere near the cause.
 *
 * So every accepted form is handled explicitly, and anything unrecognized falls
 * back to the epoch rather than throwing — a commit with an odd timestamp should
 * still be listable.
 */
export function parseGitTime(value: unknown): Date {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date(0) : value

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Git records seconds; anything past ~2001 in milliseconds is far beyond a
    // plausible seconds value, so the magnitude disambiguates the two.
    return new Date(value > 1e11 ? value : value * 1000)
  }

  if (typeof value === 'string') {
    // Git's raw signature format is "<seconds> <±hhmm>", e.g. "1787184000 +0000".
    // Number() rejects that whole string and Date() cannot parse it either, so
    // the leading integer is taken directly.
    const raw = /^\s*(\d{9,})\b/.exec(value)
    if (raw) return new Date(Number(raw[1]) * 1000)

    const asNumber = Number(value)
    if (value.trim() !== '' && Number.isFinite(asNumber)) {
      return new Date(asNumber > 1e11 ? asNumber : asNumber * 1000)
    }
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  // A whole signature object may be passed in. The field carrying the timestamp
  // is not contractual — `time` is absent against the real service — so the
  // plausible names are probed rather than assumed.
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    for (const key of ['time', 'date', 'when', 'timestamp', 'at', 'seconds', 'epoch']) {
      const candidate = record[key]
      if (candidate === undefined || candidate === null || candidate === value) continue
      const parsed = parseGitTime(candidate)
      if (parsed.getTime() !== 0) return parsed
    }
  }

  // Epoch means "unknown". Artifacts does not return commit timestamps at all,
  // so this is the normal path, not an error — callers omit the field rather
  // than rendering 1970. See UNKNOWN_TIME below.
  return new Date(0)
}

/** True when parseGitTime could not find a timestamp. */
export function isUnknownTime(date: Date): boolean {
  return date.getTime() === 0
}
