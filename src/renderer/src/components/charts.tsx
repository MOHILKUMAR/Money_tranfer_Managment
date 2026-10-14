/**
 * Chart components (Recharts). Colors follow the validated categorical order;
 * values are always shown with the configured currency; every chart has an
 * empty state and a "view as table" alternative.
 */
import { useMemo, useState, type ReactNode } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { BarChart3, Table2 } from 'lucide-react'
import { formatIsoDate, formatMonthKey } from '@shared/dates'
import { useFormat } from '@/lib/queries'
import { Card, CardHeader, EmptyState } from './ui/layout'
import { Button } from './ui/button'
import { Table, THead, Th, Tr, Td } from './ui/table'

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
export const CREDIT_COLOR = '#2a78d6'
export const DUE_COLOR = '#e34948'
export const NEUTRAL_COLOR = '#b5b4ae'
const GRID = '#ececec'
const AXIS = '#8a8a8a'

export interface SeriesDef {
  key: string
  label: string
  color: string
}

function useAxisFormatter() {
  const { currency } = useFormat()
  return useMemo(() => {
    const nf = new Intl.NumberFormat(currency.locale, { style: 'currency', currency: currency.code, notation: 'compact', maximumFractionDigits: 1 })
    const scale = 10 ** currency.minorDigits
    // Axis ticks only (display), never used for stored values.
    return (minor: number) => nf.format(minor / scale)
  }, [currency])
}

function bucketLabel(bucket: string, dateFormat: string): string {
  if (/^\d{4}-\d{2}$/.test(bucket)) return formatMonthKey(bucket)
  return formatIsoDate(bucket, dateFormat)
}

export function ChartCard({
  title,
  description,
  isEmpty,
  emptyText = 'No data for the selected period.',
  table,
  children,
  height = 260,
  className
}: {
  title: string
  description?: ReactNode
  isEmpty: boolean
  emptyText?: string
  table: { columns: string[]; rows: Array<Array<ReactNode>> }
  children: ReactNode
  height?: number
  className?: string
}) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card className={`min-w-0 ${className ?? ""}`}>
      <CardHeader
        title={title}
        description={description}
        actions={
          !isEmpty && (
            <Button size="icon-sm" variant="ghost" aria-label={asTable ? `Show ${title} as chart` : `Show ${title} as table`} aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              {asTable ? <BarChart3 /> : <Table2 />}
            </Button>
          )
        }
      />
      <div className="p-3" style={{ minHeight: height }}>
        {isEmpty ? (
          <EmptyState icon={BarChart3} title="Nothing to chart yet" description={emptyText} />
        ) : asTable ? (
          <Table className="max-h-[260px]">
            <THead>
              <tr>
                {table.columns.map((c, i) => (
                  <Th key={c} align={i === 0 ? 'left' : 'right'}>
                    {c}
                  </Th>
                ))}
              </tr>
            </THead>
            <tbody>
              {table.rows.map((row, i) => (
                <Tr key={i}>
                  {row.map((cell, j) => (
                    <Td key={j} align={j === 0 ? 'left' : 'right'}>
                      {cell}
                    </Td>
                  ))}
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div style={{ height }} role="img" aria-label={title}>
            {children}
          </div>
        )}
      </div>
    </Card>
  )
}

function MoneyTooltip({ active, payload, label, labelFormatter }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; dataKey: string }>; label?: string; labelFormatter?: (l: string) => string }) {
  const { money } = useFormat()
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-silver-200 bg-white px-3 py-2 text-xs shadow-lg">
      {label !== undefined && <p className="mb-1 font-semibold text-ink">{labelFormatter ? labelFormatter(String(label)) : label}</p>}
      {payload.map((p) => (
        <p key={p.dataKey} className="flex items-center justify-between gap-4 text-ink">
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: p.color }} aria-hidden />
            {p.name}
          </span>
          <span className="tabular font-medium">{money(p.value)}</span>
        </p>
      ))}
    </div>
  )
}

/** Grouped bars over time (one axis, money). */
export function TimeBarChart({
  title,
  description,
  data,
  series,
  emptyText
}: {
  title: string
  description?: ReactNode
  data: Array<Record<string, number | string>>
  series: SeriesDef[]
  emptyText?: string
}) {
  const { money, dateFormat } = useFormat()
  const axis = useAxisFormatter()
  const isEmpty = data.every((d) => series.every((s) => !d[s.key]))
  return (
    <ChartCard
      title={title}
      description={description}
      isEmpty={isEmpty}
      emptyText={emptyText}
      table={{
        columns: ['Period', ...series.map((s) => s.label)],
        rows: data.filter((d) => series.some((s) => d[s.key])).map((d) => [bucketLabel(String(d.bucket), dateFormat), ...series.map((s) => money(d[s.key] as number))])
      }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }} barGap={2}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(String(b), data.length > 40 ? 'dd MMM' : 'dd MMM')} stroke={AXIS} tickLine={false} minTickGap={16} />
          <YAxis tickFormatter={axis} stroke={AXIS} tickLine={false} axisLine={false} width={64} />
          <Tooltip content={<MoneyTooltip labelFormatter={(l) => bucketLabel(l, dateFormat)} />} cursor={{ fill: 'rgba(42,42,42,0.05)' }} />
          <Legend iconType="square" iconSize={10} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={28} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/** Single-series trend (area line). */
export function TrendChart({ title, description, data, valueKey, label, color = SERIES[0], emptyText }: { title: string; description?: ReactNode; data: Array<Record<string, number | string>>; valueKey: string; label: string; color?: string; emptyText?: string }) {
  const { money, dateFormat } = useFormat()
  const axis = useAxisFormatter()
  const xKey = 'bucket' in (data[0] ?? {}) ? 'bucket' : 'month' in (data[0] ?? {}) ? 'month' : 'date'
  const isEmpty = data.every((d) => !d[valueKey])
  return (
    <ChartCard
      title={title}
      description={description}
      isEmpty={isEmpty}
      emptyText={emptyText}
      table={{ columns: ['Period', label], rows: data.filter((d) => d[valueKey]).map((d) => [bucketLabel(String(d[xKey]), dateFormat), money(d[valueKey] as number)]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id={`fill-${valueKey}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey={xKey} tickFormatter={(b) => bucketLabel(String(b), 'dd MMM')} stroke={AXIS} tickLine={false} minTickGap={16} />
          <YAxis tickFormatter={axis} stroke={AXIS} tickLine={false} axisLine={false} width={64} />
          <Tooltip content={<MoneyTooltip labelFormatter={(l) => bucketLabel(l, dateFormat)} />} />
          <Area type="linear" dataKey={valueKey} name={label} stroke={color} strokeWidth={2} fill={`url(#fill-${valueKey})`} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} />
        </AreaChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/** Ranked horizontal bars (top customers, categories). */
export function RankedBarChart({ title, description, items, color = SERIES[0], emptyText }: { title: string; description?: ReactNode; items: Array<{ name: string; amountMinor: number }>; color?: string; emptyText?: string }) {
  const { money } = useFormat()
  const axis = useAxisFormatter()
  const data = items.slice(0, 10)
  return (
    <ChartCard title={title} description={description} isEmpty={data.length === 0} emptyText={emptyText} table={{ columns: ['Name', 'Amount'], rows: data.map((d) => [d.name, money(d.amountMinor)]) }} height={Math.max(160, data.length * 34 + 30)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" tickFormatter={axis} stroke={AXIS} tickLine={false} />
          <YAxis type="category" dataKey="name" width={150} stroke={AXIS} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
          <Tooltip content={<MoneyTooltip />} cursor={{ fill: 'rgba(42,42,42,0.05)' }} />
          <Bar dataKey="amountMinor" name="Amount" fill={color} radius={[0, 4, 4, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}

/** Share-of-whole donut with a value legend (used for ≤ 8 categories; extra slices fold into "Other"). */
export function DonutChart({ title, description, items, valueKind = 'money', emptyText }: { title: string; description?: ReactNode; items: Array<{ name: string; value: number }>; valueKind?: 'money' | 'count'; emptyText?: string }) {
  const { money } = useFormat()
  const positive = items.filter((i) => i.value > 0).sort((a, b) => b.value - a.value)
  const data = positive.length > 8 ? [...positive.slice(0, 7), { name: 'Other', value: positive.slice(7).reduce((s, i) => s + i.value, 0) }] : positive
  const total = data.reduce((s, i) => s + i.value, 0)
  const fmt = (v: number) => (valueKind === 'money' ? money(v) : v.toLocaleString())
  return (
    <ChartCard title={title} description={description} isEmpty={data.length === 0} emptyText={emptyText} table={{ columns: ['Category', valueKind === 'money' ? 'Amount' : 'Count', 'Share'], rows: data.map((d) => [d.name, fmt(d.value), `${((d.value / total) * 100).toFixed(1)}%`]) }}>
      <div className="flex h-full items-center gap-4">
        <div className="h-full w-1/2 min-w-40">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={1} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
                {data.map((d, i) => (
                  <Cell key={d.name} fill={SERIES[i % SERIES.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v) => fmt(Number(v))} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
          {data.map((d, i) => (
            <li key={d.name} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: SERIES[i % SERIES.length] }} aria-hidden />
                <span className="truncate text-ink">{d.name}</span>
              </span>
              <span className="tabular whitespace-nowrap text-ink-muted">
                {fmt(d.value)} · {((d.value / total) * 100).toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartCard>
  )
}

/** Customer balance distribution: diverging (due ← settled → credit). */
export function BalanceDistributionChart({ items, title = 'Customer balance distribution' }: { items: Array<{ bucket: string; count: number; amountMinor: number; order: number }>; title?: string }) {
  const { money } = useFormat()
  const color = (order: number) => (order < 3 ? DUE_COLOR : order === 3 ? NEUTRAL_COLOR : CREDIT_COLOR)
  const opacity = (order: number) => [1, 0.75, 0.5, 1, 0.5, 0.75, 1][order]
  const isEmpty = items.every((i) => i.count === 0)
  return (
    <ChartCard
      title={title}
      description="Number of customers by current balance (red = amount due, blue = credit)"
      isEmpty={isEmpty}
      emptyText="Register customers to see how balances are distributed."
      table={{ columns: ['Balance range', 'Customers', 'Total balance'], rows: items.map((i) => [i.bucket, i.count.toLocaleString(), money(i.amountMinor)]) }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={items} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="bucket" stroke={AXIS} tickLine={false} interval={0} tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={56} />
          <YAxis allowDecimals={false} stroke={AXIS} tickLine={false} axisLine={false} width={32} />
          <Tooltip
            formatter={(v, _n, p) => [`${Number(v)} customer(s) · ${money((p.payload as { amountMinor: number }).amountMinor)}`, 'Customers']}
            cursor={{ fill: 'rgba(42,42,42,0.05)' }}
          />
          <Bar dataKey="count" name="Customers" radius={[4, 4, 0, 0]} maxBarSize={48}>
            {items.map((i) => (
              <Cell key={i.bucket} fill={color(i.order)} fillOpacity={opacity(i.order)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
