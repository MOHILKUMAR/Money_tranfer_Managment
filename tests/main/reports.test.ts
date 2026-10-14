import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPORT_KINDS } from '../../src/shared/schemas'
import { parseCsv } from '../../src/shared/csv'
import { buildReport, reportToCsv, reportToHtml } from '../../src/main/services/reports'
import { recordPayout, recordReceipt, recordAdjustment } from '../../src/main/services/ledger'
import { recordUsageBatch } from '../../src/main/services/usage'
import { recordExpense } from '../../src/main/services/expenses'
import { getCurrency } from '../../src/main/services/settings'
import { addCustomer, createTestEnv, key, lookupId, type TestEnv } from './helpers'

let env: TestEnv
let customerId: number
beforeEach(() => {
  env = createTestEnv()
  customerId = addCustomer(env, 'Report Co', { amountMinor: 50_000, date: '2026-09-01' })
  const cash = lookupId(env.lookups, 'payment_methods', 'Cash')
  recordReceipt(env.ctx, { customerId, date: '2026-10-01', amountMinor: 100_000, paymentMethodId: cash, idempotencyKey: key() })
  recordUsageBatch(env.ctx, {
    customerId,
    usageDate: '2026-10-02',
    idempotencyKey: key(),
    lines: [{ categoryId: lookupId(env.lookups, 'usage_categories', 'Service'), description: 'Work', method: 'QUANTITY', quantityMilli: 3_000, rateMinor: 20_000 }]
  })
  recordPayout(env.ctx, { customerId, date: '2026-10-03', amountMinor: 15_000, paymentMethodId: cash, reason: 'Refund', idempotencyKey: key() })
  recordAdjustment(env.ctx, { customerId, direction: 'DEBIT', date: '2026-10-04', amountMinor: 1_000, reason: 'Late fee', idempotencyKey: key() })
  recordExpense(env.ctx, { date: '2026-10-05', categoryId: lookupId(env.lookups, 'expense_categories', 'Rent'), description: 'Rent', amountMinor: 70_000, paymentMethodId: cash, idempotencyKey: key() })
})
afterEach(() => env.cleanup())

describe('reports', () => {
  it('builds every report kind with headers, rows and generation metadata', () => {
    for (const kind of REPORT_KINDS) {
      const report = buildReport(env.ctx, { kind, from: '2026-10-01', to: '2026-10-31', customerId })
      expect(report.columns.length).toBeGreaterThan(0)
      expect(report.generatedAt).toBe(env.clock.now.toISOString())
      expect(report.dateBasis).toBeTruthy()
      const csv = reportToCsv(report, getCurrency(env.ctx))
      const parsed = parseCsv(csv)
      expect(parsed.headers.length).toBe(report.columns.length)
      expect(parsed.rows.length).toBe(report.rows.length)
      const html = reportToHtml(report, { currency: getCurrency(env.ctx), dateFormat: 'dd MMM yyyy', businessName: 'Biz' })
      expect(html).toContain(report.title)
      expect(html).not.toMatch(/<script/i)
    }
  })

  it('customer statement shows brought-forward balance, exact running balances and closing balance', () => {
    const r = buildReport(env.ctx, { kind: 'customer_statement', customerId, from: '2026-10-01', to: '2026-10-31' })
    expect(r.rows[0]).toMatchObject({ type: 'Balance brought forward', balance: 50_000 })
    expect(r.rows.slice(1).map((x) => x.balance)).toEqual([150_000, 90_000, 75_000, 74_000])
    expect(r.totals).toMatchObject({ received: 100_000, paid: 15_000, usage: 60_000, balance: 74_000 })
    const csv = parseCsv(reportToCsv(r, getCurrency(env.ctx)))
    expect(csv.headers).toContain('Running Balance (INR)')
    expect(csv.rows.at(-1)?.[csv.headers.indexOf('Running Balance (INR)')]).toBe('740.00')
  })

  it('daily cashbook includes receipts, payouts and expenses but not usage or adjustments', () => {
    const r = buildReport(env.ctx, { kind: 'daily_cashbook', from: '2026-10-01', to: '2026-10-31' })
    expect(r.rows.map((x) => x.kind)).toEqual(['Money received', 'Paid to customer', 'Business expense'])
    expect(r.totals).toMatchObject({ cashIn: 100_000, cashOut: 85_000, net: 15_000 })
  })

  it('monthly summary and balance statement agree with the ledger', () => {
    const m = buildReport(env.ctx, { kind: 'monthly_summary', from: '2026-09-01', to: '2026-10-31' })
    expect(m.rows.map((x) => x.period)).toEqual(['Sep 2026', 'Oct 2026'])
    expect(m.rows[1]).toMatchObject({ received: 100_000, paid: 15_000, expenses: 70_000, net: 15_000, usage: 60_000, debitAdj: 1_000 })
    const b = buildReport(env.ctx, { kind: 'customer_balances', asOf: '2026-10-02' })
    expect(b.rows[0]).toMatchObject({ balance: 90_000, credit: 90_000, due: 0, balanceStatus: 'CREDIT' })
  })
})
