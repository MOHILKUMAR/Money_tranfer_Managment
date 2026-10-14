import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Download, Search, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { CustomerListInput } from '@shared/schemas'
import { call, errorMessage } from '@/lib/api'
import { useApi, useFormat } from '@/lib/queries'
import { Button } from '@/components/ui/button'
import { Card, EmptyState, ErrorState, Badge, PageHeader, Spinner } from '@/components/ui/layout'
import { Input, Select } from '@/components/ui/form'
import { Pagination, SortTh, Table, THead, Th, Tr, Td } from '@/components/ui/table'
import { BalanceBadge, MoneyText, StatCard } from '@/components/domain'
import { useQuickAction } from '@/components/layout/AppShell'

type SortBy = NonNullable<CustomerListInput['sortBy']>

export function Customers() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const quick = useQuickAction()
  const { money, date } = useFormat()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL')
  const [balanceFilter, setBalanceFilter] = useState<'ALL' | 'CREDIT' | 'DUE' | 'SETTLED'>((params.get('balance') as 'DUE') ?? 'ALL')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const pageSize = 50
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search)
      setPage(1)
    }, 200)
    return () => clearTimeout(t)
  }, [search])
  const { data, isLoading, error, refetch, isFetching } = useApi(
    'customers:list',
    { search: debounced || null, status, balanceFilter, sortBy, sortDir, page, pageSize },
    { placeholderData: (p) => p }
  )
  const sort = (key: SortBy) => {
    if (sortBy === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    else {
      setSortBy(key)
      setSortDir(key === 'balance' || key === 'registrationDate' || key === 'lastTxnDate' ? 'desc' : 'asc')
    }
    setPage(1)
  }
  const exportCsv = async () => {
    try {
      const r = await call('reports:exportCsv', { kind: 'customer_directory', status })
      if (r.saved) toast.success(`Saved ${r.fileName} (${r.rowCount} customers)`)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  return (
    <div className="space-y-4">
      <PageHeader
        title="Customers"
        icon={Users}
        description="Customer accounts with balances derived from the ledger"
        actions={
          <>
            <Button variant="outline" onClick={exportCsv}>
              <Download /> Export directory
            </Button>
            <Button variant="primary" onClick={() => quick.open('customer')}>
              <UserPlus /> Register customer
            </Button>
          </>
        }
      />
      {data && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Customers (filtered)" value={data.totals.customers.toLocaleString()} />
          <StatCard label="Net balance" value={<MoneyText minor={data.totals.balanceMinor} tone="balance" />} />
          <StatCard label="Credit held" value={money(data.totals.creditMinor)} />
          <StatCard label="Amount due" value={<span className="text-due">{money(data.totals.dueMinor)}</span>} />
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-silver-100 p-3">
          <div className="relative w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Input aria-label="Search customers" placeholder="Name, customer code or phone" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select aria-label="Account status" className="w-40" value={status} onChange={(e) => (setStatus(e.target.value as typeof status), setPage(1))}>
            <option value="ALL">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <Select aria-label="Balance filter" className="w-44" value={balanceFilter} onChange={(e) => (setBalanceFilter(e.target.value as typeof balanceFilter), setPage(1))}>
            <option value="ALL">All balances</option>
            <option value="CREDIT">In credit</option>
            <option value="DUE">Amount due</option>
            <option value="SETTLED">Settled</option>
          </Select>
          {isFetching && <span className="text-xs text-ink-faint">Updating…</span>}
        </div>
        {isLoading && <Spinner />}
        {error && <ErrorState error={error} onRetry={() => refetch()} />}
        {data && data.total === 0 && (
          <EmptyState
            icon={Users}
            title={debounced || status !== 'ALL' || balanceFilter !== 'ALL' ? 'No customers match these filters' : 'No customers yet'}
            description={debounced ? 'Try a different name, code or phone number.' : 'Register a customer or import a customer CSV to get started.'}
            action={
              <Button variant="primary" onClick={() => quick.open('customer')}>
                <UserPlus /> Register customer
              </Button>
            }
          />
        )}
        {data && data.total > 0 && (
          <>
            <Table className="max-h-[calc(100vh-360px)]">
              <THead>
                <tr>
                  <SortTh label="Code" active={sortBy === 'code'} dir={sortDir} onClick={() => sort('code')} />
                  <SortTh label="Name" active={sortBy === 'name'} dir={sortDir} onClick={() => sort('name')} />
                  <Th>Phone</Th>
                  <SortTh label="Registered" active={sortBy === 'registrationDate'} dir={sortDir} onClick={() => sort('registrationDate')} />
                  <Th align="right">Received</Th>
                  <Th align="right">Paid out</Th>
                  <Th align="right">Usage</Th>
                  <SortTh label="Balance" align="right" active={sortBy === 'balance'} dir={sortDir} onClick={() => sort('balance')} />
                  <SortTh label="Last txn" active={sortBy === 'lastTxnDate'} dir={sortDir} onClick={() => sort('lastTxnDate')} />
                </tr>
              </THead>
              <tbody>
                {data.rows.map((c) => (
                  <Tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                    <Td className="font-mono text-xs">{c.customerCode}</Td>
                    <Td>
                      <span className="font-medium">{c.name}</span>
                      {c.status === 'INACTIVE' && (
                        <Badge className="ml-2" tone="neutral">
                          Inactive
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-ink-muted">{c.phone ?? '—'}</Td>
                    <Td className="whitespace-nowrap">{date(c.registrationDate)}</Td>
                    <Td align="right">{money(c.receivedMinor)}</Td>
                    <Td align="right">{money(c.paidMinor)}</Td>
                    <Td align="right">{money(c.usageMinor)}</Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        <MoneyText minor={c.balanceMinor} tone="balance" className="font-semibold" />
                        <BalanceBadge minor={c.balanceMinor} />
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-muted">{date(c.lastTxnDate)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={pageSize} total={data.total} onPageChange={setPage} />
          </>
        )}
      </Card>
    </div>
  )
}
