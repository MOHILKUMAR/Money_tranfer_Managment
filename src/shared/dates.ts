import {
  addDays,
  endOfMonth,
  format,
  isValid,
  parse,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths
} from 'date-fns'

/** Business dates are stored as local calendar dates in ISO form (YYYY-MM-DD). */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false
  const parsed = parse(value, 'yyyy-MM-dd', new Date(2000, 0, 1))
  return isValid(parsed) && format(parsed, 'yyyy-MM-dd') === value
}

export function toIsoDate(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

export function fromIsoDate(value: string): Date {
  return parse(value, 'yyyy-MM-dd', new Date(2000, 0, 1))
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(now)
}

export const DATE_RANGE_PRESETS = [
  'today',
  'yesterday',
  'last7',
  'last30',
  'thisMonth',
  'previousMonth',
  'custom'
] as const
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number]

export const DATE_RANGE_PRESET_LABELS: Record<DateRangePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last7: 'Last 7 days',
  last30: 'Last 30 days',
  thisMonth: 'This month',
  previousMonth: 'Previous month',
  custom: 'Custom range'
}

export interface DateRange {
  from: string
  to: string
}

/** Inclusive date range for a preset, relative to `today` (YYYY-MM-DD). */
export function rangeForPreset(preset: Exclude<DateRangePreset, 'custom'>, today: string): DateRange {
  const base = fromIsoDate(today)
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = toIsoDate(subDays(base, 1))
      return { from: y, to: y }
    }
    case 'last7':
      return { from: toIsoDate(subDays(base, 6)), to: today }
    case 'last30':
      return { from: toIsoDate(subDays(base, 29)), to: today }
    case 'thisMonth':
      return { from: toIsoDate(startOfMonth(base)), to: today }
    case 'previousMonth': {
      const prev = subMonths(base, 1)
      return { from: toIsoDate(startOfMonth(prev)), to: toIsoDate(endOfMonth(prev)) }
    }
  }
}

export function weekStartIso(today: string): string {
  return toIsoDate(startOfWeek(fromIsoDate(today), { weekStartsOn: 1 }))
}

export function monthStartIso(today: string): string {
  return toIsoDate(startOfMonth(fromIsoDate(today)))
}

/** Every date from `from` to `to` inclusive. */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = fromIsoDate(from)
  const end = fromIsoDate(to)
  while (cursor <= end && out.length < 4000) {
    out.push(toIsoDate(cursor))
    cursor = addDays(cursor, 1)
  }
  return out
}

/** Month keys (YYYY-MM) from the month of `from` to the month of `to`. */
export function eachMonth(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = startOfMonth(fromIsoDate(from))
  const end = startOfMonth(fromIsoDate(to))
  while (cursor <= end && out.length < 600) {
    out.push(format(cursor, 'yyyy-MM'))
    cursor = startOfMonth(addDays(endOfMonth(cursor), 1))
  }
  return out
}

/** The 12 month keys ending with the month containing `date`. */
export function trailingMonths(date: string, count = 12): string[] {
  const end = startOfMonth(fromIsoDate(date))
  const start = subMonths(end, count - 1)
  return eachMonth(toIsoDate(start), toIsoDate(end))
}

export function daysBetweenInclusive(from: string, to: string): number {
  const ms = fromIsoDate(to).getTime() - fromIsoDate(from).getTime()
  return Math.round(ms / 86_400_000) + 1
}

export const DATE_FORMAT_OPTIONS = ['dd MMM yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd'] as const
export type DateFormatOption = (typeof DATE_FORMAT_OPTIONS)[number]

export function formatIsoDate(value: string | null | undefined, pattern: string = 'dd MMM yyyy'): string {
  if (!value) return ''
  if (!isValidIsoDate(value)) return value
  return format(fromIsoDate(value), pattern)
}

export function formatMonthKey(monthKey: string): string {
  return format(parse(`${monthKey}-01`, 'yyyy-MM-dd', new Date(2000, 0, 1)), 'MMM yyyy')
}

/** Parses common user/CSV date formats into ISO. Returns null if ambiguous/invalid. */
export function parseFlexibleDate(input: string, preferredFormat: string = 'dd/MM/yyyy'): string | null {
  const value = String(input ?? '').trim()
  if (!value) return null
  if (isValidIsoDate(value)) return value
  const candidates = [preferredFormat, 'dd/MM/yyyy', 'dd-MM-yyyy', 'dd MMM yyyy', 'd MMM yyyy', 'yyyy/MM/dd']
  for (const pattern of candidates) {
    const parsed = parse(value, pattern, new Date(2000, 0, 1))
    if (isValid(parsed) && parsed.getFullYear() >= 1900 && parsed.getFullYear() <= 2200) {
      return toIsoDate(parsed)
    }
  }
  return null
}
