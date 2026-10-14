import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addCustomer, createTestEnv, key, lookupId, type TestEnv } from './helpers'
import {
  createCustomer,
  getCustomer,
  listCustomers,
  setCustomerStatus,
  updateCustomer
} from '../../src/main/services/customers'
import {
  getTransactionDetail,
  listLedger,
  previewPayout,
  recordAdjustment,
  recordPayout,
  recordReceipt,
  reverseTransaction,
  updateTransactionNotes
} from '../../src/main/services/ledger'
import { correctUsage, listUsage, recordUsageBatch, usageSummary } from '../../src/main/services/usage'
import { expenseSummary, recordExpense, reverseExpense } from '../../src/main/services/expenses'
import { getDashboard } from '../../src/main/services/analytics'
import { updateSettings } from '../../src/main/services/settings'
import { customerBalance } from '../../src/main/services/ledger-core'
import { AppError } from '../../src/shared/errors'

let env: TestEnv
beforeEach(() => {
  env = createTestEnv()
})
afterEach(() => env.cleanup())

const cash = () => lookupId(env.lookups, 'payment_methods', 'Cash')
const upi = () => lookupId(env.lookups, 'payment_methods', 'UPI')
const service = () => lookupId(env.lookups, 'usage_categories', 'Service')
const hours = () => lookupId(env.lookups, 'usage_units', 'hours')

function receipt(customerId: number, amountMinor: number, date = '2026-10-15') {
  return recordReceipt(env.ctx, { customerId, date, amountMinor, paymentMethodId: cash(), idempotencyKey: key() })
}
function usageFixed(customerId: number, amountMinor: number, date = '2026-10-15') {
  return recordUsageBatch(env.ctx, {
    customerId,
    usageDate: date,
    idempotencyKey: key(),
    lines: [{ categoryId: service(), description: 'Usage', method: 'FIXED', fixedAmountMinor: amountMinor, fixedReason: 'Flat' }]
  })
}

function expectAppError(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
    return error as AppError
  }
  throw new Error(`Expected AppError ${code}`)
}

describe('customer registration', () => {
  it('generates unique sequential customer codes and an opening-balance ledger entry', () => {
    const a = createCustomer(env.ctx, {
      name: 'ABC Traders',
      registrationDate: '2026-10-01',
      openingBalance: { amountMinor: 100_000, date: '2026-10-01', explanation: 'Carried forward' },
      idempotencyKey: key()
    })
    const b = createCustomer(env.ctx, { name: 'XYZ Stores', registrationDate: '2026-10-02', idempotencyKey: key() })
    expect(a.customerCode).toBe('CUST-000001')
    expect(b.customerCode).toBe('CUST-000002')
    expect(a.openingTxnReference).toBe('OPN-000001')
    expect(getCustomer(env.ctx, a.id).balanceMinor).toBe(100_000)
    expect(getCustomer(env.ctx, a.id).openingMinor).toBe(100_000)
    expect(getCustomer(env.ctx, b.id).balanceMinor).toBe(0)
  })

  it('supports a negative (amount due) opening balance', () => {
    const id = addCustomer(env, 'Owes Money', { amountMinor: -25_000 })
    const c = getCustomer(env.ctx, id)
    expect(c.balanceMinor).toBe(-25_000)
    expect(c.balanceStatus).toBe('DUE')
    expect(c.outstandingMinor).toBe(25_000)
  })

  it('flags possible duplicates by name or phone but never merges', () => {
    addCustomer(env, 'Ravi Kumar', undefined, { phone: '+91 98765 43210' })
    const error = expectAppError(
      () => createCustomer(env.ctx, { name: 'R. Kumar', phone: '9876543210', registrationDate: '2026-10-01', idempotencyKey: key() }),
      'POSSIBLE_DUPLICATE'
    )
    expect((error.details as { matches: unknown[] }).matches).toHaveLength(1)
    const confirmed = createCustomer(env.ctx, {
      name: 'R. Kumar',
      phone: '9876543210',
      registrationDate: '2026-10-01',
      idempotencyKey: key(),
      confirmPossibleDuplicate: true
    })
    expect(confirmed.customerCode).toBe('CUST-000002')
    expect(listCustomers(env.ctx).total).toBe(2)
  })

  it('is idempotent for repeated submissions with the same key', () => {
    const idem = key()
    const first = createCustomer(env.ctx, { name: 'Once', registrationDate: '2026-10-01', idempotencyKey: idem })
    const second = createCustomer(env.ctx, { name: 'Once', registrationDate: '2026-10-01', idempotencyKey: idem })
    expect(second.id).toBe(first.id)
    expect(second.duplicateRequest).toBe(true)
    expect(listCustomers(env.ctx).total).toBe(1)
  })

  it('updates profile fields with an audit trail and toggles status', () => {
    const id = addCustomer(env, 'Old Name')
    updateCustomer(env.ctx, { id, name: 'New Name', registrationDate: '2026-10-01', email: 'a@b.co', reason: 'Typo' })
    const c = setCustomerStatus(env.ctx, { id, status: 'INACTIVE' })
    expect(c.name).toBe('New Name')
    expect(c.status).toBe('INACTIVE')
    const audit = env.db.prepare("SELECT action FROM audit_logs WHERE entity_type = 'customer' AND entity_id = ?").all(String(id))
    expect(audit.map((a) => (a as { action: string }).action)).toEqual(['CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_DEACTIVATED'])
  })

  it('lists, searches, filters and sorts customers with derived totals', () => {
    const a = addCustomer(env, 'Alpha', { amountMinor: 5_000 })
    const b = addCustomer(env, 'Beta', undefined, { phone: '99887 76655' })
    addCustomer(env, 'Gamma')
    usageFixed(b, 10_000)
    receipt(a, 20_000)
    setCustomerStatus(env.ctx, { id: a, status: 'INACTIVE' })
    expect(listCustomers(env.ctx, { search: 'bet' }).rows.map((r) => r.name)).toEqual(['Beta'])
    expect(listCustomers(env.ctx, { search: '7766' }).rows.map((r) => r.name)).toEqual(['Beta'])
    expect(listCustomers(env.ctx, { status: 'ACTIVE' }).total).toBe(2)
    expect(listCustomers(env.ctx, { balanceFilter: 'DUE' }).rows.map((r) => r.name)).toEqual(['Beta'])
    const byBalance = listCustomers(env.ctx, { sortBy: 'balance', sortDir: 'desc' }).rows
    expect(byBalance.map((r) => [r.name, r.balanceMinor])).toEqual([
      ['Alpha', 25_000],
      ['Gamma', 0],
      ['Beta', -10_000]
    ])
    const list = listCustomers(env.ctx)
    expect(list.totals.creditMinor).toBe(25_000)
    expect(list.totals.dueMinor).toBe(10_000)
    const alpha = list.rows.find((r) => r.id === a)!
    expect(alpha.receivedMinor).toBe(20_000)
    expect(alpha.lastTxnDate).toBe('2026-10-15')
  })
})

describe('receipts, payouts and balances', () => {
  it('reproduces the specification example: 10,000 received − 2,000 usage − 1,500 paid = 6,500 credit', () => {
    const id = addCustomer(env, 'Example Co')
    receipt(id, 1_000_000)
    usageFixed(id, 200_000)
    recordPayout(env.ctx, {
      customerId: id,
      date: '2026-10-15',
      amountMinor: 150_000,
      paymentMethodId: upi(),
      reason: 'Return of unused advance',
      idempotencyKey: key()
    })
    const c = getCustomer(env.ctx, id)
    expect(c.balanceMinor).toBe(650_000)
    expect(c.receivedMinor).toBe(1_000_000)
    expect(c.paidMinor).toBe(150_000)
    expect(c.usageMinor).toBe(200_000)
    expect(c.balanceStatus).toBe('CREDIT')
  })

  it('reproduces the specification example: 1,000 credit + 1,400 usage = −400 due', () => {
    const id = addCustomer(env, 'Due Co', { amountMinor: 100_000 })
    usageFixed(id, 140_000)
    expect(getCustomer(env.ctx, id).balanceMinor).toBe(-40_000)
  })

  it('handles multiple receipts and payouts', () => {
    const id = addCustomer(env, 'Multi')
    receipt(id, 10_000)
    receipt(id, 20_000)
    receipt(id, 30_000)
    for (const amount of [5_000, 7_000]) {
      recordPayout(env.ctx, { customerId: id, date: '2026-10-15', amountMinor: amount, paymentMethodId: cash(), reason: 'Refund', idempotencyKey: key() })
    }
    expect(getCustomer(env.ctx, id).balanceMinor).toBe(48_000)
  })

  it('duplicate submission with the same idempotency key records once', () => {
    const id = addCustomer(env, 'Dup')
    const idem = key()
    const input = { customerId: id, date: '2026-10-15', amountMinor: 50_000, paymentMethodId: cash(), idempotencyKey: idem }
    const a = recordReceipt(env.ctx, input)
    const b = recordReceipt(env.ctx, input)
    expect(b.id).toBe(a.id)
    expect(b.duplicateRequest).toBe(true)
    expect(customerBalance(env.ctx, id)).toBe(50_000)
  })

  it('blocks or requires an override when a payout exceeds available credit', () => {
    const id = addCustomer(env, 'Short', { amountMinor: 10_000 })
    const payout = (override?: { confirmed: true; reason: string }) =>
      recordPayout(env.ctx, {
        customerId: id,
        date: '2026-10-15',
        amountMinor: 15_000,
        paymentMethodId: cash(),
        reason: 'Refund',
        override: override ?? null,
        idempotencyKey: key()
      })
    const err = expectAppError(() => payout(), 'OVERRIDE_REQUIRED')
    expect(err.details).toMatchObject({ availableMinor: 10_000, shortfallMinor: 5_000 })
    expect(previewPayout(env.ctx, { customerId: id, amountMinor: 15_000 })).toMatchObject({
      exceedsCredit: true,
      shortfallMinor: 5_000,
      balanceAfterMinor: -5_000
    })
    updateSettings(env.ctx, { payoutOverdraftPolicy: 'BLOCK' })
    expectAppError(() => payout({ confirmed: true, reason: 'Manager approved' }), 'INSUFFICIENT_CREDIT')
    updateSettings(env.ctx, { payoutOverdraftPolicy: 'REQUIRE_OVERRIDE' })
    const ok = payout({ confirmed: true, reason: 'Manager approved' })
    expect(getTransactionDetail(env.ctx, ok.id).overrideReason).toBe('Manager approved')
    expect(customerBalance(env.ctx, id)).toBe(-5_000)
  })

  it('links refunds to receipts and prevents refunding more than received', () => {
    const id = addCustomer(env, 'Refunds', { amountMinor: 100_000 })
    const r = receipt(id, 30_000)
    const refund = (amountMinor: number) =>
      recordPayout(env.ctx, {
        customerId: id,
        date: '2026-10-15',
        amountMinor,
        paymentMethodId: cash(),
        reason: 'Refund',
        relatedTxnId: r.id,
        idempotencyKey: key()
      })
    refund(20_000)
    expectAppError(() => refund(15_000), 'REFUND_EXCEEDS_RECEIPT')
    refund(10_000)
    expectAppError(() => refund(1), 'REFUND_EXCEEDS_RECEIPT')
    const detail = getTransactionDetail(env.ctx, r.id)
    expect(detail.linkedPayouts).toHaveLength(2)
    expect(detail.canReverse).toBe(false)
  })

  it('rejects receipts for unknown customers and invalid amounts', () => {
    expectAppError(() => receipt(999, 100), 'NOT_FOUND')
    const id = addCustomer(env, 'V')
    expect(() => receipt(id, -100)).toThrow()
    expect(() => receipt(id, 1.5)).toThrow()
    expect(() => recordReceipt(env.ctx, { customerId: id, date: '2026-13-01', amountMinor: 100, paymentMethodId: cash(), idempotencyKey: key() })).toThrow()
  })

  it('rolls back atomically when a write fails mid-transaction', () => {
    const id = addCustomer(env, 'Atomic')
    const before = env.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
    const seqBefore = env.db.prepare("SELECT next_value FROM sequences WHERE name = 'RCP'").get() as { next_value: number }
    // An inactive payment method fails after the idempotency check but inside the transaction.
    env.db.prepare('UPDATE payment_methods SET is_active = 0 WHERE id = ?').run(cash())
    expectAppError(() => receipt(id, 100), 'VALIDATION')
    const after = env.db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }
    const seqAfter = env.db.prepare("SELECT next_value FROM sequences WHERE name = 'RCP'").get() as { next_value: number }
    expect(after.n).toBe(before.n)
    expect(seqAfter.next_value).toBe(seqBefore.next_value)
  })

  it('applies credit and debit adjustments', () => {
    const id = addCustomer(env, 'Adj', { amountMinor: 10_000 })
    recordAdjustment(env.ctx, { customerId: id, direction: 'CREDIT', date: '2026-10-15', amountMinor: 2_500, reason: 'Goodwill', idempotencyKey: key() })
    recordAdjustment(env.ctx, { customerId: id, direction: 'DEBIT', date: '2026-10-15', amountMinor: 1_000, reason: 'Late fee', idempotencyKey: key() })
    const c = getCustomer(env.ctx, id)
    expect(c.balanceMinor).toBe(11_500)
    expect(c.creditAdjustmentsMinor).toBe(2_500)
    expect(c.debitAdjustmentsMinor).toBe(1_000)
  })
})

describe('reversals and immutability', () => {
  it('reverses a receipt with an offsetting row and keeps the original', () => {
    const id = addCustomer(env, 'Rev')
    const r = receipt(id, 40_000, '2026-10-10')
    const rev = reverseTransaction(env.ctx, { txnId: r.id, reason: 'Wrong customer', idempotencyKey: key() })
    expect(rev.reference).toMatch(/^REV-/)
    expect(customerBalance(env.ctx, id)).toBe(0)
    const ledger = listLedger(env.ctx, { customerId: id })
    expect(ledger.rows.map((row) => row.amountMinor)).toEqual([40_000, -40_000])
    expect(ledger.rows[1].txnDate).toBe('2026-10-10')
    expect(ledger.totals.receivedMinor).toBe(0)
    expectAppError(() => reverseTransaction(env.ctx, { txnId: r.id, reason: 'Again', idempotencyKey: key() }), 'ALREADY_REVERSED')
    expectAppError(() => reverseTransaction(env.ctx, { txnId: rev.id, reason: 'Undo', idempotencyKey: key() }), 'VALIDATION')
  })

  it('database triggers forbid editing or deleting posted ledger rows', () => {
    const id = addCustomer(env, 'Locked')
    const r = receipt(id, 1_000)
    expect(() => env.db.prepare('UPDATE transactions SET amount_minor = 5 WHERE id = ?').run(r.id)).toThrow(/cannot be changed/)
    expect(() => env.db.prepare('DELETE FROM transactions WHERE id = ?').run(r.id)).toThrow(/cannot be deleted/)
    expect(() => env.db.prepare('DELETE FROM audit_logs').run()).toThrow(/append-only/)
    // Notes remain editable with an audit entry.
    const updated = updateTransactionNotes(env.ctx, { txnId: r.id, description: 'Cash advance', notes: 'Counted twice', reason: 'Clarify' })
    expect(updated.notes).toBe('Counted twice')
  })

  it('database rejects a reversal that does not mirror the original', () => {
    const id = addCustomer(env, 'Bad rev')
    const r = receipt(id, 1_000)
    expect(() =>
      env.db
        .prepare(
          `INSERT INTO transactions (reference, customer_id, type, txn_date, amount_minor, currency, payment_method_id, description, reverses_txn_id, reason, created_at)
           VALUES ('X-1', ?, 'RECEIPT', '2026-10-15', -999, 'INR', ?, 'bad', ?, 'x', 'now')`
        )
        .run(id, cash(), r.id)
    ).toThrow(/Invalid reversal/)
  })

  it('foreign keys are enforced', () => {
    expect(() =>
      env.db
        .prepare(
          `INSERT INTO transactions (reference, customer_id, type, txn_date, amount_minor, currency, description, created_at)
           VALUES ('X-2', 9999, 'CREDIT_ADJUSTMENT', '2026-10-15', 100, 'INR', 'x', 'now')`
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
  })
})

describe('daily usage', () => {
  it('records the specification example: three lines totalling 1,850 on one date', () => {
    const id = addCustomer(env, 'ABC Traders')
    const units = lookupId(env.lookups, 'usage_units', 'units')
    const result = recordUsageBatch(env.ctx, {
      customerId: id,
      usageDate: '2026-10-15',
      idempotencyKey: key(),
      lines: [
        { categoryId: service(), description: 'Service A', method: 'QUANTITY', quantityMilli: 10_000, unitId: units, rateMinor: 10_000 },
        { categoryId: service(), description: 'Service B', method: 'QUANTITY', quantityMilli: 3_000, unitId: hours(), rateMinor: 20_000 },
        { categoryId: service(), description: 'Additional usage', method: 'FIXED', fixedAmountMinor: 25_000, fixedReason: 'Extra' }
      ]
    })
    expect(result.entries.map((e) => e.chargeMinor)).toEqual([100_000, 60_000, 25_000])
    expect(result.totalMinor).toBe(185_000)
    expect(getCustomer(env.ctx, id).usageMinor).toBe(185_000)
    const summary = usageSummary(env.ctx, { from: '2026-10-15', to: '2026-10-15' })
    expect(summary.todayTotalMinor).toBe(185_000)
    expect(summary.byCustomer[0]).toMatchObject({ name: 'ABC Traders', amountMinor: 185_000 })
  })

  it('posts each usage entry to the ledger exactly once', () => {
    const id = addCustomer(env, 'Once')
    const r = usageFixed(id, 5_000)
    const entryId = r.entries[0].id
    const postings = env.db
      .prepare('SELECT COUNT(*) AS n FROM transactions WHERE usage_entry_id = ? AND reverses_txn_id IS NULL')
      .get(entryId) as { n: number }
    expect(postings.n).toBe(1)
    expect(() =>
      env.db
        .prepare(
          `INSERT INTO transactions (reference, customer_id, type, txn_date, amount_minor, currency, usage_entry_id, description, created_at)
           VALUES ('X-3', ?, 'USAGE', '2026-10-15', 5000, 'INR', ?, 'dup', 'now')`
        )
        .run(id, entryId)
    ).toThrow(/UNIQUE/)
  })

  it('validates usage lines and rejects inactive customers', () => {
    const id = addCustomer(env, 'Inactive soon')
    expect(() =>
      recordUsageBatch(env.ctx, {
        customerId: id,
        usageDate: '2026-10-15',
        idempotencyKey: key(),
        lines: [{ categoryId: service(), description: 'X', method: 'FIXED', fixedAmountMinor: 100, discountMinor: 50 }]
      })
    ).toThrow()
    setCustomerStatus(env.ctx, { id, status: 'INACTIVE' })
    expectAppError(() => usageFixed(id, 100), 'VALIDATION')
  })

  it('corrects usage by reversal plus replacement and keeps an audit trail', () => {
    const id = addCustomer(env, 'Correct me', { amountMinor: 100_000 })
    const r = usageFixed(id, 30_000, '2026-10-14')
    const correction = correctUsage(env.ctx, {
      entryId: r.entries[0].id,
      reason: 'Wrong amount entered',
      idempotencyKey: key(),
      replacement: {
        usageDate: '2026-10-14',
        line: { categoryId: service(), description: 'Usage (fixed)', method: 'FIXED', fixedAmountMinor: 25_000, fixedReason: 'Corrected' }
      }
    })
    expect(correction.replacement?.chargeMinor).toBe(25_000)
    expect(getCustomer(env.ctx, id).balanceMinor).toBe(75_000)
    const entries = listUsage(env.ctx, { customerId: id })
    expect(entries.rows.map((e) => e.status).sort()).toEqual(['POSTED', 'REVERSED'])
    expect(entries.totalMinor).toBe(25_000)
    expect(usageSummary(env.ctx, { from: '2026-10-14', to: '2026-10-14' }).periodTotalMinor).toBe(25_000)
    expectAppError(
      () => correctUsage(env.ctx, { entryId: r.entries[0].id, reason: 'again', idempotencyKey: key() }),
      'ALREADY_REVERSED'
    )
    const audit = env.db.prepare("SELECT action, reason FROM audit_logs WHERE entity_type = 'usage_entry'").all() as Array<{
      action: string
      reason: string
    }>
    expect(audit).toEqual([{ action: 'USAGE_CORRECTED', reason: 'Wrong amount entered' }])
  })
})

describe('business expenses', () => {
  it('records and reverses expenses without touching customer balances', () => {
    const id = addCustomer(env, 'Unaffected', { amountMinor: 10_000 })
    const rent = lookupId(env.lookups, 'expense_categories', 'Rent')
    const e = recordExpense(env.ctx, {
      date: '2026-10-15',
      categoryId: rent,
      description: 'October rent',
      amountMinor: 2_000_000,
      paymentMethodId: cash(),
      idempotencyKey: key()
    })
    recordExpense(env.ctx, { date: '2026-10-14', categoryId: lookupId(env.lookups, 'expense_categories', 'Supplies'), description: 'Paper', amountMinor: 50_000, paymentMethodId: upi(), idempotencyKey: key() })
    expect(customerBalance(env.ctx, id)).toBe(10_000)
    let summary = expenseSummary(env.ctx, { from: '2026-10-01', to: '2026-10-31' })
    expect(summary.periodTotalMinor).toBe(2_050_000)
    expect(summary.todayMinor).toBe(2_000_000)
    expect(summary.byCategory[0]).toMatchObject({ name: 'Rent', amountMinor: 2_000_000 })
    expect(summary.byPaymentMethod.map((m) => m.name)).toEqual(['Cash', 'UPI'])
    reverseExpense(env.ctx, { expenseId: e.id, reason: 'Duplicate', idempotencyKey: key() })
    summary = expenseSummary(env.ctx, { from: '2026-10-01', to: '2026-10-31' })
    expect(summary.periodTotalMinor).toBe(50_000)
    expectAppError(() => reverseExpense(env.ctx, { expenseId: e.id, reason: 'Again', idempotencyKey: key() }), 'ALREADY_REVERSED')
  })
})

describe('ledger running balance and date-range totals', () => {
  it('computes chronological running balances and period opening/closing', () => {
    const id = addCustomer(env, 'Running', { amountMinor: 1_000, date: '2026-09-01' })
    receipt(id, 5_000, '2026-09-15')
    usageFixed(id, 2_000, '2026-10-02')
    receipt(id, 3_000, '2026-10-05')
    // Back-dated entry inserted last still sorts by date.
    usageFixed(id, 500, '2026-09-20')
    const all = listLedger(env.ctx, { customerId: id })
    expect(all.rows.map((r) => [r.txnDate, r.runningBalanceMinor])).toEqual([
      ['2026-09-01', 1_000],
      ['2026-09-15', 6_000],
      ['2026-09-20', 5_500],
      ['2026-10-02', 3_500],
      ['2026-10-05', 6_500]
    ])
    const october = listLedger(env.ctx, { customerId: id, from: '2026-10-01', to: '2026-10-31' })
    expect(october.periodOpeningMinor).toBe(5_500)
    expect(october.periodClosingMinor).toBe(6_500)
    expect(october.rows.map((r) => r.runningBalanceMinor)).toEqual([3_500, 6_500])
    expect(october.totals).toMatchObject({ receivedMinor: 3_000, usageMinor: 2_000 })
    // Type filter keeps true running balances.
    const receiptsOnly = listLedger(env.ctx, { customerId: id, types: ['RECEIPT'] })
    expect(receiptsOnly.rows.map((r) => r.runningBalanceMinor)).toEqual([6_000, 6_500])
  })

  it('dashboard KPIs separate receipts, payouts, usage and expenses', () => {
    const a = addCustomer(env, 'A', { amountMinor: 50_000 })
    const b = addCustomer(env, 'B')
    receipt(a, 100_000)
    receipt(b, 20_000, '2026-10-01')
    usageFixed(b, 50_000)
    recordPayout(env.ctx, { customerId: a, date: '2026-10-15', amountMinor: 30_000, paymentMethodId: cash(), reason: 'Refund', idempotencyKey: key() })
    recordExpense(env.ctx, { date: '2026-10-15', categoryId: lookupId(env.lookups, 'expense_categories', 'Utilities'), description: 'Power', amountMinor: 10_000, paymentMethodId: cash(), idempotencyKey: key() })
    const d = getDashboard(env.ctx, { from: '2026-10-01', to: '2026-10-31' })
    expect(d.customers).toEqual({ total: 2, active: 2, inactive: 0 })
    expect(d.todayKpis).toMatchObject({ receivedMinor: 100_000, paidMinor: 30_000, usageMinor: 50_000, expensesMinor: 10_000, netCashFlowMinor: 60_000 })
    expect(d.monthKpis).toMatchObject({ receivedMinor: 120_000, paidMinor: 30_000, netCashFlowMinor: 80_000 })
    expect(d.balances.creditOutstandingMinor).toBe(120_000)
    expect(d.balances.dueFromCustomersMinor).toBe(30_000)
    expect(d.cashFlowSeries).toHaveLength(31)
    expect(d.cashFlowSeries.find((s) => s.bucket === '2026-10-15')).toMatchObject({ receivedMinor: 100_000, paidMinor: 30_000, expensesMinor: 10_000 })
    expect(d.topCustomersByReceipts[0]).toMatchObject({ name: 'A', amountMinor: 100_000 })
    expect(d.balanceDistribution.reduce((s, b2) => s + b2.count, 0)).toBe(2)
    expect(d.transactionTypeBreakdown.find((t) => t.type === 'BUSINESS_EXPENSE')).toMatchObject({ count: 1, amountMinor: 10_000 })
    const yesterday = getDashboard(env.ctx, { from: '2026-10-14', to: '2026-10-14' })
    expect(yesterday.periodKpis.receivedMinor).toBe(0)
  })
})
