import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { MoneyText, BalanceBadge } from '@/components/domain'
import { ReceiptForm } from '@/components/forms/money-forms'
import { lineCharge, emptyLine } from '@/components/forms/usage-form'
import { LedgerTable } from '@/components/txn-dialogs'
import { TooltipProvider } from '@/components/ui/overlay'
import type { LedgerRow } from '@shared/types'

const settings = {
  businessName: '',
  currency: { code: 'INR', locale: 'en-IN', minorDigits: 2 },
  currencyLocked: false,
  dateFormat: 'dd MMM yyyy',
  operatorName: '',
  payoutOverdraftPolicy: 'REQUIRE_OVERRIDE',
  backupFolder: null,
  autoBackupEnabled: false,
  autoBackupKeep: 14,
  lastBackupAt: null,
  lastBackupFile: null,
  balanceConvention: 'credit-positive-v1'
}
const lookups = {
  payment_methods: [{ id: 1, name: 'Cash', isActive: true, sortOrder: 0 }],
  transaction_categories: [],
  usage_categories: [{ id: 1, name: 'Service', isActive: true, sortOrder: 0 }],
  usage_units: [],
  expense_categories: []
}

let calls: Array<{ channel: string; payload: unknown }> = []
function installBridge(overrides: Record<string, (payload: unknown) => unknown> = {}) {
  calls = []
  const handlers: Record<string, (payload: unknown) => unknown> = {
    'settings:get': () => settings,
    'lookups:list': () => lookups,
    'app:info': () => ({ today: '2026-10-15', appVersion: 'test', schemaVersion: 1 }),
    'customers:search': () => [],
    ...overrides
  }
  const bridge: Record<string, Record<string, (p?: unknown) => Promise<unknown>>> = {}
  for (const channel of Object.keys(handlers)) {
    const [ns, m] = channel.split(':')
    bridge[ns] ??= {}
    bridge[ns][m] = async (payload?: unknown) => {
      calls.push({ channel, payload })
      return { ok: true, data: handlers[channel](payload) }
    }
  }
  ;(window as unknown as { cmm: unknown }).cmm = bridge
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>
  )
}

beforeEach(() => installBridge())

describe('money display', () => {
  it('formats minor units with the configured currency and balance tone', async () => {
    wrap(
      <div>
        <MoneyText minor={125050} />
        <MoneyText minor={-40000} tone="balance" />
        <MoneyText minor={null} />
      </div>
    )
    expect(await screen.findByText('₹1,250.50')).toBeInTheDocument()
    expect(screen.getByText('-₹400.00')).toHaveClass('text-due')
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('labels balances in words, not only by color', () => {
    const { rerender } = wrap(<BalanceBadge minor={100} />)
    expect(screen.getByText('Credit')).toBeInTheDocument()
    rerender(<BalanceBadge minor={-1} />)
    expect(screen.getByText('Amount due')).toBeInTheDocument()
    rerender(<BalanceBadge minor={0} />)
    expect(screen.getByText('Settled')).toBeInTheDocument()
  })
})

describe('receipt form validation', () => {
  it('shows inline errors and does not call the database when fields are invalid', async () => {
    const user = userEvent.setup()
    wrap(<ReceiptForm />)
    await user.click(await screen.findByRole('button', { name: /review receipt/i }))
    expect(await screen.findByText('Select a customer')).toBeInTheDocument()
    expect(screen.getByText('Enter an amount')).toBeInTheDocument()
    expect(screen.getByText('Choose a payment method')).toBeInTheDocument()
    await user.type(screen.getByLabelText(/amount received/i), '12.345')
    await user.click(screen.getByRole('button', { name: /review receipt/i }))
    expect(await screen.findByText('Use at most 2 decimal places')).toBeInTheDocument()
    expect(calls.some((c) => c.channel === 'ledger:recordReceipt')).toBe(false)
  })

  it('submits integer minor units with an idempotency key only after confirmation', async () => {
    const user = userEvent.setup()
    const record = vi.fn((_payload: unknown) => ({ id: 1, reference: "RCP-000001", duplicateRequest: false }))
    installBridge({
      'customers:get': () => ({ id: 7, name: 'ABC Traders', customerCode: 'CUST-000007', balanceMinor: 0 }),
      'ledger:recordReceipt': record
    })
    wrap(<ReceiptForm defaultCustomerId={7} />)
    await screen.findByText('ABC Traders')
    await user.type(screen.getByLabelText(/amount received/i), '1,250.50')
    await user.selectOptions(screen.getByLabelText(/payment method/i), '1')
    await user.click(screen.getByRole('button', { name: /review receipt/i }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getAllByText('₹1,250.50')).toHaveLength(2) // amount and balance after
    expect(record).not.toHaveBeenCalled()
    await user.click(within(dialog).getByRole('button', { name: /save receipt/i }))
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1))
    const payload = record.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ customerId: 7, amountMinor: 125050, paymentMethodId: 1, date: '2026-10-15' })
    expect(payload.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('usage calculator', () => {
  it('computes quantity × rate + fees − discount exactly', () => {
    expect(lineCharge({ ...emptyLine('1'), quantity: '10', rate: '100' }, 2)).toMatchObject({ charge: 100000, base: 100000 })
    expect(lineCharge({ ...emptyLine('1'), quantity: '2.5', rate: '199.99', fees: '1', discount: '0.50' }, 2)).toMatchObject({ charge: 50048 })
    expect(lineCharge({ ...emptyLine('1'), method: 'FIXED', fixedAmount: '250' }, 2)).toMatchObject({ charge: 25000 })
    expect(lineCharge({ ...emptyLine('1'), method: 'FIXED', fixedAmount: '10', discount: '20' }, 2).error).toMatch(/Discount cannot exceed/)
  })
})

describe('ledger table', () => {
  it('shows separate received/paid/usage columns and the running balance', async () => {
    const base: Omit<LedgerRow, 'id' | 'type' | 'amountMinor' | 'balanceEffectMinor' | 'runningBalanceMinor' | 'reference'> = {
      externalRef: null,
      customerId: 1,
      customerCode: 'CUST-000001',
      customerName: 'ABC',
      txnDate: '2026-10-15',
      paymentMethod: 'Cash',
      paymentMethodId: 1,
      category: null,
      categoryId: null,
      description: 'x',
      paymentReference: null,
      notes: null,
      reason: null,
      overrideReason: null,
      isReversal: false,
      reversesTxnId: null,
      reversesReference: null,
      reversedByTxnId: null,
      reversedByReference: null,
      relatedTxnId: null,
      relatedReference: null,
      usageEntryId: null,
      source: 'MANUAL',
      createdAt: '2026-10-15T10:00:00Z',
      createdBy: null
    }
    const rows: LedgerRow[] = [
      { ...base, id: 1, reference: 'RCP-000001', type: 'RECEIPT', amountMinor: 1_000_000, balanceEffectMinor: 1_000_000, runningBalanceMinor: 1_000_000 },
      { ...base, id: 2, reference: 'USG-000001', type: 'USAGE', amountMinor: 200_000, balanceEffectMinor: -200_000, runningBalanceMinor: 800_000 },
      { ...base, id: 3, reference: 'PAY-000001', type: 'PAYOUT', amountMinor: 150_000, balanceEffectMinor: -150_000, runningBalanceMinor: 650_000 }
    ]
    const onOpen = vi.fn()
    wrap(<LedgerTable rows={rows} onOpen={onOpen} />)
    expect(await screen.findByText('₹6,500.00')).toHaveClass('text-credit')
    expect(screen.getByText('₹2,000.00')).toBeInTheDocument()
    await userEvent.setup().click(screen.getByText('PAY-000001'))
    expect(onOpen).toHaveBeenCalledWith(3)
  })
})
