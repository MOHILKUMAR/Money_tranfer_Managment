import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  DatabaseBackup,
  FileSpreadsheet,
  Gauge,
  Plus,
  Receipt,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Timer,
  UserPlus,
  Users
} from 'lucide-react'
import { useApi, useAppInfo, useFormat } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Popover, PopoverAnchor, PopoverContent, Tip } from '../ui/overlay'
import { Input } from '../ui/form'
import { MoneyText } from '../domain'
import { AdjustmentForm, PayoutForm, ReceiptForm } from '../forms/money-forms'
import { ExpenseForm } from '../forms/expense-form'
import { CustomerForm } from '../forms/customer-form'
import { UsageBatchForm } from '../forms/usage-form'

const NAV = [
  { to: '/', label: 'Dashboard', icon: Gauge, end: true },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/usage', label: 'Daily Usage', icon: Timer },
  { to: '/received', label: 'Money Received', icon: ArrowDownLeft },
  { to: '/paid', label: 'Money Paid', icon: ArrowUpRight },
  { to: '/expenses', label: 'Business Expenses', icon: Receipt },
  { to: '/transactions', label: 'Transactions / Ledger', icon: BookOpen },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/csv', label: 'CSV Import / Export', icon: FileSpreadsheet },
  { to: '/backup', label: 'Backup / Restore', icon: DatabaseBackup },
  { to: '/settings', label: 'Settings', icon: Settings }
]

type QuickKind = 'receipt' | 'payout' | 'usage' | 'expense' | 'customer' | 'adjustment'

interface QuickActionContextValue {
  open: (kind: QuickKind, options?: { customerId?: number | null }) => void
}

const QuickActionContext = createContext<QuickActionContextValue>({ open: () => {} })
export const useQuickAction = () => useContext(QuickActionContext)

const QUICK_TITLES: Record<QuickKind, string> = {
  receipt: 'Record money received',
  payout: 'Record money paid to customer',
  usage: 'Add daily usage',
  expense: 'Record business expense',
  customer: 'Register customer',
  adjustment: 'Record credit / debit adjustment'
}

function QuickActionDialogs({ state, onClose }: { state: { kind: QuickKind; customerId?: number | null } | null; onClose: () => void }) {
  const navigate = useNavigate()
  if (!state) return null
  const size = state.kind === 'usage' ? 'xl' : 'lg'
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={QUICK_TITLES[state.kind]} size={size}>
      {state.kind === 'receipt' && <ReceiptForm defaultCustomerId={state.customerId} onSaved={onClose} />}
      {state.kind === 'payout' && <PayoutForm defaultCustomerId={state.customerId} onSaved={onClose} />}
      {state.kind === 'usage' && <UsageBatchForm defaultCustomerId={state.customerId} onSaved={onClose} />}
      {state.kind === 'expense' && <ExpenseForm onSaved={onClose} />}
      {state.kind === 'adjustment' && <AdjustmentForm defaultCustomerId={state.customerId} onSaved={onClose} />}
      {state.kind === 'customer' && (
        <CustomerForm
          onCancel={onClose}
          onSaved={(id) => {
            onClose()
            navigate(`/customers/${id}`)
          }}
        />
      )}
    </Dialog>
  )
}

function GlobalSearch() {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const { data: hits = [] } = useApi('customers:search', { query, limit: 8 }, { enabled: open && query.trim().length > 0 })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const go = (id: number) => {
    navigate(`/customers/${id}`)
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
  }
  return (
    <Popover open={open && query.trim().length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input
            ref={inputRef}
            aria-label="Search customers"
            placeholder="Search customers by name, code or phone…  (Ctrl+K)"
            className="pl-9"
            value={query}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, hits.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === 'Enter' && hits[active]) {
                go(hits[active].id)
              } else if (e.key === 'Escape') {
                setOpen(false)
                inputRef.current?.blur()
              }
            }}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)]">
        {hits.length === 0 ? (
          <p className="px-3 py-3 text-sm text-ink-muted">No matching customers</p>
        ) : (
          <ul role="listbox" aria-label="Customer search results">
            {hits.map((h, i) => (
              <li
                key={h.id}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h.id)}
                className={cn('flex cursor-pointer items-center justify-between gap-3 rounded px-3 py-2 text-sm', i === active && 'bg-silver-100')}
              >
                <span>
                  <span className="font-medium">{h.name}</span>
                  <span className="ml-2 text-xs text-ink-muted">{h.customerCode}</span>
                </span>
                <MoneyText minor={h.balanceMinor} tone="balance" className="text-xs" />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Notifications() {
  const { data = [] } = useApi('app:notifications', undefined, { refetchInterval: 5 * 60_000 })
  const navigate = useNavigate()
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications (${data.length})`} className="relative">
          <Bell />
          {data.length > 0 && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-racing" aria-hidden />}
        </Button>
      </MenuTrigger>
      <MenuContent>
        <div className="w-80 p-1">
          <p className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted">Local reminders</p>
          {data.length === 0 && <p className="px-2 py-3 text-sm text-ink-muted">Nothing needs attention.</p>}
          {data.map((n) => (
            <MenuItem key={n.id} onSelect={() => n.link && navigate(n.link)}>
              <span className={cn('mt-0.5 size-2 shrink-0 self-start rounded-full', n.level === 'warning' ? 'bg-racing' : 'bg-silver')} aria-hidden />
              <span>
                <span className="block font-medium">{n.title}</span>
                <span className="block text-xs text-ink-muted">{n.message}</span>
              </span>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  )
}

function BackupChip() {
  const { data } = useApi('backup:status', undefined, { refetchInterval: 5 * 60_000 })
  const navigate = useNavigate()
  const days = data?.daysSinceBackup
  const stale = days === null || days === undefined || days >= 7
  const label = days === null || days === undefined ? 'No backup yet' : days === 0 ? 'Backed up today' : `Backup ${days}d ago`
  return (
    <Tip content={data?.lastBackupFile ? `Last backup: ${data.lastBackupFile}` : 'Create a backup from the Backup / Restore page'}>
      <button
        type="button"
        onClick={() => navigate('/backup')}
        className={cn(
          'flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
          stale ? 'border-racing/30 bg-racing-50 text-racing' : 'border-silver bg-white text-ink-muted'
        )}
      >
        {stale ? <DatabaseBackup className="size-3.5" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
        {label}
      </button>
    </Tip>
  )
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [quick, setQuick] = useState<{ kind: QuickKind; customerId?: number | null } | null>(null)
  const { data: info } = useAppInfo()
  const { date } = useFormat()
  const navigate = useNavigate()
  const open = useCallback((kind: QuickKind, options?: { customerId?: number | null }) => setQuick({ kind, customerId: options?.customerId ?? null }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const map: Record<string, QuickKind> = { r: 'receipt', p: 'payout', u: 'usage', e: 'expense', n: 'customer' }
      const kind = map[e.key.toLowerCase()]
      if (kind) {
        e.preventDefault()
        open(kind)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <QuickActionContext.Provider value={{ open }}>
      <div className="flex h-full">
        <aside className="flex w-60 shrink-0 flex-col bg-charcoal text-white" aria-label="Main navigation">
          <div className="flex items-center gap-2.5 px-4 py-4">
            <div className="flex size-9 items-center justify-center rounded-md bg-racing font-bold tracking-tight">₹</div>
            <div className="leading-tight">
              <p className="text-sm font-semibold">Customer Money</p>
              <p className="text-xs text-silver">Manager</p>
            </div>
          </div>
          <nav className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center gap-3 rounded-md border-l-[3px] px-3 py-2 text-sm transition-colors',
                    isActive ? 'border-racing bg-charcoal-700 font-semibold text-white' : 'border-transparent text-silver hover:bg-charcoal-800 hover:text-white'
                  )
                }
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-charcoal-600 px-4 py-3 text-[11px] leading-relaxed text-silver">
            <p className="flex items-center gap-1.5">
              <ShieldCheck className="size-3.5" aria-hidden /> Offline · data stays on this computer
            </p>
            <p className="mt-0.5 opacity-70">
              v{info?.appVersion ?? '—'} · schema {info?.schemaVersion ?? '—'}
            </p>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {info?.demoMode && (
            <div className="bg-racing px-4 py-1 text-center text-xs font-semibold uppercase tracking-wider text-white" role="status">
              Demo environment — synthetic data in a separate demo database
            </div>
          )}
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-silver-200 bg-white px-4">
            <div className="flex items-center gap-1.5 whitespace-nowrap text-sm text-ink-muted">
              <CalendarDays className="size-4" aria-hidden />
              <span>{info ? date(info.today) : ''}</span>
            </div>
            <div className="flex flex-1 justify-center">
              <GlobalSearch />
            </div>
            <BackupChip />
            <Notifications />
            <Menu>
              <MenuTrigger asChild>
                <Button variant="primary" size="md" aria-label="Quick transaction">
                  <Plus /> New
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => open('receipt')} shortcut="Alt+R">
                  <ArrowDownLeft /> Money received
                </MenuItem>
                <MenuItem onSelect={() => open('payout')} shortcut="Alt+P">
                  <ArrowUpRight /> Money paid to customer
                </MenuItem>
                <MenuItem onSelect={() => open('usage')} shortcut="Alt+U">
                  <Timer /> Daily usage
                </MenuItem>
                <MenuItem onSelect={() => open('expense')} shortcut="Alt+E">
                  <Receipt /> Business expense
                </MenuItem>
                <MenuItem onSelect={() => open('adjustment')}>
                  <Scale /> Credit / debit adjustment
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => open('customer')} shortcut="Alt+N">
                  <UserPlus /> Register customer
                </MenuItem>
              </MenuContent>
            </Menu>
            <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => navigate('/settings')}>
              <Settings />
            </Button>
          </header>
          <main className="scrollbar-thin min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-5">{children ?? <Outlet />}</main>
        </div>
      </div>
      <QuickActionDialogs state={quick} onClose={() => setQuick(null)} />
    </QuickActionContext.Provider>
  )
}
