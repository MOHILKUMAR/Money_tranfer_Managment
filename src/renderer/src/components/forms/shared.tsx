import { useState } from 'react'
import { z } from 'zod'
import { parseMoney } from '@shared/money'
import { isValidIsoDate } from '@shared/dates'
import { newRequestKey } from '@/lib/api'

export function moneyString(minorDigits: number, opts: { required?: boolean; allowZero?: boolean; allowNegative?: boolean } = {}) {
  return z.string().superRefine((value, ctx) => {
    if (!value.trim()) {
      if (opts.required !== false) ctx.addIssue({ code: 'custom', message: 'Enter an amount' })
      return
    }
    const parsed = parseMoney(value, { minorDigits, allowZero: opts.allowZero, allowNegative: opts.allowNegative })
    if (!parsed.ok) ctx.addIssue({ code: 'custom', message: parsed.error })
  })
}

export const dateString = z.string().refine(isValidIsoDate, 'Enter a valid date')

export function toMinor(value: string, minorDigits: number, opts: { allowZero?: boolean; allowNegative?: boolean } = {}): number {
  if (!value.trim()) return 0
  const parsed = parseMoney(value, { minorDigits, ...opts })
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

/** One idempotency key per logical submission; regenerated after a successful save. */
export function useRequestKey(): [string, () => void] {
  const [key, setKey] = useState(newRequestKey)
  return [key, () => setKey(newRequestKey())]
}

export function optionalId(value: string): number | null {
  return value ? Number(value) : null
}

export function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  )
}
