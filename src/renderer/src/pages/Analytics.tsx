import { BarChart3, Download, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { call, errorMessage } from '@/lib/api'
import { useApi, useFormat } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Card, CardBody, ErrorState, PageHeader, Spinner } from '@/components/ui/layout'
import { Table, THead, Th, Tr, Td } from '@/components/ui/table'
import { DateRangeControl, useDateRange } from '@/components/domain'
import { BalanceDistributionChart, DonutChart, RankedBarChart, SERIES, TimeBarChart, TrendChart } from '@/components/charts'
import { KpiGrid } from './Dashboard'
import { formatMonthKey } from '@shared/dates'

export function Analytics() {
  const [range, setRange] = useDateRange('last30')
  const valid = range.from <= range.to
  const { data, isLoading, error, refetch } = useApi('analytics:dashboard', { from: range.from, to: range.to }, { enabled: valid, placeholderData: (p) => p })
  const { money, date } = useFormat()
  const exportCsv = async (kind: 'dashboard_summary' | 'daily_summary' | 'monthly_summary') => {
    try {
      const r = await call('reports:exportCsv', { kind, from: range.from, to: range.to })
      if (r.saved) toast.success(`Saved ${r.fileName}`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const print = async () => {
    try {
      await call('reports:print', { kind: 'monthly_summary', from: range.from, to: range.to })
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const lastMonth = data?.monthlyCashFlow.at(-1)?.month
  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        icon={BarChart3}
        description="Cash flow, usage and spending analysis from saved records · based on transaction date"
        actions={
          <>
            <Button variant="outline" onClick={() => exportCsv('dashboard_summary')}>
              <Download /> Summary CSV
            </Button>
            <Button variant="outline" onClick={() => exportCsv('daily_summary')}>
              <Download /> Daily CSV
            </Button>
            <Button variant="outline" onClick={print}>
              <Printer /> Print monthly summary
            </Button>
          </>
        }
      />
      <Card>
        <CardBody>
          <DateRangeControl value={range} onChange={setRange} />
          {!valid && <p className="mt-2 text-xs text-due">Start date must be on or before end date.</p>}
        </CardBody>
      </Card>
      {isLoading && !data && <Spinner />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {data && (
        <>
          <KpiGrid title={`Selected period · ${date(data.range.from)} – ${date(data.range.to)}`} kpis={data.periodKpis} />
          <div className="grid gap-4 xl:grid-cols-2">
            <TimeBarChart
              title="1 · Money received vs. money paid"
              description={`By ${data.granularity}`}
              data={data.cashFlowSeries.map((s) => ({ bucket: s.bucket, received: s.receivedMinor, paid: s.paidMinor }))}
              series={[
                { key: 'received', label: 'Received', color: SERIES[0] },
                { key: 'paid', label: 'Paid to customers', color: SERIES[1] }
              ]}
            />
            <TrendChart title="2 · Daily usage charges" description={`By ${data.granularity}`} data={data.usageSeries} valueKey="amountMinor" label="Usage charges" />
            <DonutChart title="3 · Business expenses by category" items={data.expensesByCategory.map((c) => ({ name: c.name, value: c.amountMinor }))} emptyText="No business expenses in this period." />
            <DonutChart title="4 · Customer usage by category" items={data.usageByCategory.map((c) => ({ name: c.name, value: c.amountMinor }))} emptyText="No usage posted in this period." />
            <RankedBarChart title="5 · Top customers by usage charges" items={data.topCustomersByUsage} color={SERIES[0]} emptyText="No usage posted in this period." />
            <RankedBarChart title="6 · Top customers by payments received" items={data.topCustomersByReceipts} color={SERIES[0]} emptyText="No receipts in this period." />
            <TimeBarChart
              title="7 · Monthly cash inflow and outflow"
              description={`12 months ending ${lastMonth ? formatMonthKey(lastMonth) : ''} · outflow = payouts + expenses`}
              data={data.monthlyCashFlow.map((m) => ({ bucket: m.month, inflow: m.inflowMinor, outflow: m.outflowMinor }))}
              series={[
                { key: 'inflow', label: 'Cash in (received)', color: SERIES[0] },
                { key: 'outflow', label: 'Cash out (payouts + expenses)', color: SERIES[1] }
              ]}
            />
            <TimeBarChart
              title="8 · Monthly expense trend"
              description="12 months ending with the selected period"
              data={data.monthlyExpenseTrend.map((m) => ({ bucket: m.month, amount: m.amountMinor }))}
              series={[{ key: 'amount', label: 'Business expenses', color: SERIES[0] }]}
            />
            <BalanceDistributionChart title="9 · Customer balance distribution" items={data.balanceDistribution} />
            <DonutChart
              title="10 · Transaction type breakdown"
              description="Number of entries in the period (reversal entries included)"
              valueKind="count"
              items={data.transactionTypeBreakdown.map((t) => ({ name: t.label, value: t.count }))}
              emptyText="No entries in this period."
            />
          </div>
          <Card>
            <div className="border-b border-silver-100 px-4 py-3">
              <h3 className="text-sm font-semibold">Customer spending ranking</h3>
              <p className="text-xs text-ink-muted">Usage charges and receipts in the selected period</p>
            </div>
            <Table>
              <THead>
                <tr>
                  <Th>#</Th>
                  <Th>Customer</Th>
                  <Th align="right">Usage charges</Th>
                  <Th align="right">Usage entries</Th>
                </tr>
              </THead>
              <tbody>
                {data.topCustomersByUsage.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-ink-muted">
                      No usage in this period.
                    </td>
                  </tr>
                )}
                {data.topCustomersByUsage.map((c, i) => (
                  <Tr key={c.id ?? i}>
                    <Td>{i + 1}</Td>
                    <Td>
                      {c.name} <span className="text-xs text-ink-muted">{c.customerCode}</span>
                    </Td>
                    <Td align="right">{money(c.amountMinor)}</Td>
                    <Td align="right">{c.count}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
