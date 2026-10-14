import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Download, Pencil, Power, Printer, Scale, Timer, User } from 'lucide-react'
import { toast } from 'sonner'
import { TRANSACTION_TYPES, TRANSACTION_TYPE_LABELS, type TransactionType } from '@shared/finance'
import { quantityToString } from '@shared/money'
import type { UsageEntry } from '@shared/types'
import { call, errorMessage } from '@/lib/api'
import { useApi, useApiMutation, useFormat, useLookups } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardBody, CardHeader, ErrorState, PageHeader, Spinner } from '@/components/ui/layout'
import { ConfirmDialog, Dialog, TabPanel, Tabs } from '@/components/ui/overlay'
import { Input, Select } from '@/components/ui/form'
import { Pagination, Table, THead, Th, Tr, Td } from '@/components/ui/table'
import { BalanceBadge, DateRangeControl, MoneyText, StatCard, useDateRange } from '@/components/domain'
import { DonutChart, SERIES, TimeBarChart, TrendChart } from '@/components/charts'
import { LedgerTable, TransactionDetailDialog, UsageCorrectionDialog } from '@/components/txn-dialogs'
import { CustomerForm } from '@/components/forms/customer-form'
import { useQuickAction } from '@/components/layout/AppShell'

export function CustomerDetail() {
  const id = Number(useParams().id)
  const quick = useQuickAction()
  const { money, date } = useFormat()
  const { data: customer, isLoading, error, refetch } = useApi('customers:get', { id }, { enabled: id > 0 })
  const [tab, setTab] = useState('ledger')
  const [editing, setEditing] = useState(false)
  const [confirmStatus, setConfirmStatus] = useState(false)
  const [range, setRange] = useDateRange('last30')
  const statusMutation = useApiMutation('customers:setStatus', { successMessage: (c) => `${c.name} is now ${c.status.toLowerCase()}` })

  if (isLoading) return <Spinner />
  if (error || !customer) return <ErrorState error={error ?? new Error('Customer not found')} onRetry={() => refetch()} />

  const exportStatement = async () => {
    try {
      const r = await call('reports:exportCsv', { kind: 'customer_statement', customerId: id, from: range.from, to: range.to })
      if (r.saved) toast.success(`Saved ${r.fileName}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const printStatement = async () => {
    try {
      await call('reports:print', { kind: 'customer_statement', customerId: id, from: range.from, to: range.to })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div className="space-y-4">
      <Button asChild variant="link" size="sm">
        <Link to="/customers">
          <ArrowLeft /> All customers
        </Link>
      </Button>
      <PageHeader
        title={customer.name}
        icon={User}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{customer.customerCode}</span>
            <Badge tone={customer.status === 'ACTIVE' ? 'credit' : 'neutral'}>{customer.status === 'ACTIVE' ? 'Active' : 'Inactive'}</Badge>
            <BalanceBadge minor={customer.balanceMinor} />
          </span>
        }
        actions={
          <>
            <Button variant="primary" onClick={() => quick.open('receipt', { customerId: id })}>
              <ArrowDownLeft /> Record receipt
            </Button>
            <Button variant="outline" onClick={() => quick.open('payout', { customerId: id })}>
              <ArrowUpRight /> Pay customer
            </Button>
            <Button variant="outline" onClick={() => quick.open('usage', { customerId: id })} disabled={customer.status !== 'ACTIVE'}>
              <Timer /> Add usage
            </Button>
            <Button variant="outline" onClick={() => quick.open('adjustment', { customerId: id })}>
              <Scale /> Adjust
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Current balance" value={<MoneyText minor={customer.balanceMinor} tone="balance" />} tone="dark" sub={customer.balanceMinor >= 0 ? 'Credit held for the customer' : 'Customer owes the business'} />
        <StatCard label="Total received" value={money(customer.receivedMinor)} />
        <StatCard label="Total paid out" value={money(customer.paidMinor)} />
        <StatCard label="Total usage charges" value={money(customer.usageMinor)} />
        <StatCard label="Outstanding amount" value={<span className={customer.outstandingMinor ? 'text-due' : ''}>{money(customer.outstandingMinor)}</span>} sub={`Opening ${money(customer.openingMinor)} · adj. +${money(customer.creditAdjustmentsMinor)} / −${money(customer.debitAdjustmentsMinor)}`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardBody className="flex flex-wrap items-end justify-between gap-3">
              <DateRangeControl value={range} onChange={setRange} label="Statement period" />
              <div className="flex gap-2">
                <Button variant="outline" onClick={exportStatement}>
                  <Download /> Statement CSV
                </Button>
                <Button variant="outline" onClick={printStatement}>
                  <Printer /> Print statement
                </Button>
              </div>
            </CardBody>
          </Card>
          <Tabs
            value={tab}
            onValueChange={setTab}
            tabs={[
              { value: 'ledger', label: 'Account ledger' },
              { value: 'usage', label: 'Daily usage history' },
              { value: 'charts', label: 'Charts' }
            ]}
          >
            <TabPanel value="ledger">
              <CustomerLedger customerId={id} from={range.from} to={range.to} />
            </TabPanel>
            <TabPanel value="usage">
              <CustomerUsage customerId={id} from={range.from} to={range.to} />
            </TabPanel>
            <TabPanel value="charts">
              <CustomerCharts customerId={id} from={range.from} to={range.to} />
            </TabPanel>
          </Tabs>
        </div>

        <Card className="h-fit">
          <CardHeader
            title="Customer information"
            actions={
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            }
          />
          <CardBody>
            <dl className="space-y-3 text-sm">
              {[
                ['Phone', customer.phone],
                ['Email', customer.email],
                ['Address', customer.address],
                ['Registered', date(customer.registrationDate)],
                ['Last transaction', customer.lastTxnDate ? date(customer.lastTxnDate) : null],
                ['Ledger entries', String(customer.transactionCount)],
                ['Notes', customer.notes],
                ['Created', `${formatDateTime(customer.createdAt)}${customer.createdBy ? ` by ${customer.createdBy}` : ''}`],
                ['Last updated', formatDateTime(customer.updatedAt)]
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{k}</dt>
                  <dd className="mt-0.5 whitespace-pre-wrap break-words">{v || <span className="text-ink-faint">—</span>}</dd>
                </div>
              ))}
            </dl>
            <Button className="mt-4 w-full" variant={customer.status === 'ACTIVE' ? 'outline' : 'dark'} onClick={() => setConfirmStatus(true)}>
              <Power /> {customer.status === 'ACTIVE' ? 'Deactivate account' : 'Reactivate account'}
            </Button>
          </CardBody>
        </Card>
      </div>

      <Dialog open={editing} onOpenChange={setEditing} title={`Edit ${customer.customerCode}`} size="lg">
        <CustomerForm existing={customer} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
      </Dialog>
      <ConfirmDialog
        open={confirmStatus}
        onOpenChange={setConfirmStatus}
        title={customer.status === 'ACTIVE' ? 'Deactivate this customer?' : 'Reactivate this customer?'}
        confirmLabel={customer.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'}
        loading={statusMutation.isPending}
        onConfirm={async () => {
          try {
            await statusMutation.mutateAsync({ id, status: customer.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })
          } finally {
            setConfirmStatus(false)
          }
        }}
      >
        {customer.status === 'ACTIVE'
          ? 'Inactive customers keep their full history and balance. New usage charges are blocked until the account is reactivated; receipts and payouts can still settle the balance.'
          : 'The customer will be able to receive new usage charges again.'}
      </ConfirmDialog>
    </div>
  )
}

function CustomerLedger({ customerId, from, to }: { customerId: number; from: string; to: string }) {
  const { money } = useFormat()
  const { data: lookups } = useLookups()
  const [type, setType] = useState<TransactionType | ''>('')
  const [methodId, setMethodId] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [openTxn, setOpenTxn] = useState<number | null>(null)
  const { data, isLoading, error } = useApi(
    'ledger:list',
    { customerId, from, to, types: type ? [type] : null, paymentMethodId: methodId ? Number(methodId) : null, search: search || null, sortDir: 'asc', page, pageSize: 100 },
    { placeholderData: (p) => p, enabled: from <= to }
  )
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-silver-100 p-3">
        <Select aria-label="Transaction type" className="w-48" value={type} onChange={(e) => (setType(e.target.value as TransactionType), setPage(1))}>
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
        <Input aria-label="Search ledger" placeholder="Search reference, description, notes" className="w-72" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
      </div>
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} />}
      {data && (
        <>
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-silver-100 bg-silver-100/40 px-3 py-2 text-xs text-ink-muted">
            <span>
              Balance before period: <MoneyText minor={data.periodOpeningMinor ?? 0} tone="balance" className="font-semibold" />
            </span>
            <span>Received: {money(data.totals.receivedMinor)}</span>
            <span>Paid: {money(data.totals.paidMinor)}</span>
            <span>Usage: {money(data.totals.usageMinor)}</span>
            <span>
              Balance at period end: <MoneyText minor={data.periodClosingMinor ?? 0} tone="balance" className="font-semibold" />
            </span>
          </div>
          <LedgerTable rows={data.rows} onOpen={setOpenTxn} emptyText="No ledger entries in this period." />
          <Pagination page={page} pageSize={100} total={data.total} onPageChange={setPage} />
        </>
      )}
      <TransactionDetailDialog txnId={openTxn} onClose={() => setOpenTxn(null)} />
    </Card>
  )
}

function CustomerUsage({ customerId, from, to }: { customerId: number; from: string; to: string }) {
  const { money, date } = useFormat()
  const [page, setPage] = useState(1)
  const [correcting, setCorrecting] = useState<UsageEntry | null>(null)
  const { data, isLoading } = useApi('usage:list', { customerId, from, to, page, pageSize: 100 }, { placeholderData: (p) => p, enabled: from <= to })
  return (
    <Card>
      {isLoading && <Spinner />}
      {data && (
        <>
          <div className="border-b border-silver-100 bg-silver-100/40 px-3 py-2 text-xs text-ink-muted">Posted usage in period: {money(data.totalMinor)}</div>
          <UsageTable rows={data.rows} onCorrect={setCorrecting} date={date} />
          <Pagination page={page} pageSize={100} total={data.total} onPageChange={setPage} />
        </>
      )}
      <UsageCorrectionDialog entry={correcting} onClose={() => setCorrecting(null)} />
    </Card>
  )
}

export function UsageTable({ rows, onCorrect, date, showCustomer }: { rows: UsageEntry[]; onCorrect: (e: UsageEntry) => void; date: (d: string) => string; showCustomer?: boolean }) {
  const { money } = useFormat()
  return (
    <Table className="max-h-[520px]">
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Reference</Th>
          {showCustomer && <Th>Customer</Th>}
          <Th>Category</Th>
          <Th>Item / service</Th>
          <Th align="right">Qty × rate</Th>
          <Th align="right">Fees</Th>
          <Th align="right">Discount</Th>
          <Th align="right">Charge</Th>
          <Th>Status</Th>
          <Th />
        </tr>
      </THead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={showCustomer ? 11 : 10} className="px-3 py-10 text-center text-sm text-ink-muted">
              No usage recorded for these filters.
            </td>
          </tr>
        )}
        {rows.map((u) => (
          <Tr key={u.id} className={u.status === 'REVERSED' ? 'text-ink-muted line-through decoration-silver' : ''}>
            <Td className="whitespace-nowrap">{date(u.usageDate)}</Td>
            <Td className="font-mono text-xs">{u.txnReference}</Td>
            {showCustomer && (
              <Td>
                {u.customerName}
                <span className="block text-xs text-ink-muted">{u.customerCode}</span>
              </Td>
            )}
            <Td>{u.category}</Td>
            <Td className="max-w-64">
              {u.description}
              {u.method === 'FIXED' && u.fixedReason && <span className="block text-xs text-ink-muted">Fixed: {u.fixedReason}</span>}
              {u.replacesEntryId && <span className="block text-xs text-ink-muted">Correction of entry #{u.replacesEntryId}</span>}
            </Td>
            <Td align="right">{u.method === 'QUANTITY' ? `${quantityToString(u.quantityMilli ?? 0)} ${u.unit ?? ''} × ${money(u.rateMinor ?? 0)}` : 'Fixed'}</Td>
            <Td align="right">{u.feesMinor ? money(u.feesMinor) : ''}</Td>
            <Td align="right">{u.discountMinor ? money(u.discountMinor) : ''}</Td>
            <Td align="right" className="font-semibold">
              {money(u.chargeMinor)}
            </Td>
            <Td>{u.status === 'REVERSED' ? <Badge tone="due">Reversed {u.reversalReference}</Badge> : <Badge tone="credit">Posted</Badge>}</Td>
            <Td>
              {u.status === 'POSTED' && (
                <Button size="sm" variant="ghost" onClick={() => onCorrect(u)}>
                  Correct
                </Button>
              )}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function CustomerCharts({ customerId, from, to }: { customerId: number; from: string; to: string }) {
  const { data } = useApi('customers:analytics', { customerId, from, to }, { enabled: from <= to })
  if (!data) return <Spinner />
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <TrendChart title="Balance over time" description="End-of-day account balance" data={data.balanceSeries.map((b) => ({ date: b.date, balanceMinor: b.balanceMinor }))} valueKey="balanceMinor" label="Balance" />
      <DonutChart title="Usage by category" items={data.usageByCategory.map((c) => ({ name: c.name, value: c.amountMinor }))} emptyText="No usage in this period." />
      <div className="lg:col-span-2">
        <TimeBarChart
          title="Monthly activity"
          description="12 months ending with the selected period"
          data={data.monthly.map((m) => ({ bucket: m.month, received: m.receivedMinor, paid: m.paidMinor, usage: m.usageMinor }))}
          series={[
            { key: 'received', label: 'Received', color: SERIES[0] },
            { key: 'paid', label: 'Paid out', color: SERIES[1] },
            { key: 'usage', label: 'Usage charges', color: SERIES[2] }
          ]}
        />
      </div>
    </div>
  )
}
