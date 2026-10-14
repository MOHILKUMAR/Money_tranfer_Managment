/**
 * Business expenses are kept in their own table and never touch customer
 * balances. Corrections are reversal rows with a negative amount.
 */
import { AppError } from '@shared/errors'
import { EXPENSE_PREFIX } from '@shared/finance'
import { monthStartIso, trailingMonths, weekStartIso } from '@shared/dates'
import {
  dateRangeSchema,
  expenseCreateSchema,
  expenseListSchema,
  expenseReverseSchema,
  type ExpenseCreateInput,
  type ExpenseListInput
} from '@shared/schemas'
import type { ExpenseListResult, ExpenseRow, ExpenseSummary, MutationResult } from '@shared/types'
import type { z } from 'zod'
import {
  blankToNull,
  currentActor,
  likePattern,
  nextReference,
  nowIso,
  pageBounds,
  today,
  writeAudit,
  type ServiceContext
} from './context'
import { requireActiveLookup } from './lookups'
import { getCurrency } from './settings'

interface ExpenseDbRow {
  id: number
  reference: string
  expense_date: string
  category_id: number
  category: string
  description: string
  amount_minor: number
  payment_method_id: number
  payment_method: string
  payment_reference: string | null
  supplier: string | null
  notes: string | null
  reverses_expense_id: number | null
  reverses_reference: string | null
  reversed_by_reference: string | null
  reason: string | null
  created_at: string
  created_by: string | null
}

const EXPENSE_SELECT = `
  SELECT e.*, ec.name AS category, pm.name AS payment_method,
    o.reference AS reverses_reference, r.reference AS reversed_by_reference
  FROM business_expenses e
  JOIN expense_categories ec ON ec.id = e.category_id
  JOIN payment_methods pm ON pm.id = e.payment_method_id
  LEFT JOIN business_expenses o ON o.id = e.reverses_expense_id
  LEFT JOIN business_expenses r ON r.reverses_expense_id = e.id`

function toRow(row: ExpenseDbRow): ExpenseRow {
  return {
    id: row.id,
    reference: row.reference,
    expenseDate: row.expense_date,
    categoryId: row.category_id,
    category: row.category,
    description: row.description,
    amountMinor: row.amount_minor,
    paymentMethodId: row.payment_method_id,
    paymentMethod: row.payment_method,
    paymentReference: row.payment_reference,
    supplier: row.supplier,
    notes: row.notes,
    isReversal: row.reverses_expense_id !== null,
    reversesExpenseId: row.reverses_expense_id,
    reversesReference: row.reverses_reference,
    reversedByReference: row.reversed_by_reference,
    reason: row.reason,
    createdAt: row.created_at,
    createdBy: row.created_by
  }
}

export function getExpense(ctx: ServiceContext, id: number): ExpenseRow {
  const row = ctx.db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(id) as ExpenseDbRow | undefined
  if (!row) throw new AppError('NOT_FOUND', 'Expense not found')
  return toRow(row)
}

export function insertExpense(
  ctx: ServiceContext,
  input: z.output<typeof expenseCreateSchema>,
  source: 'MANUAL' | 'IMPORT' | 'DEMO' = 'MANUAL'
): MutationResult {
  const category = requireActiveLookup(ctx, 'expense_categories', input.categoryId, 'Expense category')
  const method = requireActiveLookup(ctx, 'payment_methods', input.paymentMethodId, 'Payment method')
  const reference = nextReference(ctx, EXPENSE_PREFIX)
  const result = ctx.db
    .prepare(
      `INSERT INTO business_expenses (reference, idempotency_key, expense_date, category_id, description, amount_minor,
        currency, payment_method_id, payment_reference, supplier, notes, source, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      reference,
      input.idempotencyKey,
      input.date,
      category.id,
      input.description.trim(),
      input.amountMinor,
      getCurrency(ctx).code,
      method.id,
      blankToNull(input.paymentReference),
      blankToNull(input.supplier),
      blankToNull(input.notes),
      source,
      currentActor(ctx),
      nowIso(ctx)
    )
  const id = Number(result.lastInsertRowid)
  writeAudit(ctx, {
    action: 'EXPENSE_RECORDED',
    entityType: 'expense',
    entityId: id,
    summary: `${reference} ${category.name}`,
    after: { amountMinor: input.amountMinor, date: input.date, category: category.name, paymentMethod: method.name }
  })
  return { id, reference, duplicateRequest: false }
}

export function recordExpense(ctx: ServiceContext, raw: ExpenseCreateInput): MutationResult {
  const input = expenseCreateSchema.parse(raw)
  const run = ctx.db.transaction((): MutationResult => {
    const existing = ctx.db
      .prepare('SELECT id, reference FROM business_expenses WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { id: number; reference: string } | undefined
    if (existing) return { ...existing, duplicateRequest: true }
    return insertExpense(ctx, input)
  })
  return run.immediate()
}

export function reverseExpense(ctx: ServiceContext, raw: z.input<typeof expenseReverseSchema>): MutationResult {
  const input = expenseReverseSchema.parse(raw)
  const run = ctx.db.transaction((): MutationResult => {
    const existing = ctx.db
      .prepare('SELECT id, reference FROM business_expenses WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { id: number; reference: string } | undefined
    if (existing) return { ...existing, duplicateRequest: true }
    const original = getExpense(ctx, input.expenseId)
    if (original.isReversal) throw new AppError('VALIDATION', 'A reversal entry cannot itself be reversed')
    if (original.reversedByReference) {
      throw new AppError('ALREADY_REVERSED', `Already reversed by ${original.reversedByReference}`)
    }
    const currency = (
      ctx.db.prepare('SELECT currency FROM business_expenses WHERE id = ?').get(original.id) as { currency: string }
    ).currency
    const reference = nextReference(ctx, EXPENSE_PREFIX)
    const date = input.date ?? original.expenseDate
    const result = ctx.db
      .prepare(
        `INSERT INTO business_expenses (reference, idempotency_key, expense_date, category_id, description, amount_minor,
          currency, payment_method_id, payment_reference, supplier, notes, reverses_expense_id, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reference,
        input.idempotencyKey,
        date,
        original.categoryId,
        `Reversal of ${original.reference}: ${original.description}`.slice(0, 300),
        -original.amountMinor,
        currency,
        original.paymentMethodId,
        original.paymentReference,
        original.supplier,
        null,
        original.id,
        input.reason,
        currentActor(ctx),
        nowIso(ctx)
      )
    const id = Number(result.lastInsertRowid)
    writeAudit(ctx, {
      action: 'EXPENSE_REVERSED',
      entityType: 'expense',
      entityId: original.id,
      summary: `${original.reference} reversed by ${reference}`,
      before: { amountMinor: original.amountMinor },
      after: { reversalReference: reference, reversalDate: date },
      reason: input.reason
    })
    return { id, reference, duplicateRequest: false }
  })
  return run.immediate()
}

function buildFilter(input: z.output<typeof expenseListSchema>): { sql: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (input.from) {
    where.push('e.expense_date >= ?')
    params.push(input.from)
  }
  if (input.to) {
    where.push('e.expense_date <= ?')
    params.push(input.to)
  }
  if (input.categoryId) {
    where.push('e.category_id = ?')
    params.push(input.categoryId)
  }
  if (input.paymentMethodId) {
    where.push('e.payment_method_id = ?')
    params.push(input.paymentMethodId)
  }
  if (input.search) {
    const p = likePattern(input.search)
    where.push(
      `(e.reference LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.supplier LIKE ? ESCAPE '\\'
        OR e.notes LIKE ? ESCAPE '\\' OR e.payment_reference LIKE ? ESCAPE '\\')`
    )
    params.push(p, p, p, p, p)
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

export function listExpenses(ctx: ServiceContext, raw: ExpenseListInput = {}): ExpenseListResult {
  const input = expenseListSchema.parse(raw)
  const filter = buildFilter(input)
  const { limit, offset } = pageBounds(input.page, input.pageSize)
  const rows = ctx.db
    .prepare(`${EXPENSE_SELECT} ${filter.sql} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...filter.params, limit, offset) as ExpenseDbRow[]
  const agg = ctx.db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(e.amount_minor), 0) AS total FROM business_expenses e ${filter.sql}`)
    .get(...filter.params) as { n: number; total: number }
  return { rows: rows.map(toRow), total: agg.n, page: input.page, pageSize: input.pageSize, totalMinor: agg.total }
}

export function allExpenses(ctx: ServiceContext, raw: ExpenseListInput = {}): ExpenseRow[] {
  const input = expenseListSchema.parse({ ...raw, page: 1, pageSize: 1 })
  const filter = buildFilter(input)
  const rows = ctx.db
    .prepare(`${EXPENSE_SELECT} ${filter.sql} ORDER BY e.expense_date, e.id`)
    .all(...filter.params) as ExpenseDbRow[]
  return rows.map(toRow)
}

export function sumExpenses(ctx: ServiceContext, from: string, to: string): number {
  return (
    ctx.db
      .prepare('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM business_expenses WHERE expense_date BETWEEN ? AND ?')
      .get(from, to) as { s: number }
  ).s
}

export function expenseSummary(ctx: ServiceContext, raw: z.input<typeof dateRangeSchema>): ExpenseSummary {
  const range = dateRangeSchema.parse(raw)
  const todayDate = today(ctx)
  const byCategory = ctx.db
    .prepare(
      `SELECT ec.id, ec.name, SUM(e.amount_minor) AS s, COUNT(*) AS n FROM business_expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       WHERE e.expense_date BETWEEN ? AND ? GROUP BY ec.id HAVING SUM(e.amount_minor) <> 0 ORDER BY s DESC`
    )
    .all(range.from, range.to) as Array<{ id: number; name: string; s: number; n: number }>
  const byMethod = ctx.db
    .prepare(
      `SELECT pm.id, pm.name, SUM(e.amount_minor) AS s, COUNT(*) AS n FROM business_expenses e
       JOIN payment_methods pm ON pm.id = e.payment_method_id
       WHERE e.expense_date BETWEEN ? AND ? GROUP BY pm.id HAVING SUM(e.amount_minor) <> 0 ORDER BY s DESC`
    )
    .all(range.from, range.to) as Array<{ id: number; name: string; s: number; n: number }>
  const months = trailingMonths(range.to, 12)
  const monthlyRows = ctx.db
    .prepare(
      `SELECT substr(expense_date, 1, 7) AS m, SUM(amount_minor) AS s FROM business_expenses
       WHERE substr(expense_date, 1, 7) BETWEEN ? AND ? GROUP BY m`
    )
    .all(months[0], months[months.length - 1]) as Array<{ m: string; s: number }>
  const monthlyMap = new Map(monthlyRows.map((r) => [r.m, r.s]))
  return {
    range,
    todayMinor: sumExpenses(ctx, todayDate, todayDate),
    thisWeekMinor: sumExpenses(ctx, weekStartIso(todayDate), todayDate),
    thisMonthMinor: sumExpenses(ctx, monthStartIso(todayDate), todayDate),
    periodTotalMinor: sumExpenses(ctx, range.from, range.to),
    byCategory: byCategory.map((r) => ({ id: r.id, name: r.name, amountMinor: r.s, count: r.n })),
    byPaymentMethod: byMethod.map((r) => ({ id: r.id, name: r.name, amountMinor: r.s, count: r.n })),
    monthlyTrend: months.map((m) => ({ month: m, amountMinor: monthlyMap.get(m) ?? 0 }))
  }
}
