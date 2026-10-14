/**
 * Report builder. Each report kind produces a typed table that is rendered as
 * CSV (exact decimal amounts, ISO dates) or as print-friendly HTML.
 */
import { AppError } from '@shared/errors'
import { formatIsoDate, formatMonthKey, eachDate, eachMonth } from '@shared/dates'
import {
  balanceEffectSql,
  classifyBalance,
  TRANSACTION_TYPE_LABELS,
  type TransactionType
} from '@shared/finance'
import { formatMoney, minorToDecimalString, quantityToString, type CurrencyConfig } from '@shared/money'
import { reportParamsSchema, type ReportKind, type ReportParams } from '@shared/schemas'
import { toCsv, type CsvColumn } from '@shared/csv'
import { REPORT_CSP } from '@shared/csp'
import type { ReportColumn, ReportData } from '@shared/types'
import { today, type ServiceContext } from './context'
import { CUSTOMER_TOTALS_SQL, getCustomerRow } from './ledger-core'
import { allLedgerRows, listLedger } from './ledger'
import { allUsageEntries } from './usage'
import { allExpenses } from './expenses'
import { DATE_BASIS, getDashboard, kpisFor } from './analytics'
import { getSettings } from './settings'
import { getLookup } from './lookups'

type Row = Record<string, string | number | null>

const money = (key: string, label: string): ReportColumn => ({ key, label, kind: 'money', align: 'right' })
const text = (key: string, label: string): ReportColumn => ({ key, label, kind: 'text' })
const date = (key: string, label: string): ReportColumn => ({ key, label, kind: 'date' })
const num = (key: string, label: string): ReportColumn => ({ key, label, kind: 'number', align: 'right' })

export const REPORT_TITLES: Record<ReportKind, string> = {
  customer_directory: 'Customer directory',
  customer_statement: 'Customer statement',
  customer_balances: 'Customer balance statement',
  transactions: 'All transactions',
  receipts: 'Payments received',
  payouts: 'Payments paid to customers',
  usage: 'Daily usage report',
  expenses: 'Business expense report',
  daily_cashbook: 'Daily cashbook',
  daily_summary: 'Daily financial summary',
  monthly_summary: 'Monthly financial summary',
  customer_payment_summary: 'Customer payment summary',
  customer_payout_summary: 'Customer payout summary',
  dashboard_summary: 'Dashboard summary'
}

function requireRange(p: { from?: string | null; to?: string | null }, todayDate: string): { from: string; to: string } {
  const from = p.from ?? `${todayDate.slice(0, 7)}-01`
  const to = p.to ?? todayDate
  if (from > to) throw new AppError('VALIDATION', 'Start date must be on or before end date')
  return { from, to }
}

export function buildReport(ctx: ServiceContext, rawParams: ReportParams): ReportData {
  const params = reportParamsSchema.parse(rawParams)
  const settings = getSettings(ctx)
  const fmtDate = (d: string | null | undefined) => formatIsoDate(d, settings.dateFormat)
  const fmtMoney = (m: number) => formatMoney(m, settings.currency)
  const todayDate = today(ctx)
  const filters: Array<{ label: string; value: string }> = []
  const summary: Array<{ label: string; value: string }> = []
  let columns: ReportColumn[] = []
  let rows: Row[] = []
  let totals: Row | null = null
  let subtitle = ''

  const addRangeFilter = (range: { from: string; to: string }) => {
    filters.push({ label: 'Period', value: `${fmtDate(range.from)} – ${fmtDate(range.to)}` })
    subtitle = `${fmtDate(range.from)} to ${fmtDate(range.to)}`
  }
  const addLookupFilters = () => {
    if (params.categoryId) {
      const kind = params.kind === 'usage' ? 'usage_categories' : params.kind === 'expenses' ? 'expense_categories' : 'transaction_categories'
      filters.push({ label: 'Category', value: getLookup(ctx, kind, params.categoryId).name })
    }
    if (params.paymentMethodId) {
      filters.push({ label: 'Payment method', value: getLookup(ctx, 'payment_methods', params.paymentMethodId).name })
    }
    if (params.customerId) {
      const c = getCustomerRow(ctx, params.customerId)
      filters.push({ label: 'Customer', value: `${c.customer_code} ${c.name}` })
    }
    if (params.types && params.types.length) {
      filters.push({ label: 'Types', value: params.types.map((t) => TRANSACTION_TYPE_LABELS[t]).join(', ') })
    }
  }

  switch (params.kind) {
    case 'customer_directory': {
      const status = params.status ?? 'ALL'
      if (status !== 'ALL') filters.push({ label: 'Status', value: status })
      columns = [
        text('code', 'Customer Code'),
        text('name', 'Name'),
        text('phone', 'Phone'),
        text('email', 'Email'),
        text('address', 'Address'),
        date('registrationDate', 'Registration Date'),
        text('status', 'Status'),
        money('opening', 'Opening Balance'),
        money('received', 'Total Received'),
        money('paid', 'Total Paid'),
        money('usage', 'Total Usage'),
        money('creditAdj', 'Credit Adjustments'),
        money('debitAdj', 'Debit Adjustments'),
        money('balance', 'Current Balance'),
        text('balanceStatus', 'Balance Status'),
        date('lastTxnDate', 'Last Transaction Date'),
        text('notes', 'Notes')
      ]
      const dbRows = ctx.db
        .prepare(
          `SELECT c.*, COALESCE(a.opening_minor,0) o, COALESCE(a.received_minor,0) r, COALESCE(a.paid_minor,0) p,
            COALESCE(a.usage_minor,0) u, COALESCE(a.credit_adj_minor,0) ca, COALESCE(a.debit_adj_minor,0) da,
            COALESCE(a.balance_minor,0) b, a.last_txn_date l
           FROM customers c LEFT JOIN (${CUSTOMER_TOTALS_SQL}) a ON a.customer_id = c.id
           WHERE (? = 'ALL' OR c.status = ?) ORDER BY c.customer_code`
        )
        .all(status, status) as Array<Record<string, unknown>>
      rows = dbRows.map((r) => ({
        code: r.customer_code as string,
        name: r.name as string,
        phone: r.phone as string | null,
        email: r.email as string | null,
        address: r.address as string | null,
        registrationDate: r.registration_date as string,
        status: r.status as string,
        opening: r.o as number,
        received: r.r as number,
        paid: r.p as number,
        usage: r.u as number,
        creditAdj: r.ca as number,
        debitAdj: r.da as number,
        balance: r.b as number,
        balanceStatus: classifyBalance(r.b as number),
        lastTxnDate: r.l as string | null,
        notes: r.notes as string | null
      }))
      totals = sumColumns(rows, ['opening', 'received', 'paid', 'usage', 'creditAdj', 'debitAdj', 'balance'], { code: 'Total' })
      summary.push({ label: 'Customers', value: String(rows.length) })
      break
    }

    case 'customer_statement': {
      if (!params.customerId) throw new AppError('VALIDATION', 'Select a customer for the statement')
      const customer = getCustomerRow(ctx, params.customerId)
      const range = { from: params.from ?? null, to: params.to ?? null }
      if (range.from || range.to) {
        filters.push({
          label: 'Period',
          value: `${range.from ? fmtDate(range.from) : 'Beginning'} – ${range.to ? fmtDate(range.to) : 'Today'}`
        })
      }
      subtitle = `${customer.customer_code} · ${customer.name}`
      const ledger = listLedger(ctx, { customerId: customer.id, from: range.from, to: range.to, pageSize: 1 })
      const entries = allLedgerRows(ctx, { customerId: customer.id, from: range.from, to: range.to })
      columns = [
        date('date', 'Date'),
        text('reference', 'Reference'),
        text('type', 'Type'),
        text('description', 'Description'),
        text('category', 'Category'),
        text('paymentMethod', 'Payment Method'),
        text('paymentReference', 'Payment Reference'),
        money('received', 'Money Received'),
        money('paid', 'Money Paid'),
        money('usage', 'Usage Charge'),
        money('adjustment', 'Adjustment / Opening'),
        money('balance', 'Running Balance'),
        text('notes', 'Notes')
      ]
      const opening = ledger.periodOpeningMinor ?? 0
      rows = [
        {
          date: range.from ?? null,
          reference: '',
          type: 'Balance brought forward',
          description: 'Balance before the statement period',
          category: null,
          paymentMethod: null,
          paymentReference: null,
          received: null,
          paid: null,
          usage: null,
          adjustment: null,
          balance: opening,
          notes: null
        },
        ...entries.map((e) => ({
          date: e.txnDate,
          reference: e.reference,
          type: TRANSACTION_TYPE_LABELS[e.type] + (e.isReversal ? ' (reversal)' : ''),
          description: e.description,
          category: e.category,
          paymentMethod: e.paymentMethod,
          paymentReference: e.paymentReference,
          received: e.type === 'RECEIPT' ? e.amountMinor : null,
          paid: e.type === 'PAYOUT' ? e.amountMinor : null,
          usage: e.type === 'USAGE' ? e.amountMinor : null,
          adjustment: ['CREDIT_ADJUSTMENT', 'DEBIT_ADJUSTMENT', 'OPENING_BALANCE'].includes(e.type) ? e.balanceEffectMinor : null,
          balance: e.runningBalanceMinor,
          notes: e.notes
        }))
      ]
      totals = {
        date: null,
        reference: 'Totals',
        received: ledger.totals.receivedMinor,
        paid: ledger.totals.paidMinor,
        usage: ledger.totals.usageMinor,
        adjustment: ledger.totals.openingMinor + ledger.totals.creditAdjustmentsMinor - ledger.totals.debitAdjustmentsMinor,
        balance: ledger.periodClosingMinor ?? 0
      }
      summary.push(
        { label: 'Customer', value: `${customer.customer_code} – ${customer.name}` },
        { label: 'Opening balance for period', value: fmtMoney(opening) },
        { label: 'Money received', value: fmtMoney(ledger.totals.receivedMinor) },
        { label: 'Money paid to customer', value: fmtMoney(ledger.totals.paidMinor) },
        { label: 'Usage charges', value: fmtMoney(ledger.totals.usageMinor) },
        { label: 'Closing balance', value: `${fmtMoney(ledger.periodClosingMinor ?? 0)} (${describeBalance(ledger.periodClosingMinor ?? 0)})` }
      )
      break
    }

    case 'customer_balances': {
      const asOf = params.asOf ?? params.to ?? todayDate
      filters.push({ label: 'Balances as of', value: fmtDate(asOf) })
      subtitle = `As of ${fmtDate(asOf)}`
      columns = [
        text('code', 'Customer Code'),
        text('name', 'Name'),
        text('status', 'Status'),
        money('opening', 'Opening Balance'),
        money('received', 'Received'),
        money('paid', 'Paid'),
        money('usage', 'Usage'),
        money('creditAdj', 'Credit Adj.'),
        money('debitAdj', 'Debit Adj.'),
        money('balance', 'Balance'),
        money('credit', 'Credit Held'),
        money('due', 'Amount Due'),
        text('balanceStatus', 'Balance Status')
      ]
      const dbRows = ctx.db
        .prepare(
          `SELECT c.customer_code, c.name, c.status,
            COALESCE(SUM(CASE WHEN t.type='OPENING_BALANCE' THEN t.amount_minor END),0) o,
            COALESCE(SUM(CASE WHEN t.type='RECEIPT' THEN t.amount_minor END),0) r,
            COALESCE(SUM(CASE WHEN t.type='PAYOUT' THEN t.amount_minor END),0) p,
            COALESCE(SUM(CASE WHEN t.type='USAGE' THEN t.amount_minor END),0) u,
            COALESCE(SUM(CASE WHEN t.type='CREDIT_ADJUSTMENT' THEN t.amount_minor END),0) ca,
            COALESCE(SUM(CASE WHEN t.type='DEBIT_ADJUSTMENT' THEN t.amount_minor END),0) da,
            COALESCE(SUM(${balanceEffectSql('t')}),0) b
           FROM customers c LEFT JOIN transactions t ON t.customer_id = c.id AND t.txn_date <= ?
           WHERE (? IS NULL OR ? = 'ALL' OR c.status = ?)
           GROUP BY c.id ORDER BY c.customer_code`
        )
        .all(asOf, params.status ?? null, params.status ?? null, params.status ?? null) as Array<Record<string, number | string>>
      rows = dbRows.map((r) => {
        const b = r.b as number
        return {
          code: r.customer_code as string,
          name: r.name as string,
          status: r.status as string,
          opening: r.o as number,
          received: r.r as number,
          paid: r.p as number,
          usage: r.u as number,
          creditAdj: r.ca as number,
          debitAdj: r.da as number,
          balance: b,
          credit: b > 0 ? b : 0,
          due: b < 0 ? -b : 0,
          balanceStatus: classifyBalance(b)
        }
      })
      totals = sumColumns(rows, ['opening', 'received', 'paid', 'usage', 'creditAdj', 'debitAdj', 'balance', 'credit', 'due'], { code: 'Total' })
      summary.push(
        { label: 'Customer credit held', value: fmtMoney(totals.credit as number) },
        { label: 'Total due from customers', value: fmtMoney(totals.due as number) }
      )
      break
    }

    case 'transactions':
    case 'receipts':
    case 'payouts': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      const types: TransactionType[] | null =
        params.kind === 'receipts' ? ['RECEIPT'] : params.kind === 'payouts' ? ['PAYOUT'] : params.types ?? null
      if (params.kind === 'transactions') addLookupFilters()
      else {
        if (params.customerId || params.paymentMethodId || params.categoryId) addLookupFilters()
      }
      const entries = allLedgerRows(ctx, {
        from: range.from,
        to: range.to,
        types,
        customerId: params.customerId ?? null,
        categoryId: params.categoryId ?? null,
        paymentMethodId: params.paymentMethodId ?? null
      })
      if (params.kind === 'transactions') {
        columns = [
          text('reference', 'Reference'),
          date('date', 'Date'),
          text('customerCode', 'Customer Code'),
          text('customerName', 'Customer Name'),
          text('type', 'Type'),
          money('amount', 'Amount'),
          money('effect', 'Balance Effect'),
          money('running', 'Running Balance'),
          text('paymentMethod', 'Payment Method'),
          text('category', 'Category'),
          text('description', 'Description'),
          text('paymentReference', 'Payment Reference'),
          text('notes', 'Notes'),
          text('reason', 'Reason'),
          text('reversesReference', 'Reverses Reference'),
          text('reversedByReference', 'Reversed By Reference'),
          text('externalRef', 'Original Reference'),
          text('source', 'Source'),
          text('createdAt', 'Recorded At'),
          text('createdBy', 'Recorded By')
        ]
        rows = entries.map((e) => ({
          reference: e.reference,
          date: e.txnDate,
          customerCode: e.customerCode,
          customerName: e.customerName,
          type: e.type,
          amount: e.amountMinor,
          effect: e.balanceEffectMinor,
          running: e.runningBalanceMinor,
          paymentMethod: e.paymentMethod,
          category: e.category,
          description: e.description,
          paymentReference: e.paymentReference,
          notes: e.notes,
          reason: e.reason,
          reversesReference: e.reversesReference,
          reversedByReference: e.reversedByReference,
          externalRef: e.externalRef,
          source: e.source,
          createdAt: e.createdAt,
          createdBy: e.createdBy
        }))
        totals = { reference: 'Net balance effect', effect: rows.reduce((s, r) => s + (r.effect as number), 0) }
        summary.push({ label: 'Entries', value: String(rows.length) })
      } else {
        columns = [
          text('reference', 'Reference'),
          date('date', 'Date'),
          text('customerCode', 'Customer Code'),
          text('customerName', 'Customer Name'),
          money('amount', 'Amount'),
          text('paymentMethod', 'Payment Method'),
          text('paymentReference', 'Payment Reference'),
          text('category', 'Category'),
          text('description', 'Description'),
          ...(params.kind === 'payouts'
            ? [text('reason', 'Reason'), text('relatedReference', 'Related Receipt'), text('overrideReason', 'Override Reason')]
            : []),
          text('reversal', 'Reversal Of / Reversed By'),
          text('notes', 'Notes')
        ]
        rows = entries.map((e) => ({
          reference: e.reference,
          date: e.txnDate,
          customerCode: e.customerCode,
          customerName: e.customerName,
          amount: e.amountMinor,
          paymentMethod: e.paymentMethod,
          paymentReference: e.paymentReference,
          category: e.category,
          description: e.description,
          reason: e.reason,
          relatedReference: e.relatedReference,
          overrideReason: e.overrideReason,
          reversal: e.reversesReference ? `Reverses ${e.reversesReference}` : e.reversedByReference ? `Reversed by ${e.reversedByReference}` : null,
          notes: e.notes
        }))
        totals = sumColumns(rows, ['amount'], { reference: 'Total' })
        summary.push({
          label: params.kind === 'receipts' ? 'Total received (net of reversals)' : 'Total paid (net of reversals)',
          value: fmtMoney(totals.amount as number)
        })
      }
      break
    }

    case 'usage': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      addLookupFilters()
      const entries = allUsageEntries(ctx, {
        from: range.from,
        to: range.to,
        customerId: params.customerId ?? null,
        categoryId: params.categoryId ?? null
      })
      columns = [
        text('reference', 'Reference'),
        date('date', 'Date'),
        text('customerCode', 'Customer Code'),
        text('customerName', 'Customer Name'),
        text('category', 'Category'),
        text('description', 'Description'),
        text('method', 'Method'),
        num('quantity', 'Quantity'),
        text('unit', 'Unit'),
        money('rate', 'Rate'),
        money('fees', 'Fees'),
        money('discount', 'Discount'),
        text('discountReason', 'Discount Reason'),
        money('charge', 'Charge'),
        text('status', 'Status'),
        text('reversalReference', 'Reversal Reference'),
        text('notes', 'Notes')
      ]
      rows = entries
        .slice()
        .reverse()
        .map((u) => ({
          reference: u.txnReference,
          date: u.usageDate,
          customerCode: u.customerCode,
          customerName: u.customerName,
          category: u.category,
          description: u.description,
          method: u.method,
          quantity: u.quantityMilli !== null ? quantityToString(u.quantityMilli) : null,
          unit: u.unit,
          rate: u.rateMinor,
          fees: u.feesMinor,
          discount: u.discountMinor,
          discountReason: u.discountReason,
          charge: u.chargeMinor,
          status: u.status,
          reversalReference: u.reversalReference,
          notes: u.notes
        }))
      const posted = rows.filter((r) => r.status === 'POSTED')
      totals = { reference: 'Total posted usage', charge: posted.reduce((s, r) => s + (r.charge as number), 0) }
      summary.push(
        { label: 'Posted entries', value: String(posted.length) },
        { label: 'Reversed / corrected entries', value: String(rows.length - posted.length) },
        { label: 'Total usage charges', value: fmtMoney(totals.charge as number) }
      )
      break
    }

    case 'expenses': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      addLookupFilters()
      const entries = allExpenses(ctx, {
        from: range.from,
        to: range.to,
        categoryId: params.categoryId ?? null,
        paymentMethodId: params.paymentMethodId ?? null
      })
      columns = [
        text('reference', 'Reference'),
        date('date', 'Date'),
        text('category', 'Category'),
        text('description', 'Description'),
        money('amount', 'Amount'),
        text('paymentMethod', 'Payment Method'),
        text('paymentReference', 'Payment Reference'),
        text('supplier', 'Supplier / Recipient'),
        text('reversal', 'Reversal Of / Reversed By'),
        text('reason', 'Reason'),
        text('notes', 'Notes')
      ]
      rows = entries.map((e) => ({
        reference: e.reference,
        date: e.expenseDate,
        category: e.category,
        description: e.description,
        amount: e.amountMinor,
        paymentMethod: e.paymentMethod,
        paymentReference: e.paymentReference,
        supplier: e.supplier,
        reversal: e.reversesReference ? `Reverses ${e.reversesReference}` : e.reversedByReference ? `Reversed by ${e.reversedByReference}` : null,
        reason: e.reason,
        notes: e.notes
      }))
      totals = sumColumns(rows, ['amount'], { reference: 'Total' })
      summary.push({ label: 'Total expenses (net of reversals)', value: fmtMoney(totals.amount as number) })
      break
    }

    case 'daily_cashbook': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      if (params.paymentMethodId) addLookupFilters()
      const cashRows = ctx.db
        .prepare(
          `SELECT * FROM (
             SELECT t.txn_date AS d, t.id AS seq, 0 AS src, t.reference AS ref, c.customer_code || ' ' || c.name AS party,
               t.description AS description, pm.name AS method, t.type AS type, t.amount_minor AS amount
             FROM transactions t JOIN customers c ON c.id = t.customer_id
             LEFT JOIN payment_methods pm ON pm.id = t.payment_method_id
             WHERE t.type IN ('RECEIPT','PAYOUT') AND t.txn_date BETWEEN ? AND ? AND (? IS NULL OR t.payment_method_id = ?)
             UNION ALL
             SELECT e.expense_date, e.id, 1, e.reference, COALESCE(e.supplier, ec.name), e.description, pm.name, 'EXPENSE', e.amount_minor
             FROM business_expenses e JOIN expense_categories ec ON ec.id = e.category_id
             JOIN payment_methods pm ON pm.id = e.payment_method_id
             WHERE e.expense_date BETWEEN ? AND ? AND (? IS NULL OR e.payment_method_id = ?)
           ) ORDER BY d, src, seq`
        )
        .all(
          range.from,
          range.to,
          params.paymentMethodId ?? null,
          params.paymentMethodId ?? null,
          range.from,
          range.to,
          params.paymentMethodId ?? null,
          params.paymentMethodId ?? null
        ) as Array<{ d: string; ref: string; party: string; description: string; method: string; type: string; amount: number }>
      columns = [
        date('date', 'Date'),
        text('reference', 'Reference'),
        text('kind', 'Entry'),
        text('party', 'Customer / Supplier'),
        text('description', 'Description'),
        text('paymentMethod', 'Payment Method'),
        money('cashIn', 'Cash In'),
        money('cashOut', 'Cash Out'),
        money('net', 'Cumulative Net')
      ]
      let cumulative = 0
      rows = cashRows.map((r) => {
        const inflow = r.type === 'RECEIPT' ? r.amount : 0
        const outflow = r.type === 'RECEIPT' ? 0 : r.amount
        cumulative += inflow - outflow
        return {
          date: r.d,
          reference: r.ref,
          kind: r.type === 'RECEIPT' ? 'Money received' : r.type === 'PAYOUT' ? 'Paid to customer' : 'Business expense',
          party: r.party,
          description: r.description,
          paymentMethod: r.method,
          cashIn: inflow || null,
          cashOut: outflow || null,
          net: cumulative
        }
      })
      totals = { ...sumColumns(rows, ['cashIn', 'cashOut'], { date: null, reference: 'Totals' }), net: cumulative }
      summary.push(
        { label: 'Cash in', value: fmtMoney(totals.cashIn as number) },
        { label: 'Cash out', value: fmtMoney(totals.cashOut as number) },
        { label: 'Net recorded cash flow', value: fmtMoney(cumulative) },
        { label: 'Note', value: 'Cumulative net covers the selected period only; it is not a cash-on-hand balance.' }
      )
      break
    }

    case 'daily_summary':
    case 'monthly_summary': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      const monthly = params.kind === 'monthly_summary'
      const keys = monthly ? eachMonth(range.from, range.to) : eachDate(range.from, range.to)
      columns = [
        monthly ? text('period', 'Month') : date('period', 'Date'),
        money('received', 'Money Received'),
        money('paid', 'Paid to Customers'),
        money('expenses', 'Business Expenses'),
        money('net', 'Net Recorded Cash Flow'),
        money('usage', 'Usage Charges'),
        money('creditAdj', 'Credit Adjustments'),
        money('debitAdj', 'Debit Adjustments'),
        num('count', 'Entries')
      ]
      rows = keys.map((k) => {
        const from = monthly ? `${k}-01` : k
        const to = monthly ? lastDayOfMonth(k) : k
        const clampedFrom = from < range.from ? range.from : from
        const clampedTo = to > range.to ? range.to : to
        const kpi = kpisFor(ctx, clampedFrom, clampedTo)
        return {
          period: monthly ? formatMonthKey(k) : k,
          received: kpi.receivedMinor,
          paid: kpi.paidMinor,
          expenses: kpi.expensesMinor,
          net: kpi.netCashFlowMinor,
          usage: kpi.usageMinor,
          creditAdj: kpi.creditAdjustmentsMinor,
          debitAdj: kpi.debitAdjustmentsMinor,
          count: kpi.transactionCount
        }
      })
      totals = sumColumns(rows, ['received', 'paid', 'expenses', 'net', 'usage', 'creditAdj', 'debitAdj', 'count'], { period: 'Total' })
      break
    }

    case 'customer_payment_summary':
    case 'customer_payout_summary': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      const type = params.kind === 'customer_payment_summary' ? 'RECEIPT' : 'PAYOUT'
      const dbRows = ctx.db
        .prepare(
          `SELECT c.customer_code, c.name, COUNT(*) AS n, SUM(t.amount_minor) AS s, MAX(t.txn_date) AS last
           FROM transactions t JOIN customers c ON c.id = t.customer_id
           WHERE t.type = ? AND t.txn_date BETWEEN ? AND ?
           GROUP BY c.id ORDER BY s DESC, c.customer_code`
        )
        .all(type, range.from, range.to) as Array<{ customer_code: string; name: string; n: number; s: number; last: string }>
      columns = [
        text('code', 'Customer Code'),
        text('name', 'Customer Name'),
        num('count', type === 'RECEIPT' ? 'Receipts' : 'Payouts'),
        money('amount', type === 'RECEIPT' ? 'Total Received' : 'Total Paid'),
        date('last', type === 'RECEIPT' ? 'Last Receipt' : 'Last Payout')
      ]
      rows = dbRows.map((r) => ({ code: r.customer_code, name: r.name, count: r.n, amount: r.s, last: r.last }))
      totals = sumColumns(rows, ['count', 'amount'], { code: 'Total' })
      break
    }

    case 'dashboard_summary': {
      const range = requireRange(params, todayDate)
      addRangeFilter(range)
      const d = getDashboard(ctx, range)
      columns = [text('metric', 'Metric'), text('value', 'Value'), text('definition', 'Definition')]
      const m = (metric: string, value: number, definition: string) => ({ metric, value: fmtMoneyPlain(value, settings.currency), definition })
      rows = [
        { metric: 'Registered customers', value: String(d.customers.total), definition: 'All customer accounts' },
        { metric: 'Active customers', value: String(d.customers.active), definition: 'Accounts with status Active' },
        m('Money received', d.periodKpis.receivedMinor, 'Recorded receipts from customers in the period'),
        m('Money paid to customers', d.periodKpis.paidMinor, 'Recorded payouts/refunds to customers in the period'),
        m('Usage charges', d.periodKpis.usageMinor, 'Posted daily usage charges in the period (not cash)'),
        m('Business expenses', d.periodKpis.expensesMinor, 'Operating expenses in the period'),
        m('Net recorded cash flow', d.periodKpis.netCashFlowMinor, 'Received − paid to customers − expenses'),
        m('Credit adjustments', d.periodKpis.creditAdjustmentsMinor, 'Approved increases to customer credit'),
        m('Debit adjustments', d.periodKpis.debitAdjustmentsMinor, 'Approved decreases to customer credit'),
        m('Customer credit outstanding (current)', d.balances.creditOutstandingMinor, 'Sum of positive customer balances today'),
        m('Due from customers (current)', d.balances.dueFromCustomersMinor, 'Sum of negative customer balances today')
      ]
      break
    }
  }

  return {
    kind: params.kind,
    title: REPORT_TITLES[params.kind],
    subtitle,
    generatedAt: ctx.now().toISOString(),
    dateBasis: params.kind === 'customer_directory' ? 'Current balances (all entries)' : DATE_BASIS,
    filters,
    columns,
    rows,
    totals,
    summary
  }
}

function fmtMoneyPlain(minor: number, currency: CurrencyConfig): string {
  return formatMoney(minor, currency)
}

function describeBalance(balance: number): string {
  const status = classifyBalance(balance)
  return status === 'CREDIT' ? 'credit' : status === 'DUE' ? 'amount due' : 'settled'
}

function lastDayOfMonth(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return `${monthKey}-${String(last).padStart(2, '0')}`
}

function sumColumns(rows: Row[], keys: string[], base: Row): Row {
  const out: Row = { ...base }
  for (const key of keys) out[key] = rows.reduce((sum, r) => sum + (typeof r[key] === 'number' ? (r[key] as number) : 0), 0)
  return out
}

/** CSV: money as exact decimal strings, dates ISO, text guarded against formula injection. */
export function reportToCsv(report: ReportData, currency: CurrencyConfig): string {
  const columns: CsvColumn<Row>[] = report.columns.map((col) => ({
    header: col.kind === 'money' ? `${col.label} (${currency.code})` : col.label,
    kind: col.kind === 'money' ? 'money' : col.kind === 'number' ? 'number' : col.kind === 'date' ? 'date' : 'text',
    value: (row: Row) => {
      const v = row[col.key]
      if (v === null || v === undefined || v === '') return ''
      if (col.kind === 'money') return minorToDecimalString(v as number, currency.minorDigits)
      return v
    }
  }))
  return toCsv(columns, report.rows)
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Print-friendly, script-free HTML document. All values are HTML-escaped. */
export function reportToHtml(report: ReportData, options: { currency: CurrencyConfig; dateFormat: string; businessName: string }): string {
  const cell = (col: ReportColumn, value: string | number | null | undefined) => {
    if (value === null || value === undefined || value === '') return ''
    if (col.kind === 'money' && typeof value === 'number') return escapeHtml(formatMoney(value, options.currency))
    if (col.kind === 'date' && typeof value === 'string') return escapeHtml(formatIsoDate(value, options.dateFormat))
    return escapeHtml(value)
  }
  const generated = new Date(report.generatedAt)
  const head = report.columns.map((c) => `<th class="${c.align === 'right' ? 'r' : ''}">${escapeHtml(c.label)}</th>`).join('')
  const body = report.rows
    .map(
      (row) =>
        `<tr>${report.columns
          .map((c) => {
            const v = row[c.key]
            const neg = c.kind === 'money' && typeof v === 'number' && v < 0 ? ' neg' : ''
            return `<td class="${c.align === 'right' ? 'r' : ''}${neg}">${cell(c, v)}</td>`
          })
          .join('')}</tr>`
    )
    .join('\n')
  const foot = report.totals
    ? `<tfoot><tr>${report.columns.map((c) => `<td class="${c.align === 'right' ? 'r' : ''}">${cell(c, report.totals?.[c.key])}</td>`).join('')}</tr></tfoot>`
    : ''
  const filters = report.filters.map((f) => `<span><b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}</span>`).join('')
  const summary = report.summary.length
    ? `<dl class="summary">${report.summary.map((s) => `<div><dt>${escapeHtml(s.label)}</dt><dd>${escapeHtml(s.value)}</dd></div>`).join('')}</dl>`
    : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}" />
<title>${escapeHtml(report.title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; color: #1f1f1f; margin: 24px; font-size: 11px; background: #fff; }
  header { border-bottom: 3px solid #2A2A2A; padding-bottom: 10px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  h1 { font-size: 20px; margin: 0; color: #2A2A2A; }
  .brand { color: #E10600; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; font-size: 10px; }
  .meta { text-align: right; color: #555; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 8px 0 12px; color: #333; }
  .summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 18px; margin: 0 0 14px; }
  .summary div { border-left: 3px solid #C0C0C0; padding-left: 8px; }
  dt { color: #666; font-size: 10px; } dd { margin: 0; font-weight: 600; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2A2A2A; color: #fff; text-align: left; padding: 6px; font-weight: 600; font-size: 10px; }
  td { padding: 5px 6px; border-bottom: 1px solid #e3e3e3; vertical-align: top; }
  tr:nth-child(even) td { background: #fafafa; }
  tfoot td { font-weight: 700; border-top: 2px solid #2A2A2A; background: #f1f1f1; }
  .r { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .neg { color: #b00500; }
  footer { margin-top: 14px; color: #777; font-size: 9px; border-top: 1px solid #ddd; padding-top: 6px; }
  .empty { padding: 24px; text-align: center; color: #777; }
</style></head>
<body>
<header>
  <div><div class="brand">${escapeHtml(options.businessName || 'Customer Money Manager')}</div>
  <h1>${escapeHtml(report.title)}</h1>${report.subtitle ? `<div>${escapeHtml(report.subtitle)}</div>` : ''}</div>
  <div class="meta">Generated ${escapeHtml(generated.toLocaleString())}<br/>Date basis: ${escapeHtml(report.dateBasis)}</div>
</header>
${filters ? `<div class="filters">${filters}</div>` : ''}
${summary}
${report.rows.length ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>` : '<div class="empty">No records match the selected filters.</div>'}
<footer>Customer Money Manager — local records entered by the user. Amounts are as recorded and have not been independently verified by a bank or payment provider. Currency: ${escapeHtml(options.currency.code)}.</footer>
</body></html>`
}
