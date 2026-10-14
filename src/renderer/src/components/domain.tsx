import { forwardRef, useEffect, useId, useMemo, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { Check, ChevronsUpDown, Search, type LucideIcon } from 'lucide-react'
import { classifyBalance, TRANSACTION_TYPE_LABELS, type TransactionType } from '@shared/finance'
import { DATE_RANGE_PRESET_LABELS, DATE_RANGE_PRESETS, rangeForPreset, type DateRangePreset } from '@shared/dates'
import type { CustomerSearchHit } from '@shared/types'
import { cn } from '@/lib/utils'
import { useApi, useFormat, useToday } from '@/lib/queries'
import { Badge } from './ui/layout'
import { InfoTip, Popover, PopoverAnchor, PopoverContent } from './ui/overlay'
import { Input, Select } from './ui/form'

export function MoneyText({ minor, tone = 'auto', className }: { minor: number | null | undefined; tone?: 'auto' | 'plain' | 'balance'; className?: string }) {
  const { money } = useFormat()
  if (minor === null || minor === undefined) return <span className={cn('text-ink-faint', className)}>—</span>
  const color =
    tone === 'balance' ? (minor > 0 ? 'text-credit' : minor < 0 ? 'text-due' : 'text-ink-muted') : tone === 'auto' && minor < 0 ? 'text-due' : ''
  return <span className={cn('tabular whitespace-nowrap', color, className)}>{money(minor)}</span>
}

export function BalanceBadge({ minor }: { minor: number }) {
  const status = classifyBalance(minor)
  if (status === 'CREDIT') return <Badge tone="credit">Credit</Badge>
  if (status === 'DUE') return <Badge tone="due">Amount due</Badge>
  return <Badge tone="neutral">Settled</Badge>
}

const TYPE_TONES: Record<TransactionType, 'credit' | 'due' | 'neutral' | 'dark' | 'warning' | 'red'> = {
  OPENING_BALANCE: 'neutral',
  RECEIPT: 'credit',
  PAYOUT: 'red',
  USAGE: 'dark',
  CREDIT_ADJUSTMENT: 'warning',
  DEBIT_ADJUSTMENT: 'warning'
}

export function TxnTypeBadge({ type, reversal }: { type: TransactionType; reversal?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={TYPE_TONES[type]}>{TRANSACTION_TYPE_LABELS[type]}</Badge>
      {reversal && <Badge tone="neutral">Reversal</Badge>}
    </span>
  )
}

export const MoneyInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => {
  const { currency } = useFormat()
  const symbol = useMemo(() => {
    try {
      return new Intl.NumberFormat(currency.locale, { style: 'currency', currency: currency.code }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency.code
    } catch {
      return currency.code
    }
  }, [currency])
  return (
    <div className="relative">
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-ink-muted">{symbol}</span>
      <Input ref={ref} inputMode="decimal" autoComplete="off" className={cn('pl-8 text-right tabular', className)} placeholder="0.00" {...props} />
    </div>
  )
})
MoneyInput.displayName = 'MoneyInput'

export function StatCard({
  label,
  value,
  help,
  icon: Icon,
  tone = 'default',
  sub
}: {
  label: string
  value: ReactNode
  help?: ReactNode
  icon?: LucideIcon
  tone?: 'default' | 'accent' | 'dark'
  sub?: ReactNode
}) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border p-4 shadow-xs',
        tone === 'dark' ? 'border-charcoal bg-charcoal text-white' : 'border-silver-200 bg-white',
        tone === 'accent' && 'border-l-4 border-l-racing'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={cn('flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide', tone === 'dark' ? 'text-silver' : 'text-ink-muted')}>
          {label}
          {help && <InfoTip content={help} label={`About ${label}`} />}
        </div>
        {Icon && <Icon className={cn('size-4', tone === 'dark' ? 'text-silver' : 'text-ink-faint')} aria-hidden />}
      </div>
      <div className="mt-2 text-xl font-semibold tabular tracking-tight">{value}</div>
      {sub && <div className={cn('mt-1 text-xs', tone === 'dark' ? 'text-silver' : 'text-ink-muted')}>{sub}</div>}
    </div>
  )
}

export interface DateRangeValue {
  preset: DateRangePreset
  from: string
  to: string
}

export function useDateRange(initial: Exclude<DateRangePreset, 'custom'> = 'thisMonth'): [DateRangeValue, (v: DateRangeValue) => void] {
  const today = useToday()
  const [value, setValue] = useState<DateRangeValue>(() => ({ preset: initial, ...rangeForPreset(initial, today) }))
  useEffect(() => {
    if (value.preset !== 'custom') {
      const next = rangeForPreset(value.preset, today)
      if (next.from !== value.from || next.to !== value.to) setValue({ preset: value.preset, ...next })
    }
  }, [today, value])
  return [value, setValue]
}

export function DateRangeControl({ value, onChange, label = 'Period' }: { value: DateRangeValue; onChange: (v: DateRangeValue) => void; label?: string }) {
  const today = useToday()
  const id = useId()
  const invalid = value.from > value.to
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label htmlFor={`${id}-preset`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {label}
        </label>
        <Select
          id={`${id}-preset`}
          className="w-40"
          value={value.preset}
          onChange={(e) => {
            const preset = e.target.value as DateRangePreset
            onChange(preset === 'custom' ? { ...value, preset } : { preset, ...rangeForPreset(preset, today) })
          }}
        >
          {DATE_RANGE_PRESETS.map((p) => (
            <option key={p} value={p}>
              {DATE_RANGE_PRESET_LABELS[p]}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <label htmlFor={`${id}-from`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted">
          From
        </label>
        <Input id={`${id}-from`} type="date" className="w-40" value={value.from} max={value.to} aria-invalid={invalid} onChange={(e) => e.target.value && onChange({ preset: 'custom', from: e.target.value, to: value.to })} />
      </div>
      <div>
        <label htmlFor={`${id}-to`} className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted">
          To
        </label>
        <Input id={`${id}-to`} type="date" className="w-40" value={value.to} min={value.from} aria-invalid={invalid} onChange={(e) => e.target.value && onChange({ preset: 'custom', from: value.from, to: e.target.value })} />
      </div>
    </div>
  )
}

/** Searchable customer selector (keyboard: type, ↑/↓, Enter). */
export function CustomerPicker({
  value,
  onChange,
  id,
  invalid,
  includeInactive = true,
  placeholder = 'Search name, code or phone…'
}: {
  value: number | null
  onChange: (id: number | null, hit?: CustomerSearchHit) => void
  id?: string
  invalid?: boolean
  includeInactive?: boolean
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const { data: hits = [] } = useApi('customers:search', { query, limit: 12 }, { enabled: open })
  const { data: selected } = useApi('customers:get', { id: value ?? 0 }, { enabled: !!value })
  const filtered = includeInactive ? hits : hits.filter((h) => h.status === 'ACTIVE')
  const choose = (hit: CustomerSearchHit) => {
    onChange(hit.id, hit)
    setOpen(false)
    setQuery('')
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          {open ? (
            <>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
              <Input
                id={id}
                autoFocus
                role="combobox"
                aria-expanded
                aria-controls={`${id}-list`}
                aria-autocomplete="list"
                className="pl-9"
                placeholder={placeholder}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActive(0)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setActive((a) => Math.min(a + 1, filtered.length - 1))
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setActive((a) => Math.max(a - 1, 0))
                  } else if (e.key === 'Enter' && filtered[active]) {
                    e.preventDefault()
                    choose(filtered[active])
                  } else if (e.key === 'Escape') {
                    setOpen(false)
                  }
                }}
              />
            </>
          ) : (
            <button
              id={id}
              type="button"
              role="combobox"
              aria-expanded={false}
              aria-invalid={invalid}
              onClick={() => setOpen(true)}
              className={cn(
                'flex h-9 w-full cursor-pointer items-center justify-between rounded-md border border-silver bg-white px-3 text-left text-sm shadow-xs hover:border-charcoal-600 focus:outline-none focus:ring-2 focus:ring-charcoal/15',
                invalid && 'border-due'
              )}
            >
              {value && selected ? (
                <span className="truncate">
                  <span className="font-medium">{selected.name}</span>
                  <span className="ml-2 text-xs text-ink-muted">{selected.customerCode}</span>
                </span>
              ) : (
                <span className="text-ink-faint">Select a customer…</span>
              )}
              <ChevronsUpDown className="size-4 text-ink-faint" aria-hidden />
            </button>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-80">
        <ul id={`${id}-list`} role="listbox" className="scrollbar-thin max-h-72 overflow-auto">
          {filtered.length === 0 && <li className="px-3 py-4 text-center text-sm text-ink-muted">No customers found</li>}
          {filtered.map((hit, index) => (
            <li
              key={hit.id}
              role="option"
              aria-selected={hit.id === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(hit)}
              onMouseEnter={() => setActive(index)}
              className={cn('flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-2 text-sm', index === active && 'bg-silver-100')}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-medium">
                  {hit.id === value && <Check className="size-3.5 text-racing" aria-hidden />}
                  <span className="truncate">{hit.name}</span>
                  {hit.status === 'INACTIVE' && <Badge>Inactive</Badge>}
                </span>
                <span className="text-xs text-ink-muted">
                  {hit.customerCode}
                  {hit.phone ? ` · ${hit.phone}` : ''}
                </span>
              </span>
              <MoneyText minor={hit.balanceMinor} tone="balance" className="text-xs" />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
