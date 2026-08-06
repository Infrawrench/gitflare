import type { Timestamp } from '@bufbuild/protobuf/wkt'
import { timestampDate } from '@bufbuild/protobuf/wkt'

/**
 * Relative time, using Intl.RelativeTimeFormat so it localizes for free.
 *
 * Thresholds step up through the units rather than rounding to a single scale,
 * so "3 days ago" does not become "0 months ago".
 */
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
]

const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeTime(value: Timestamp | Date | number): string {
  const date = toDate(value)
  let duration = (date.getTime() - Date.now()) / 1000

  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return formatter.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return date.toLocaleDateString()
}

export function absoluteTime(value: Timestamp | Date | number): string {
  return toDate(value).toLocaleString()
}

function toDate(value: Timestamp | Date | number): Date {
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  return timestampDate(value)
}

/** Short SHA, matching git's default abbreviation length. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** First line of a commit message — the subject, in git's terms. */
export function commitSubject(message: string): string {
  return message.split('\n')[0] ?? ''
}

export function formatBytes(bytes: number | bigint): string {
  const value = Number(bytes)
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB']
  let scaled = value / 1024
  let unit = 0
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024
    unit++
  }
  return `${scaled.toFixed(1)} ${units[unit]}`
}
