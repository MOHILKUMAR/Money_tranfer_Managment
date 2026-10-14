/**
 * Dashboard and analytics. Every figure is aggregated from persisted ledger
 * and expense rows, filtered by transaction date (the business date entered on
 * each record — not the time it was typed in).
 *
 * Definitions:
 *   Net recorded cash flow = receipts − customer payouts − business expenses
 *   Usage charges          = Σ posted USAGE rows (reversals net out)
 *   Customer credit        = Σ positive customer balances
 *   Due from customers     = Σ |negative customer balances|
 */
import { daysBetweenInclusive, eachDate, eachMonth, monthStartIso, trailingMonths } from '@shared/dates'
import { netCashFlow, TRANSACTION_TYPE_LABELS, TRANSACTION_TYPES, type TransactionType } from '@shared/finance'
import { dateRangeSchema } from '@shared/schemas'
import type { DashboardData, KpiSet } from '@shared/types'
import type { z } from 'zod'
import { today, type ServiceContext } from './context'
import { CUSTOMER_TOTALS_SQL } from './ledger-core'
import { listLedger } from './ledger'
import { getCurrency } from './settings'
import { sumExpenses } from './expenses'

export const DATE_BASIS = 'Transaction date (the business date recorded on each entry)'

export function kpisFor(ctx: ServiceContext, from: string, to: string): KpiSet {
  const rows = ctx.db
    .prepare(
      `SELECT type, COALESCE(SUM(amount_minor), 0) AS s, COUNT(*) AS n FROM transactions
       WHERE txn_date BETWEEN ? AND ? GROUP BY type`
    )
    .all(from, to) as Array<{ type: TransactionType; s: number; n: number }>
  const byType = new Map(rows.map((r) => [r.type, r]))
  const receivedMinor = byType.get('RECEIPT')?.s ?? 0
  const paidMinor = byType.get('PAYOUT')?.s ?? 0
  const expensesMinor = sumExpenses(ctx, from, to)
  const expenseCount = (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM business_expenses WHERE expense_date BETWEEN ? AND ?').get(from, to) as {
      n: number
    }
  ).n
  return {
    receivedMinor,
    paidMinor,
    usageMinor: byType.get('USAGE')?.s ?? 0,
    expensesMinor,
    netCashFlowMinor: netCashFlow({ receivedMinor, paidMinor, expensesMinor }),
    creditAdjustmentsMinor: byType.get('CREDIT_ADJUSTMENT')?.s ?? 0,
    debitAdjustmentsMinor: byType.get('DEBIT_ADJUSTMENT')?.s ?? 0,
    transactionCount: rows.reduce((sum, r) => sum + r.n, 0) + expenseCount
  }
}

function bucketOf(date: string, granularity: 'day' | 'month'): string {
  return granularity === 'day' ? date : date.slice(0, 7)
}

export function getDashboard(ctx: ServiceContext, raw: z.input<typeof dateRangeSchema>): DashboardData {
  const range = dateRangeSchema.parse(raw)
  const todayDate = today(ctx)
  const granularity: 'day' | 'month' = daysBetweenInclusive(range.from, range.to) <= 62 ? 'day' : 'month'
  const buckets = granularity === 'day' ? eachDate(range.from, range.to) : eachMonth(range.from, range.to)

  const customers = ctx.db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status = 'ACTIVE'), 0) AS active, COALESCE(SUM(status = 'INACTIVE'), 0) AS inactive FROM customers`
    )
    .get() as { total: number; active: number; inactive: number }

  const balances = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN a.balance_minor > 0 THEN a.balance_minor ELSE 0 END), 0) AS credit,
        COALESCE(SUM(CASE WHEN a.balance_minor < 0 THEN -a.balance_minor ELSE 0 END), 0) AS due,
        COALESCE(SUM(a.balance_minor > 0), 0) AS in_credit,
        COALESCE(SUM(a.balance_minor < 0), 0) AS with_due
       FROM customers c LEFT JOIN (${CUSTOMER_TOTALS_SQL}) a ON a.customer_id = c.id`
    )
    .get() as { credit: number; due: number; in_credit: number; with_due: number }

  // Cash flow and usage series
  const flowRows = ctx.db
    .prepare(
      `SELECT txn_date AS d, type, SUM(amount_minor) AS s FROM transactions
       WHERE txn_date BETWEEN ? AND ? AND type IN ('RECEIPT', 'PAYOUT', 'USAGE') GROUP BY txn_date, type`
    )
    .all(range.from, range.to) as Array<{ d: string; type: TransactionType; s: number }>
  const expenseRows = ctx.db
    .prepare(
      `SELECT expense_date AS d, SUM(amount_minor) AS s FROM business_expenses
       WHERE expense_date BETWEEN ? AND ? GROUP BY expense_date`
    )
    .all(range.from, range.to) as Array<{ d: string; s: number }>
  const seriesMap = new Map(
    buckets.map((b) => [b, { received: 0, paid: 0, usage: 0, expenses: 0 }])
  )
  for (const r of flowRows) {
    const entry = seriesMap.get(bucketOf(r.d, granularity))
    if (!entry) continue
    if (r.type === 'RECEIPT') entry.received += r.s
    if (r.type === 'PAYOUT') entry.paid += r.s
    if (r.type === 'USAGE') entry.usage += r.s
  }
  for (const r of expenseRows) {
    const entry = seriesMap.get(bucketOf(r.d, granularity))
    if (entry) entry.expenses += r.s
  }
  const cashFlowSeries = buckets.map((bucket) => {
    const e = seriesMap.get(bucket)!
    return {
      bucket,
      receivedMinor: e.received,
      paidMinor: e.paid,
      expensesMinor: e.expenses,
      netMinor: netCashFlow({ receivedMinor: e.received, paidMinor: e.paid, expensesMinor: e.expenses })
    }
  })
  const usageSeries = buckets.map((bucket) => ({ bucket, amountMinor: seriesMap.get(bucket)!.usage }))

  const expensesByCategory = (
    ctx.db
      .prepare(
        `SELECT ec.id, ec.name, SUM(e.amount_minor) AS s, COUNT(*) AS n FROM business_expenses e
         JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.expense_date BETWEEN ? AND ? GROUP BY ec.id HAVING SUM(e.amount_minor) <> 0 ORDER BY s DESC`
      )
      .all(range.from, range.to) as Array<{ id: number; name: string; s: number; n: number }>
  ).map((r) => ({ id: r.id, name: r.name, amountMinor: r.s, count: r.n }))

  const usageByCategory = (
    ctx.db
      .prepare(
        `SELECT uc.id, uc.name, SUM(t.amount_minor) AS s, COUNT(*) AS n FROM transactions t
         JOIN daily_usage_entries u ON u.id = t.usage_entry_id
         JOIN usage_categories uc ON uc.id = u.category_id
         WHERE t.type = 'USAGE' AND t.txn_date BETWEEN ? AND ?
         GROUP BY uc.id HAVING SUM(t.amount_minor) <> 0 ORDER BY s DESC`
      )
      .all(range.from, range.to) as Array<{ id: number; name: string; s: number; n: number }>
  ).map((r) => ({ id: r.id, name: r.name, amountMinor: r.s, count: r.n }))

  const topCustomers = (type: 'USAGE' | 'RECEIPT') =>
    (
      ctx.db
        .prepare(
          `SELECT c.id, c.name, c.customer_code, SUM(t.amount_minor) AS s, COUNT(*) AS n FROM transactions t
           JOIN customers c ON c.id = t.customer_id
           WHERE t.type = ? AND t.txn_date BETWEEN ? AND ?
           GROUP BY c.id HAVING SUM(t.amount_minor) > 0 ORDER BY s DESC, c.name LIMIT 10`
        )
        .all(type, range.from, range.to) as Array<{ id: number; name: string; customer_code: string; s: number; n: number }>
    ).map((r) => ({ id: r.id, name: r.name, customerCode: r.customer_code, amountMinor: r.s, count: r.n }))

  const months = trailingMonths(range.to, 12)
  const monthlyFlow = ctx.db
    .prepare(
      `SELECT substr(txn_date, 1, 7) AS m,
        SUM(CASE WHEN type = 'RECEIPT' THEN amount_minor ELSE 0 END) AS received,
        SUM(CASE WHEN type = 'PAYOUT' THEN amount_minor ELSE 0 END) AS paid
       FROM transactions WHERE substr(txn_date, 1, 7) BETWEEN ? AND ? GROUP BY m`
    )
    .all(months[0], months[months.length - 1]) as Array<{ m: string; received: number; paid: number }>
  const monthlyExpenses = ctx.db
    .prepare(
      `SELECT substr(expense_date, 1, 7) AS m, SUM(amount_minor) AS s FROM business_expenses
       WHERE substr(expense_date, 1, 7) BETWEEN ? AND ? GROUP BY m`
    )
    .all(months[0], months[months.length - 1]) as Array<{ m: string; s: number }>
  const flowByMonth = new Map(monthlyFlow.map((r) => [r.m, r]))
  const expByMonth = new Map(monthlyExpenses.map((r) => [r.m, r.s]))
  const monthlyCashFlow = months.map((month) => {
    const payouts = flowByMonth.get(month)?.paid ?? 0
    const expenses = expByMonth.get(month) ?? 0
    return {
      month,
      inflowMinor: flowByMonth.get(month)?.received ?? 0,
      outflowMinor: payouts + expenses,
      payoutsMinor: payouts,
      expensesMinor: expenses
    }
  })
  const monthlyExpenseTrend = months.map((month) => ({ month, amountMinor: expByMonth.get(month) ?? 0 }))

  // Balance distribution across all customers (current balances).
  const currency = getCurrency(ctx)
  const scale = 10 ** currency.minorDigits
  const small = 1_000 * scale
  const large = 10_000 * scale
  const fmt = new Intl.NumberFormat(currency.locale, {
    style: 'currency',
    currency: currency.code,
    notation: 'compact',
    maximumFractionDigits: 0
  })
  const smallLabel = fmt.format(1_000)
  const largeLabel = fmt.format(10_000)
  const distribution = ctx.db
    .prepare(
      `SELECT
        CASE
          WHEN b <= -? THEN 0
          WHEN b <= -? THEN 1
          WHEN b < 0 THEN 2
          WHEN b = 0 THEN 3
          WHEN b < ? THEN 4
          WHEN b < ? THEN 5
          ELSE 6
        END AS bucket,
        COUNT(*) AS n, COALESCE(SUM(b), 0) AS s
       FROM (SELECT COALESCE(a.balance_minor, 0) AS b FROM customers c
             LEFT JOIN (${CUSTOMER_TOTALS_SQL}) a ON a.customer_id = c.id)
       GROUP BY bucket`
    )
    .all(large, small, small, large) as Array<{ bucket: number; n: number; s: number }>
  const bucketLabels = [
    `Due ≥ ${largeLabel}`,
    `Due ${smallLabel}–${largeLabel}`,
    `Due < ${smallLabel}`,
    'Settled',
    `Credit < ${smallLabel}`,
    `Credit ${smallLabel}–${largeLabel}`,
    `Credit ≥ ${largeLabel}`
  ]
  const distMap = new Map(distribution.map((d) => [d.bucket, d]))
  const balanceDistribution = bucketLabels.map((label, order) => ({
    bucket: label,
    order,
    count: distMap.get(order)?.n ?? 0,
    amountMinor: distMap.get(order)?.s ?? 0
  }))

  const typeRows = ctx.db
    .prepare(
      `SELECT type, COUNT(*) AS n, SUM(amount_minor) AS s FROM transactions
       WHERE txn_date BETWEEN ? AND ? GROUP BY type`
    )
    .all(range.from, range.to) as Array<{ type: TransactionType; n: number; s: number }>
  const typeMap = new Map(typeRows.map((r) => [r.type, r]))
  const expenseAgg = ctx.db
    .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS s FROM business_expenses WHERE expense_date BETWEEN ? AND ?')
    .get(range.from, range.to) as { n: number; s: number }
  const transactionTypeBreakdown: DashboardData['transactionTypeBreakdown'] = [
    ...TRANSACTION_TYPES.map((type) => ({
      type,
      label: TRANSACTION_TYPE_LABELS[type],
      count: typeMap.get(type)?.n ?? 0,
      amountMinor: typeMap.get(type)?.s ?? 0
    })),
    { type: 'BUSINESS_EXPENSE' as const, label: 'Business expense', count: expenseAgg.n, amountMinor: expenseAgg.s }
  ]

  return {
    today: todayDate,
    range,
    granularity,
    customers,
    balances: {
      creditOutstandingMinor: balances.credit,
      dueFromCustomersMinor: balances.due,
      customersInCredit: balances.in_credit,
      customersWithDue: balances.with_due,
      customersSettled: customers.total - balances.in_credit - balances.with_due
    },
    todayKpis: kpisFor(ctx, todayDate, todayDate),
    monthKpis: kpisFor(ctx, monthStartIso(todayDate), todayDate),
    periodKpis: kpisFor(ctx, range.from, range.to),
    cashFlowSeries,
    usageSeries,
    expensesByCategory,
    usageByCategory,
    topCustomersByUsage: topCustomers('USAGE'),
    topCustomersByReceipts: topCustomers('RECEIPT'),
    monthlyCashFlow,
    monthlyExpenseTrend,
    balanceDistribution,
    transactionTypeBreakdown,
    latestTransactions: listLedger(ctx, { sortDir: 'desc', page: 1, pageSize: 8 }).rows,
    dateBasis: DATE_BASIS
  }
}
