import { useEffect, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, BookOpen, Download, Printer, Receipt, Timer } from 'lucide-react'
import { toast } from 'sonner'
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type TransactionType } from '@shared/finance'
import type { ReportKind } from '@shared/schemas'
import type { ExpenseRow, UsageEntry } from '@shared/types'
import { call, errorMessage } from '@/lib/api'
import { useApi, useFormat, useLookups } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, ErrorState, PageHeader, Spinner, Badge } from '@/components/ui/layout'
import { Input, Select } from '@/components/ui/form'
import { Pagination, Table, THead, Th, Tr, Td } from '@/components/ui/table'
import { DateRangeControl, MoneyText, StatCard, useDateRange, CustomerPicker } from '@/components/domain'
import { ExpenseDetailDialog, LedgerTable, TransactionDetailDialog, UsageCorrectionDialog } from '@/components/txn-dialogs'
import { ReceiptForm, PayoutForm } from '@/components/forms/money-forms'
import { UsageBatchForm } from '@/components/forms/usage-form'
import { ExpenseForm } from '@/components/forms/expense-form'
import { DonutChart, RankedBarChart, SERIES, TimeBarChart, TrendChart } from '@/components/charts'
import { UsageTable } from './CustomerDetail'

async function exportReport(kind: ReportKind, params: Record<string, unknown>) {
  try {
    const r = await call('reports:exportCsv', { kind, ...params })
    if (r.saved) toast.success(`Saved ${r.fileName} (${r.rowCount ?? 0} rows)`)
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

async function printReport(kind: ReportKind, params: Record<string, unknown>) {
  try {
    await call('reports:print', { kind, ...params })
  } catch (e) {
    toast.error(errorMessage(e))
  }
}

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/* ------------------------------------------------- Receipts / payouts pages */

function CashMovementPage({ type }: { type: 'RECEIPT' | 'PAYOUT' }) {
  const isReceipt = type === 'RECEIPT'
  const [range, setRange] = useDateRange('thisMonth')
  const [page, setPage] = useState(1)
  const [openTxn, setOpenTxn] = useState<number | null>(null)
  const { data, isLoading, error } = useApi('ledger:list', { types: [type], from: range.from, to: range.to, sortDir: 'desc', page, pageSize: 50 }, { placeholderData: (p) => p, enabled: range.from <= range.to })
  const { money } = useFormat()
  const kind: ReportKind = isReceipt ? 'receipts' : 'payouts'
  return (
    <div className="space-y-4">
      <PageHeader
        title={isReceipt ? 'Money Received' : 'Money Paid to Customers'}
        icon={isReceipt ? ArrowDownLeft : ArrowUpRight}
        description={
          isReceipt
            ? 'Record money collected from customers. Saved only after the database confirms the transaction.'
            : 'Refunds, returns of unused advances and other approved customer payouts.'
        }
      />
      <div className="space-y-4">
        <Card className="max-w-5xl">
          <CardHeader title={isReceipt ? 'New receipt' : 'New payout'} description="Fields marked * are required" />
          <CardBody>{isReceipt ? <ReceiptForm /> : <PayoutForm />}</CardBody>
        </Card>
        <Card className="min-w-0">
          <CardHeader
            title={isReceipt ? 'Recorded receipts' : 'Recorded payouts'}
            description={data ? `Total for period (net of reversals): ${money(isReceipt ? data.totals.receivedMinor : data.totals.paidMinor)}` : undefined}
            actions={
              <>
                <Button size="sm" variant="outline" onClick={() => exportReport(kind, { from: range.from, to: range.to })}>
                  <Download /> CSV
                </Button>
                <Button size="sm" variant="outline" onClick={() => printReport(isReceipt ? 'customer_payment_summary' : 'customer_payout_summary', { from: range.from, to: range.to })}>
                  <Printer /> Summary
                </Button>
              </>
            }
          />
          <CardBody className="border-b border-silver-100">
            <DateRangeControl value={range} onChange={(v) => (setRange(v), setPage(1))} />
          </CardBody>
          {isLoading && <Spinner />}
          {error && <ErrorState error={error} />}
          {data && (
            <>
              <LedgerTable rows={data.rows} showCustomer onOpen={setOpenTxn} emptyText={isReceipt ? 'No receipts in this period.' : 'No payouts in this period.'} />
              <Pagination page={page} pageSize={50} total={data.total} onPageChange={setPage} />
            </>
          )}
        </Card>
      </div>
      <TransactionDetailDialog txnId={openTxn} onClose={() => setOpenTxn(null)} />
    </div>
  )
}

export const MoneyReceived = () => <CashMovementPage type="RECEIPT" />
export const MoneyPaid = () => <CashMovementPage type="PAYOUT" />

/* ------------------------------------------------------------ Daily usage */

export function DailyUsage() {
  const [range, setRange] = useDateRange('thisMonth')
  const [customerId, setCustomerId] = useState<number | null>(null)
  const [categoryId, setCategoryId] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [page, setPage] = useState(1)
  const [correcting, setCorrecting] = useState<UsageEntry | null>(null)
  const { data: lookups } = useLookups()
  const { money, date } = useFormat()
  const valid = range.from <= range.to
  const { data: summary } = useApi('usage:summary', { from: range.from, to: range.to }, { enabled: valid, placeholderData: (p) => p })
  const { data: list, isLoading } = useApi(
    'usage:list',
    { from: range.from, to: range.to, customerId, categoryId: categoryId ? Number(categoryId) : null, search: debouncedSearch || null, page, pageSize: 50 },
    { enabled: valid, placeholderData: (p) => p }
  )
  return (
    <div className="space-y-4">
      <PageHeader title="Daily Usage" icon={Timer} description="Record services and resources used by customers. Each line posts one usage charge to the customer ledger." />
      <Card>
        <CardHeader title="Add usage" description="Several lines can be posted for the same customer and date in one step" />
        <CardBody>
          <UsageBatchForm />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="flex flex-wrap items-end justify-between gap-3">
          <DateRangeControl value={range} onChange={(v) => (setRange(v), setPage(1))} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => exportReport('usage', { from: range.from, to: range.to, customerId, categoryId: categoryId ? Number(categoryId) : null })}>
              <Download /> Usage CSV
            </Button>
            <Button variant="outline" onClick={() => printReport('usage', { from: range.from, to: range.to, customerId, categoryId: categoryId ? Number(categoryId) : null })}>
              <Printer /> Print report
            </Button>
          </div>
        </CardBody>
      </Card>

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Today's usage" value={money(summary.todayTotalMinor)} sub={date(summary.today)} tone="dark" />
            <StatCard label="Usage in period" value={money(summary.periodTotalMinor)} />
            <StatCard label="Average daily usage" value={money(summary.averageDailyMinor)} help="Period total divided by the number of calendar days in the period." />
            <StatCard label="Days with usage" value={summary.activeDays.toLocaleString()} />
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <div className="xl:col-span-2">
              {summary.daily.length > 0 ? (
                <TrendChart title="Daily usage" data={summary.daily.map((d) => ({ date: d.date, amountMinor: d.amountMinor }))} valueKey="amountMinor" label="Usage" />
              ) : (
                <TimeBarChart title="Monthly usage" data={summary.monthly.map((m) => ({ bucket: m.month, amount: m.amountMinor }))} series={[{ key: 'amount', label: 'Usage', color: SERIES[0] }]} />
              )}
            </div>
            <DonutChart title="Usage by category" items={summary.byCategory.map((c) => ({ name: c.name, value: c.amountMinor }))} />
            <RankedBarChart title="Highest-usage customers" items={summary.byCustomer} />
            <TimeBarChart title="Weekly usage" description="Weeks start on Monday" data={summary.weekly.map((w) => ({ bucket: w.weekStart, amount: w.amountMinor }))} series={[{ key: 'amount', label: 'Usage', color: SERIES[0] }]} />
            <TimeBarChart title="Monthly usage" data={summary.monthly.map((m) => ({ bucket: m.month, amount: m.amountMinor }))} series={[{ key: 'amount', label: 'Usage', color: SERIES[0] }]} />
          </div>
        </>
      )}

      <Card>
        <CardHeader title="Usage entries" description={list ? `${list.total} entr(ies) · posted total ${money(list.totalMinor)}` : undefined} />
        <div className="flex flex-wrap items-center gap-2 border-b border-silver-100 p-3">
          <div className="w-72">
            <CustomerPicker id="usage-filter-customer" value={customerId} onChange={(id) => (setCustomerId(id), setPage(1))} placeholder="Filter by customer…" />
          </div>
          {customerId && (
            <Button size="sm" variant="ghost" onClick={() => setCustomerId(null)}>
              Clear customer
            </Button>
          )}
          <Select aria-label="Usage category" className="w-44" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setPage(1))}>
            <option value="">All categories</option>
            {lookups?.usage_categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Input aria-label="Search usage" placeholder="Search description or reference" className="w-64" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        </div>
        {isLoading && <Spinner />}
        {list && (
          <>
            <UsageTable rows={list.rows} onCorrect={setCorrecting} date={date} showCustomer />
            <Pagination page={page} pageSize={50} total={list.total} onPageChange={setPage} />
          </>
        )}
      </Card>
      <UsageCorrectionDialog entry={correcting} onClose={() => setCorrecting(null)} />
    </div>
  )
}

/* ------------------------------------------------------------- Expenses */

export function Expenses() {
  const [range, setRange] = useDateRange('thisMonth')
  const [categoryId, setCategoryId] = useState('')
  const [methodId, setMethodId] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<ExpenseRow | null>(null)
  const { data: lookups } = useLookups()
  const { money, date } = useFormat()
  const valid = range.from <= range.to
  const { data: summary } = useApi('expenses:summary', { from: range.from, to: range.to }, { enabled: valid, placeholderData: (p) => p })
  const filters = { from: range.from, to: range.to, categoryId: categoryId ? Number(categoryId) : null, paymentMethodId: methodId ? Number(methodId) : null }
  const { data: list, isLoading } = useApi('expenses:list', { ...filters, search: debouncedSearch || null, page, pageSize: 50 }, { enabled: valid, placeholderData: (p) => p })
  return (
    <div className="space-y-4">
      <PageHeader title="Business Expenses" icon={Receipt} description="Operating costs of the business, kept separate from customer accounts" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,520px)_1fr]">
        <Card>
          <CardHeader title="New expense" />
          <CardBody>
            <ExpenseForm compact />
          </CardBody>
        </Card>
        <div className="min-w-0 space-y-4">
          {summary && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Today" value={money(summary.todayMinor)} />
              <StatCard label="This week" value={money(summary.thisWeekMinor)} sub="Monday to today" />
              <StatCard label="This month" value={money(summary.thisMonthMinor)} />
              <StatCard label="Selected period" value={money(summary.periodTotalMinor)} tone="dark" />
            </div>
          )}
          <Card>
            <CardBody className="flex flex-wrap items-end justify-between gap-3">
              <DateRangeControl value={range} onChange={(v) => (setRange(v), setPage(1))} />
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => exportReport('expenses', filters)}>
                  <Download /> CSV
                </Button>
                <Button variant="outline" onClick={() => printReport('expenses', filters)}>
                  <Printer /> Print
                </Button>
              </div>
            </CardBody>
          </Card>
          {summary && (
            <div className="grid gap-4 lg:grid-cols-2">
              <DonutChart title="Expenses by category" description="Highest-cost categories first" items={summary.byCategory.map((c) => ({ name: c.name, value: c.amountMinor }))} />
              <RankedBarChart title="Expenses by payment method" items={summary.byPaymentMethod} />
              <div className="lg:col-span-2">
                <TrendChart title="Monthly expense trend" description="12 months ending with the selected period" data={summary.monthlyTrend} valueKey="amountMinor" label="Expenses" />
              </div>
            </div>
          )}
        </div>
      </div>
      <Card>
        <CardHeader title="Expense records" description={list ? `${list.total} record(s) · total ${money(list.totalMinor)}` : undefined} />
        <div className="flex flex-wrap items-center gap-2 border-b border-silver-100 p-3">
          <Select aria-label="Expense category" className="w-48" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setPage(1))}>
            <option value="">All categories</option>
            {lookups?.expense_categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Payment method" className="w-44" value={methodId} onChange={(e) => (setMethodId(e.target.value), setPage(1))}>
            <option value="">All methods</option>
            {lookups?.payment_methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <Input aria-label="Search expenses" placeholder="Search description, supplier, reference" className="w-72" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        </div>
        {isLoading && <Spinner />}
        {list && (
          <>
            <Table className="max-h-[520px]">
              <THead>
                <tr>
                  <Th>Date</Th>
                  <Th>Reference</Th>
                  <Th>Category</Th>
                  <Th>Description</Th>
                  <Th>Supplier</Th>
                  <Th>Method</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </THead>
              <tbody>
                {list.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-10 text-center text-sm text-ink-muted">
                      No expenses for these filters.
                    </td>
                  </tr>
                )}
                {list.rows.map((x) => (
                  <Tr key={x.id} onClick={() => setOpen(x)} className={x.isReversal || x.reversedByReference ? 'text-ink-muted' : ''}>
                    <Td className="whitespace-nowrap">{date(x.expenseDate)}</Td>
                    <Td className="font-mono text-xs">
                      {x.reference}
                      {x.isReversal && <Badge className="ml-1">Reversal</Badge>}
                      {x.reversedByReference && <span className="ml-1 text-due">(reversed)</span>}
                    </Td>
                    <Td>{x.category}</Td>
                    <Td className="max-w-72">{x.description}</Td>
                    <Td>{x.supplier ?? '—'}</Td>
                    <Td className="text-xs text-ink-muted">{x.paymentMethod}</Td>
                    <Td align="right" className="font-semibold">
                      <MoneyText minor={x.amountMinor} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={50} total={list.total} onPageChange={setPage} />
          </>
        )}
      </Card>
      <ExpenseDetailDialog expense={open} onClose={() => setOpen(null)} />
    </div>
  )
}

/* --------------------------------------------------------- Unified ledger */

export function Transactions() {
  const [range, setRange] = useDateRange('thisMonth')
  const [type, setType] = useState<TransactionType | ''>('')
  const [customerId, setCustomerId] = useState<number | null>(null)
  const [methodId, setMethodId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounced(search)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [openTxn, setOpenTxn] = useState<number | null>(null)
  const { data: lookups } = useLookups()
  const { money } = useFormat()
  const filters = {
    from: range.from,
    to: range.to,
    types: type ? [type] : null,
    customerId,
    paymentMethodId: methodId ? Number(methodId) : null,
    categoryId: categoryId ? Number(categoryId) : null
  }
  const { data, isLoading, error } = useApi('ledger:list', { ...filters, search: debouncedSearch || null, sortDir, page, pageSize: 100 }, { placeholderData: (p) => p, enabled: range.from <= range.to })
  return (
    <div className="space-y-4">
      <PageHeader
        title="Transactions / Ledger"
        icon={BookOpen}
        description="Every customer ledger entry. Running balances are per customer, calculated over the full account history."
        actions={
          <>
            <Button variant="outline" onClick={() => exportReport('transactions', filters)}>
              <Download /> Export CSV
            </Button>
            <Button variant="outline" onClick={() => printReport('daily_cashbook', { from: range.from, to: range.to })}>
              <Printer /> Daily cashbook
            </Button>
          </>
        }
      />
      <Card>
        <CardBody className="space-y-3">
          <DateRangeControl value={range} onChange={(v) => (setRange(v), setPage(1))} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72">
              <CustomerPicker id="ledger-filter-customer" value={customerId} onChange={(id) => (setCustomerId(id), setPage(1))} />
            </div>
            {customerId && (
              <Button size="sm" variant="ghost" onClick={() => setCustomerId(null)}>
                All customers
              </Button>
            )}
            <Select aria-label="Transaction type" className="w-52" value={type} onChange={(e) => (setType(e.target.value as TransactionType), setPage(1))}>
              <option value="">All types</option>
              {TRANSACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRANSACTION_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
            <Select aria-label="Payment method" className="w-44" value={methodId} onChange={(e) => (setMethodId(e.target.value), setPage(1))}>
              <option value="">All methods</option>
              {lookups?.payment_methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Category" className="w-48" value={categoryId} onChange={(e) => (setCategoryId(e.target.value), setPage(1))}>
              <option value="">All categories</option>
              {lookups?.transaction_categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Input aria-label="Search transactions" placeholder="Reference, description, customer…" className="w-72" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
            <Select aria-label="Sort order" className="w-40" value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}>
              <option value="desc">Newest first</option>
              <option value="asc">Oldest first</option>
            </Select>
          </div>
        </CardBody>
      </Card>
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Entries" value={data.total.toLocaleString()} />
          <StatCard label="Received" value={money(data.totals.receivedMinor)} />
          <StatCard label="Paid out" value={money(data.totals.paidMinor)} />
          <StatCard label="Usage charges" value={money(data.totals.usageMinor)} />
          <StatCard label="Net balance effect" value={<MoneyText minor={data.totals.netEffectMinor} tone="balance" />} help="Sum of the balance effect of all listed entries (credits minus debits)." />
        </div>
      )}
      <Card>
        {isLoading && <Spinner />}
        {error && <ErrorState error={error} />}
        {data && (
          <>
            <LedgerTable rows={data.rows} showCustomer onOpen={setOpenTxn} />
            <Pagination page={page} pageSize={100} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>
      <TransactionDetailDialog txnId={openTxn} onClose={() => setOpenTxn(null)} />
    </div>
  )
}
