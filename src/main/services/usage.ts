import { AppError } from '@shared/errors'
import { daysBetweenInclusive, eachDate, eachMonth, weekStartIso } from '@shared/dates'
import { computeUsageCharge } from '@shared/usage'
import {
  dateRangeSchema,
  usageBatchSchema,
  usageCorrectSchema,
  usageLineSchema,
  usageListSchema,
  type UsageBatchInput,
  type UsageCorrectInput,
  type UsageListInput
} from '@shared/schemas'
import type { Paged, UsageBatchResult, UsageCorrectionResult, UsageEntry, UsageSummary } from '@shared/types'
import type { z } from 'zod'
import { blankToNull, currentActor, likePattern, nowIso, pageBounds, today, writeAudit, type ServiceContext } from './context'
import { getCustomerRow, insertLedgerEntry } from './ledger-core'
import { requireActiveLookup } from './lookups'
import { reverseTransactionInTxn } from './ledger'
import { formatMoney } from '@shared/money'
import { getCurrency } from './settings'

type UsageLine = z.output<typeof usageLineSchema>

interface UsageDbRow {
  id: number
  customer_id: number
  customer_code: string
  customer_name: string
  usage_date: string
  category_id: number
  category: string
  description: string
  method: 'QUANTITY' | 'FIXED'
  quantity_milli: number | null
  unit_id: number | null
  unit: string | null
  rate_minor: number | null
  base_amount_minor: number
  fees_minor: number
  discount_minor: number
  discount_reason: string | null
  charge_minor: number
  fixed_reason: string | null
  notes: string | null
  txn_id: number
  txn_reference: string
  reversal_reference: string | null
  replaces_entry_id: number | null
  replaced_by_entry_id: number | null
  created_at: string
  created_by: string | null
}

const USAGE_SELECT = `
  SELECT u.*, c.customer_code AS customer_code, c.name AS customer_name, uc.name AS category, un.name AS unit,
    t.id AS txn_id, t.reference AS txn_reference, r.reference AS reversal_reference,
    rep.id AS replaced_by_entry_id
  FROM daily_usage_entries u
  JOIN customers c ON c.id = u.customer_id
  JOIN usage_categories uc ON uc.id = u.category_id
  LEFT JOIN usage_units un ON un.id = u.unit_id
  JOIN transactions t ON t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL
  LEFT JOIN transactions r ON r.reverses_txn_id = t.id
  LEFT JOIN daily_usage_entries rep ON rep.replaces_entry_id = u.id`

function toEntry(row: UsageDbRow): UsageEntry {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerName: row.customer_name,
    usageDate: row.usage_date,
    categoryId: row.category_id,
    category: row.category,
    description: row.description,
    method: row.method,
    quantityMilli: row.quantity_milli,
    unitId: row.unit_id,
    unit: row.unit,
    rateMinor: row.rate_minor,
    baseAmountMinor: row.base_amount_minor,
    feesMinor: row.fees_minor,
    discountMinor: row.discount_minor,
    discountReason: row.discount_reason,
    chargeMinor: row.charge_minor,
    fixedReason: row.fixed_reason,
    notes: row.notes,
    status: row.reversal_reference ? 'REVERSED' : 'POSTED',
    txnId: row.txn_id,
    txnReference: row.txn_reference,
    reversalReference: row.reversal_reference,
    replacesEntryId: row.replaces_entry_id,
    replacedByEntryId: row.replaced_by_entry_id,
    createdAt: row.created_at,
    createdBy: row.created_by
  }
}

export function getUsageEntry(ctx: ServiceContext, id: number): UsageEntry {
  const row = ctx.db.prepare(`${USAGE_SELECT} WHERE u.id = ?`).get(id) as UsageDbRow | undefined
  if (!row) throw new AppError('NOT_FOUND', 'Usage entry not found')
  return toEntry(row)
}

export interface InsertUsageArgs {
  customerId: number
  usageDate: string
  line: UsageLine
  batchKey: string
  lineNo: number
  replacesEntryId?: number | null
  source?: 'MANUAL' | 'IMPORT' | 'CORRECTION' | 'DEMO'
  importId?: number | null
  externalRef?: string | null
}

/** Inserts a usage entry and its single ledger posting. Caller provides the transaction. */
export function insertUsageEntry(
  ctx: ServiceContext,
  args: InsertUsageArgs
): { id: number; txnId: number; reference: string; chargeMinor: number } {
  const { line } = args
  const category = requireActiveLookup(ctx, 'usage_categories', line.categoryId, 'Usage category')
  const unit = line.unitId ? requireActiveLookup(ctx, 'usage_units', line.unitId, 'Unit') : null
  const charge = computeUsageCharge({
    method: line.method,
    quantityMilli: line.quantityMilli,
    rateMinor: line.rateMinor,
    fixedAmountMinor: line.fixedAmountMinor,
    feesMinor: line.feesMinor,
    discountMinor: line.discountMinor
  })
  if (!charge.ok) throw new AppError('VALIDATION', `Line ${args.lineNo + 1}: ${charge.error}`)
  const now = nowIso(ctx)
  const result = ctx.db
    .prepare(
      `INSERT INTO daily_usage_entries (customer_id, usage_date, category_id, description, method, quantity_milli,
        unit_id, rate_minor, base_amount_minor, fees_minor, discount_minor, discount_reason, charge_minor,
        fixed_reason, notes, batch_key, line_no, replaces_entry_id, source, import_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.customerId,
      args.usageDate,
      category.id,
      line.description.trim(),
      line.method,
      line.method === 'QUANTITY' ? line.quantityMilli : null,
      unit?.id ?? null,
      line.method === 'QUANTITY' ? line.rateMinor : null,
      charge.value.baseAmountMinor,
      charge.value.feesMinor,
      charge.value.discountMinor,
      charge.value.discountMinor > 0 ? blankToNull(line.discountReason) : null,
      charge.value.chargeMinor,
      line.method === 'FIXED' ? blankToNull(line.fixedReason) : null,
      blankToNull(line.notes),
      args.batchKey,
      args.lineNo,
      args.replacesEntryId ?? null,
      args.source ?? 'MANUAL',
      args.importId ?? null,
      currentActor(ctx),
      now,
      now
    )
  const entryId = Number(result.lastInsertRowid)
  const txn = insertLedgerEntry(ctx, {
    customerId: args.customerId,
    type: 'USAGE',
    txnDate: args.usageDate,
    amountMinor: charge.value.chargeMinor,
    description: `${category.name}: ${line.description.trim()}`.slice(0, 300),
    usageEntryId: entryId,
    notes: blankToNull(line.notes),
    source: args.source ?? 'MANUAL',
    importId: args.importId ?? null,
    externalRef: args.externalRef ?? null
  })
  return { id: entryId, txnId: txn.id, reference: txn.reference, chargeMinor: charge.value.chargeMinor }
}

function existingBatch(ctx: ServiceContext, batchKey: string): UsageBatchResult | null {
  const rows = ctx.db
    .prepare(
      `SELECT u.id, u.charge_minor, t.id AS txn_id, t.reference FROM daily_usage_entries u
       JOIN transactions t ON t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL
       WHERE u.batch_key = ? ORDER BY u.line_no`
    )
    .all(batchKey) as Array<{ id: number; charge_minor: number; txn_id: number; reference: string }>
  if (rows.length === 0) return null
  return {
    batchKey,
    duplicateRequest: true,
    entries: rows.map((r) => ({ id: r.id, txnId: r.txn_id, reference: r.reference, chargeMinor: r.charge_minor })),
    totalMinor: rows.reduce((sum, r) => sum + r.charge_minor, 0)
  }
}

/** Records one or more usage lines for a customer and date atomically. */
export function recordUsageBatch(ctx: ServiceContext, raw: UsageBatchInput): UsageBatchResult {
  const input = usageBatchSchema.parse(raw)
  const run = ctx.db.transaction((): UsageBatchResult => {
    const existing = existingBatch(ctx, input.idempotencyKey)
    if (existing) return existing
    const customer = getCustomerRow(ctx, input.customerId)
    if (customer.status !== 'ACTIVE') {
      throw new AppError('VALIDATION', `${customer.name} is inactive. Reactivate the customer before adding usage.`)
    }
    const entries = input.lines.map((line, index) =>
      insertUsageEntry(ctx, {
        customerId: customer.id,
        usageDate: input.usageDate,
        line,
        batchKey: input.idempotencyKey,
        lineNo: index
      })
    )
    const totalMinor = entries.reduce((sum, e) => sum + e.chargeMinor, 0)
    writeAudit(ctx, {
      action: 'USAGE_RECORDED',
      entityType: 'customer',
      entityId: customer.id,
      summary: `${entries.length} usage line(s) on ${input.usageDate}: ${entries.map((e) => e.reference).join(', ')}`,
      after: { totalMinor, references: entries.map((e) => e.reference) }
    })
    return { batchKey: input.idempotencyKey, duplicateRequest: false, entries, totalMinor }
  })
  return run.immediate()
}

/**
 * Corrects a posted usage entry: the original posting is reversed (never
 * edited) and, optionally, a replacement entry is posted that links back to
 * the original. Both happen in one transaction.
 */
export function correctUsage(ctx: ServiceContext, raw: UsageCorrectInput): UsageCorrectionResult {
  const input = usageCorrectSchema.parse(raw)
  const run = ctx.db.transaction((): UsageCorrectionResult => {
    const prior = ctx.db
      .prepare('SELECT reference FROM transactions WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { reference: string } | undefined
    if (prior) {
      const replacement = ctx.db
        .prepare(
          `SELECT u.id, u.charge_minor, t.reference FROM daily_usage_entries u
           JOIN transactions t ON t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL
           WHERE u.batch_key = ?`
        )
        .get(input.idempotencyKey) as { id: number; charge_minor: number; reference: string } | undefined
      return {
        reversalReference: prior.reference,
        replacement: replacement
          ? { id: replacement.id, reference: replacement.reference, chargeMinor: replacement.charge_minor }
          : null,
        duplicateRequest: true
      }
    }
    const entry = getUsageEntry(ctx, input.entryId)
    if (entry.status === 'REVERSED') {
      throw new AppError('ALREADY_REVERSED', `This usage entry was already corrected (${entry.reversalReference}).`)
    }
    const reversal = reverseTransactionInTxn(
      ctx,
      { txnId: entry.txnId, reason: input.reason, date: entry.usageDate, idempotencyKey: input.idempotencyKey },
      { source: 'CORRECTION' }
    )
    let replacement: UsageCorrectionResult['replacement'] = null
    if (input.replacement) {
      const created = insertUsageEntry(ctx, {
        customerId: entry.customerId,
        usageDate: input.replacement.usageDate,
        line: input.replacement.line,
        batchKey: input.idempotencyKey,
        lineNo: 0,
        replacesEntryId: entry.id,
        source: 'CORRECTION'
      })
      replacement = { id: created.id, reference: created.reference, chargeMinor: created.chargeMinor }
    }
    const currency = getCurrency(ctx)
    writeAudit(ctx, {
      action: replacement ? 'USAGE_CORRECTED' : 'USAGE_REVERSED',
      entityType: 'usage_entry',
      entityId: entry.id,
      summary: replacement
        ? `${entry.txnReference} (${formatMoney(entry.chargeMinor, currency)}) replaced by ${replacement.reference} (${formatMoney(replacement.chargeMinor, currency)})`
        : `${entry.txnReference} reversed by ${reversal.reference}`,
      before: { chargeMinor: entry.chargeMinor, usageDate: entry.usageDate, description: entry.description },
      after: replacement
        ? { replacementEntryId: replacement.id, chargeMinor: replacement.chargeMinor, reversalReference: reversal.reference }
        : { reversalReference: reversal.reference },
      reason: input.reason
    })
    return { reversalReference: reversal.reference, replacement, duplicateRequest: false }
  })
  return run.immediate()
}

export function listUsage(ctx: ServiceContext, raw: UsageListInput = {}): Paged<UsageEntry> & { totalMinor: number } {
  const input = usageListSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (input.from) {
    where.push('u.usage_date >= ?')
    params.push(input.from)
  }
  if (input.to) {
    where.push('u.usage_date <= ?')
    params.push(input.to)
  }
  if (input.customerId) {
    where.push('u.customer_id = ?')
    params.push(input.customerId)
  }
  if (input.categoryId) {
    where.push('u.category_id = ?')
    params.push(input.categoryId)
  }
  if (input.search) {
    const p = likePattern(input.search)
    where.push(
      `(u.description LIKE ? ESCAPE '\\' OR u.notes LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\'
        OR c.customer_code LIKE ? ESCAPE '\\' OR t.reference LIKE ? ESCAPE '\\')`
    )
    params.push(p, p, p, p, p)
  }
  if (!input.includeReversed) where.push('r.id IS NULL')
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { limit, offset } = pageBounds(input.page, input.pageSize)
  const rows = ctx.db
    .prepare(`${USAGE_SELECT} ${whereSql} ORDER BY u.usage_date DESC, u.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as UsageDbRow[]
  const agg = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN r.id IS NULL THEN u.charge_minor ELSE 0 END), 0) AS total
       FROM daily_usage_entries u
       JOIN customers c ON c.id = u.customer_id
       JOIN transactions t ON t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL
       LEFT JOIN transactions r ON r.reverses_txn_id = t.id ${whereSql}`
    )
    .get(...params) as { n: number; total: number }
  return { rows: rows.map(toEntry), total: agg.n, page: input.page, pageSize: input.pageSize, totalMinor: agg.total }
}

export function allUsageEntries(ctx: ServiceContext, raw: UsageListInput = {}): UsageEntry[] {
  const first = listUsage(ctx, { ...raw, page: 1, pageSize: 500 })
  const rows = [...first.rows]
  for (let page = 2; rows.length < first.total; page += 1) {
    rows.push(...listUsage(ctx, { ...raw, page, pageSize: 500 }).rows)
  }
  return rows
}

/** Integer division rounded half away from zero. */
export function divRound(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  const n = BigInt(numerator)
  const d = BigInt(denominator)
  const negative = n < 0n !== d < 0n
  const absN = n < 0n ? -n : n
  const absD = d < 0n ? -d : d
  let q = absN / absD
  if ((absN % absD) * 2n >= absD) q += 1n
  return Number(negative ? -q : q)
}

export function usageSummary(ctx: ServiceContext, raw: z.input<typeof dateRangeSchema>): UsageSummary {
  const range = dateRangeSchema.parse(raw)
  const todayDate = today(ctx)
  const sumUsage = (from: string, to: string) =>
    (
      ctx.db
        .prepare("SELECT COALESCE(SUM(amount_minor), 0) AS s FROM transactions WHERE type = 'USAGE' AND txn_date BETWEEN ? AND ?")
        .get(from, to) as { s: number }
    ).s
  const dailyRows = ctx.db
    .prepare(
      `SELECT txn_date AS d, SUM(amount_minor) AS s FROM transactions
       WHERE type = 'USAGE' AND txn_date BETWEEN ? AND ? GROUP BY txn_date`
    )
    .all(range.from, range.to) as Array<{ d: string; s: number }>
  const dailyMap = new Map(dailyRows.map((r) => [r.d, r.s]))
  const periodTotal = dailyRows.reduce((sum, r) => sum + r.s, 0)
  const dates = eachDate(range.from, range.to)
  const daily = dates.length <= 400 ? dates.map((d) => ({ date: d, amountMinor: dailyMap.get(d) ?? 0 })) : []
  const weeklyMap = new Map<string, number>()
  for (const r of dailyRows) {
    const week = weekStartIso(r.d)
    weeklyMap.set(week, (weeklyMap.get(week) ?? 0) + r.s)
  }
  const monthlyMap = new Map<string, number>()
  for (const r of dailyRows) monthlyMap.set(r.d.slice(0, 7), (monthlyMap.get(r.d.slice(0, 7)) ?? 0) + r.s)

  const byCustomer = ctx.db
    .prepare(
      `SELECT c.id, c.name, c.customer_code, SUM(t.amount_minor) AS s, COUNT(*) AS n
       FROM transactions t JOIN customers c ON c.id = t.customer_id
       WHERE t.type = 'USAGE' AND t.txn_date BETWEEN ? AND ?
       GROUP BY c.id HAVING SUM(t.amount_minor) <> 0 ORDER BY s DESC LIMIT 50`
    )
    .all(range.from, range.to) as Array<{ id: number; name: string; customer_code: string; s: number; n: number }>
  const byCategory = ctx.db
    .prepare(
      `SELECT uc.id, uc.name, SUM(t.amount_minor) AS s, COUNT(*) AS n
       FROM transactions t
       JOIN daily_usage_entries u ON u.id = t.usage_entry_id
       JOIN usage_categories uc ON uc.id = u.category_id
       WHERE t.type = 'USAGE' AND t.txn_date BETWEEN ? AND ?
       GROUP BY uc.id HAVING SUM(t.amount_minor) <> 0 ORDER BY s DESC`
    )
    .all(range.from, range.to) as Array<{ id: number; name: string; s: number; n: number }>

  return {
    range,
    today: todayDate,
    todayTotalMinor: sumUsage(todayDate, todayDate),
    periodTotalMinor: periodTotal,
    averageDailyMinor: divRound(periodTotal, daysBetweenInclusive(range.from, range.to)),
    activeDays: dailyRows.filter((r) => r.s !== 0).length,
    byCustomer: byCustomer.map((r) => ({ id: r.id, name: r.name, customerCode: r.customer_code, amountMinor: r.s, count: r.n })),
    byCategory: byCategory.map((r) => ({ id: r.id, name: r.name, amountMinor: r.s, count: r.n })),
    daily,
    weekly: [...weeklyMap.entries()].sort().map(([weekStart, amountMinor]) => ({ weekStart, amountMinor })),
    monthly: eachMonth(range.from, range.to).map((m) => ({ month: m, amountMinor: monthlyMap.get(m) ?? 0 }))
  }
}
