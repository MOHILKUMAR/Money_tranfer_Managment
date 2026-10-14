import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  Gauge,
  HardDrive,
  Landmark,
  Receipt,
  Timer,
  UserCheck,
  UserPlus,
  Users,
  Wallet
} from 'lucide-react'
import type { DashboardData, KpiSet } from '@shared/types'
import { call, errorMessage } from '@/lib/api'
import { useApi, useAppInfo, useFormat } from '@/lib/queries'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, ErrorState, PageHeader, Spinner } from '@/components/ui/layout'
import { DateRangeControl, MoneyText, StatCard, useDateRange } from '@/components/domain'
import { BalanceDistributionChart, SERIES, TimeBarChart, TrendChart } from '@/components/charts'
import { LedgerTable, TransactionDetailDialog } from '@/components/txn-dialogs'
import { useQuickAction } from '@/components/layout/AppShell'

export const KPI_HELP = {
  received: 'Money recorded as received from customers (cash, bank, UPI…). Customer advances and deposits are included; this is not revenue.',
  paid: 'Money recorded as paid back, refunded or transferred to customers.',
  usage: 'Value of services/resources charged to customers from posted daily usage entries. Not a cash movement.',
  expenses: 'Business operating expenses (rent, utilities, supplies…). They never change customer balances.',
  net: 'Net recorded cash flow = money received − money paid to customers − business expenses.',
  credit: 'Sum of all positive customer balances: funds held for customers.',
  due: 'Sum of all negative customer balances: amounts customers owe the business.'
}

export function KpiGrid({ title, kpis, compact }: { title: string; kpis: KpiSet; compact?: boolean }) {
  const { money } = useFormat()
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</p>
      <div className={compact ? 'grid grid-cols-2 gap-3 xl:grid-cols-5' : 'grid grid-cols-2 gap-3 lg:grid-cols-5'}>
        <StatCard label="Money received" value={money(kpis.receivedMinor)} help={KPI_HELP.received} icon={ArrowDownLeft} />
        <StatCard label="Paid to customers" value={money(kpis.paidMinor)} help={KPI_HELP.paid} icon={ArrowUpRight} />
        <StatCard label="Usage charges" value={money(kpis.usageMinor)} help={KPI_HELP.usage} icon={Timer} />
        <StatCard label="Business expenses" value={money(kpis.expensesMinor)} help={KPI_HELP.expenses} icon={Receipt} />
        <StatCard label="Net recorded cash flow" value={<MoneyText minor={kpis.netCashFlowMinor} />} help={KPI_HELP.net} icon={Wallet} tone="accent" />
      </div>
    </div>
  )
}

function Welcome() {
  const { data: info } = useAppInfo()
  const quick = useQuickAction()
  return (
    <Card className="mb-5 overflow-hidden">
      <div className="grid md:grid-cols-[1fr_320px]">
        <div className="p-6">
          <h2 className="text-lg font-semibold">Welcome to Customer Money Manager</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Register customers, record money received and paid, post daily usage, and track business expenses. Every figure on this dashboard is calculated from the records you save.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => quick.open('customer')}>
              <UserPlus /> Register your first customer
            </Button>
            <Button asChild variant="outline">
              <Link to="/settings">Review currency &amp; settings</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/csv">Import from CSV</Link>
            </Button>
          </div>
        </div>
        <div className="bg-charcoal p-6 text-sm text-silver">
          <p className="flex items-center gap-2 font-semibold text-white">
            <HardDrive className="size-4" aria-hidden /> Your data stays on this computer
          </p>
          <p className="mt-2 break-all text-xs">{info?.databasePath}</p>
          <p className="mt-2 text-xs">The database is not encrypted by the app. Protect it with your Windows account and BitLocker, and keep backups on a second drive.</p>
        </div>
      </div>
    </Card>
  )
}

export function Dashboard() {
  const [range, setRange] = useDateRange('thisMonth')
  const valid = range.from <= range.to
  const { data, isLoading, error, refetch } = useApi('analytics:dashboard', { from: range.from, to: range.to }, { enabled: valid, placeholderData: (prev) => prev })
  const [openTxn, setOpenTxn] = useState<number | null>(null)
  const quick = useQuickAction()

  const exportDashboard = async () => {
    try {
      const r = await call('reports:exportCsv', { kind: 'dashboard_summary', from: range.from, to: range.to })
      if (r.saved) toast.success(`Saved ${r.fileName}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        icon={Gauge}
        description="Real-time figures from your local ledger · based on transaction date"
        actions={
          <>
            <Button variant="outline" onClick={() => quick.open('receipt')}>
              <ArrowDownLeft /> Receive
            </Button>
            <Button variant="outline" onClick={() => quick.open('payout')}>
              <ArrowUpRight /> Pay
            </Button>
            <Button variant="outline" onClick={() => quick.open('usage')}>
              <Timer /> Usage
            </Button>
            <Button variant="outline" onClick={() => quick.open('expense')}>
              <Receipt /> Expense
            </Button>
          </>
        }
      />
      {isLoading && !data && <Spinner />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {data && data.customers.total === 0 && <Welcome />}
      {data && <DashboardBody data={data} range={range} setRange={setRange} onOpenTxn={setOpenTxn} onExport={exportDashboard} />}
      <TransactionDetailDialog txnId={openTxn} onClose={() => setOpenTxn(null)} />
    </div>
  )
}

function DashboardBody({
  data,
  range,
  setRange,
  onOpenTxn,
  onExport
}: {
  data: DashboardData
  range: ReturnType<typeof useDateRange>[0]
  setRange: ReturnType<typeof useDateRange>[1]
  onOpenTxn: (id: number) => void
  onExport: () => void
}) {
  const { money, date } = useFormat()
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Registered customers" value={data.customers.total.toLocaleString()} icon={Users} sub={`${data.customers.inactive} inactive`} />
        <StatCard label="Active customers" value={data.customers.active.toLocaleString()} icon={UserCheck} />
        <StatCard
          label="Customer credit outstanding"
          value={money(data.balances.creditOutstandingMinor)}
          help={KPI_HELP.credit}
          icon={Landmark}
          tone="dark"
          sub={`${data.balances.customersInCredit} customer(s) in credit`}
        />
        <StatCard
          label="Total due from customers"
          value={<span className="text-due">{money(data.balances.dueFromCustomersMinor)}</span>}
          help={KPI_HELP.due}
          icon={Wallet}
          tone="accent"
          sub={`${data.balances.customersWithDue} customer(s) owe money`}
        />
      </div>
      <KpiGrid title={`Today · ${date(data.today)}`} kpis={data.todayKpis} />
      <KpiGrid title="This month to date" kpis={data.monthKpis} />

      <Card>
        <CardHeader
          title="Charts"
          description={`Period ${date(data.range.from)} – ${date(data.range.to)} · date basis: ${data.dateBasis}`}
          actions={
            <Button size="sm" variant="outline" onClick={onExport}>
              <Download /> Export CSV
            </Button>
          }
        />
        <CardBody>
          <DateRangeControl value={range} onChange={setRange} />
          {range.from > range.to && <p className="mt-2 text-xs text-due">Start date must be on or before end date.</p>}
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <TimeBarChart
          title="Money received vs. paid"
          description={`By ${data.granularity}`}
          data={data.cashFlowSeries.map((s) => ({ bucket: s.bucket, received: s.receivedMinor, paid: s.paidMinor }))}
          series={[
            { key: 'received', label: 'Received', color: SERIES[0] },
            { key: 'paid', label: 'Paid to customers', color: SERIES[1] }
          ]}
          emptyText="No receipts or payouts in this period."
        />
        <TrendChart title="Daily usage charges" description={`Posted usage by ${data.granularity}`} data={data.usageSeries} valueKey="amountMinor" label="Usage charges" emptyText="No usage posted in this period." />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <BalanceDistributionChart items={data.balanceDistribution} />
        <TimeBarChart
          title="Business expenses"
          description={`By ${data.granularity}`}
          data={data.cashFlowSeries.map((s) => ({ bucket: s.bucket, expenses: s.expensesMinor }))}
          series={[{ key: 'expenses', label: 'Business expenses', color: SERIES[0] }]}
          emptyText="No business expenses in this period."
        />
      </div>

      <div>
        <Card className="min-w-0">
          <CardHeader
            title="Latest transactions"
            description="Most recent ledger entries by transaction date"
            actions={
              <Button asChild size="sm" variant="ghost">
                <Link to="/transactions">View ledger</Link>
              </Button>
            }
          />
          <LedgerTable rows={data.latestTransactions} showCustomer onOpen={onOpenTxn} emptyText="No transactions recorded yet." />
        </Card>
      </div>

      <Card>
        <CardHeader title="Daily summary" description={`Selected period · ${date(data.range.from)} – ${date(data.range.to)}`} />
        <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div>
            <p className="text-xs text-ink-muted">Transactions &amp; expenses</p>
            <p className="text-lg font-semibold">{data.periodKpis.transactionCount.toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Net recorded cash flow</p>
            <p className="text-lg font-semibold">
              <MoneyText minor={data.periodKpis.netCashFlowMinor} />
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Credit adjustments</p>
            <p className="text-lg font-semibold">{money(data.periodKpis.creditAdjustmentsMinor)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Debit adjustments</p>
            <p className="text-lg font-semibold">{money(data.periodKpis.debitAdjustmentsMinor)}</p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
