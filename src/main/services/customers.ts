import { AppError } from '@shared/errors'
import {
  availableCredit,
  balanceEffectSql,
  classifyBalance,
  CUSTOMER_CODE_PREFIX,
  outstandingDue
} from '@shared/finance'
import { eachDate, eachMonth, trailingMonths } from '@shared/dates'
import {
  customerAnalyticsSchema,
  customerCreateSchema,
  customerDuplicateCheckSchema,
  customerListSchema,
  customerSetStatusSchema,
  customerUpdateSchema,
  quickSearchSchema,
  type CustomerCreateInput,
  type CustomerListInput,
  type CustomerUpdateInput
} from '@shared/schemas'
import type {
  CustomerAnalytics,
  CustomerCreateResult,
  CustomerDetail,
  CustomerListResult,
  CustomerSearchHit,
  CustomerSummary,
  PossibleDuplicate
} from '@shared/types'
import type { z } from 'zod'
import {
  blankToNull,
  currentActor,
  formatReference,
  likePattern,
  nextSequence,
  normalizePhone,
  nowIso,
  pageBounds,
  writeAudit,
  type ServiceContext
} from './context'
import { CUSTOMER_TOTALS_SQL, getCustomerRow, insertLedgerEntry, balanceBefore, type CustomerRow } from './ledger-core'

interface CustomerAggRow extends CustomerRow {
  opening_minor: number
  received_minor: number
  paid_minor: number
  usage_minor: number
  credit_adj_minor: number
  debit_adj_minor: number
  balance_minor: number
  last_txn_date: string | null
  txn_count: number
}

const CUSTOMER_SELECT = `
  SELECT c.*,
    COALESCE(a.opening_minor, 0) AS opening_minor,
    COALESCE(a.received_minor, 0) AS received_minor,
    COALESCE(a.paid_minor, 0) AS paid_minor,
    COALESCE(a.usage_minor, 0) AS usage_minor,
    COALESCE(a.credit_adj_minor, 0) AS credit_adj_minor,
    COALESCE(a.debit_adj_minor, 0) AS debit_adj_minor,
    COALESCE(a.balance_minor, 0) AS balance_minor,
    a.last_txn_date AS last_txn_date,
    COALESCE(a.txn_count, 0) AS txn_count
  FROM customers c
  LEFT JOIN (${CUSTOMER_TOTALS_SQL}) a ON a.customer_id = c.id`

function toSummary(row: CustomerAggRow): CustomerSummary {
  return {
    id: row.id,
    customerCode: row.customer_code,
    name: row.name,
    phone: row.phone,
    email: row.email,
    status: row.status,
    registrationDate: row.registration_date,
    openingMinor: row.opening_minor,
    receivedMinor: row.received_minor,
    paidMinor: row.paid_minor,
    usageMinor: row.usage_minor,
    creditAdjustmentsMinor: row.credit_adj_minor,
    debitAdjustmentsMinor: row.debit_adj_minor,
    balanceMinor: row.balance_minor,
    balanceStatus: classifyBalance(row.balance_minor),
    lastTxnDate: row.last_txn_date
  }
}

function toDetail(row: CustomerAggRow): CustomerDetail {
  return {
    ...toSummary(row),
    address: row.address,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    outstandingMinor: outstandingDue(row.balance_minor),
    availableCreditMinor: availableCredit(row.balance_minor),
    transactionCount: row.txn_count
  }
}

const SORT_COLUMNS: Record<string, string> = {
  name: 'c.name COLLATE NOCASE',
  code: 'c.customer_code',
  registrationDate: 'c.registration_date',
  balance: 'balance_minor',
  lastTxnDate: 'last_txn_date'
}

export function listCustomers(ctx: ServiceContext, raw: CustomerListInput = {}): CustomerListResult {
  const input = customerListSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (input.search) {
    const digits = input.search.replace(/\D/g, '')
    const clauses = ["c.name LIKE ? ESCAPE '\\'", "c.customer_code LIKE ? ESCAPE '\\'", "c.phone LIKE ? ESCAPE '\\'"]
    params.push(likePattern(input.search), likePattern(input.search), likePattern(input.search))
    if (digits.length >= 3) {
      clauses.push("c.phone_normalized LIKE ? ESCAPE '\\'")
      params.push(likePattern(digits))
    }
    where.push(`(${clauses.join(' OR ')})`)
  }
  if (input.status !== 'ALL') {
    where.push('c.status = ?')
    params.push(input.status)
  }
  if (input.balanceFilter === 'CREDIT') where.push('COALESCE(a.balance_minor, 0) > 0')
  if (input.balanceFilter === 'DUE') where.push('COALESCE(a.balance_minor, 0) < 0')
  if (input.balanceFilter === 'SETTLED') where.push('COALESCE(a.balance_minor, 0) = 0')
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const sort = SORT_COLUMNS[input.sortBy]
  const dir = input.sortDir === 'desc' ? 'DESC' : 'ASC'
  const nulls = input.sortBy === 'lastTxnDate' ? ' NULLS LAST' : ''
  const { limit, offset } = pageBounds(input.page, input.pageSize)

  const rows = ctx.db
    .prepare(`${CUSTOMER_SELECT} ${whereSql} ORDER BY ${sort} ${dir}${nulls}, c.id ${dir} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as CustomerAggRow[]
  const totals = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n,
        COALESCE(SUM(COALESCE(a.balance_minor, 0)), 0) AS balance,
        COALESCE(SUM(CASE WHEN a.balance_minor > 0 THEN a.balance_minor ELSE 0 END), 0) AS credit,
        COALESCE(SUM(CASE WHEN a.balance_minor < 0 THEN -a.balance_minor ELSE 0 END), 0) AS due
       FROM customers c LEFT JOIN (${CUSTOMER_TOTALS_SQL}) a ON a.customer_id = c.id ${whereSql}`
    )
    .get(...params) as { n: number; balance: number; credit: number; due: number }

  return {
    rows: rows.map(toSummary),
    total: totals.n,
    page: input.page,
    pageSize: input.pageSize,
    totals: { customers: totals.n, balanceMinor: totals.balance, creditMinor: totals.credit, dueMinor: totals.due }
  }
}

export function getCustomer(ctx: ServiceContext, id: number): CustomerDetail {
  const row = ctx.db.prepare(`${CUSTOMER_SELECT} WHERE c.id = ?`).get(id) as CustomerAggRow | undefined
  if (!row) throw new AppError('NOT_FOUND', 'Customer not found')
  return toDetail(row)
}

export function findPossibleDuplicates(
  ctx: ServiceContext,
  raw: z.input<typeof customerDuplicateCheckSchema>
): PossibleDuplicate[] {
  const input = customerDuplicateCheckSchema.parse(raw)
  const name = input.name.trim()
  const phone = normalizePhone(input.phone)
  if (!name && !phone) return []
  const rows = ctx.db
    .prepare(
      `SELECT id, customer_code, name, phone, phone_normalized FROM customers
       WHERE (lower(trim(name)) = lower(?) OR (? IS NOT NULL AND phone_normalized = ?))
         AND (? IS NULL OR id <> ?)
       ORDER BY id LIMIT 20`
    )
    .all(name, phone, phone, input.excludeId ?? null, input.excludeId ?? null) as Array<{
    id: number
    customer_code: string
    name: string
    phone: string | null
    phone_normalized: string | null
  }>
  return rows.map((r) => {
    const matchedOn: Array<'name' | 'phone'> = []
    if (r.name.trim().toLowerCase() === name.toLowerCase()) matchedOn.push('name')
    if (phone && r.phone_normalized === phone) matchedOn.push('phone')
    return { id: r.id, customerCode: r.customer_code, name: r.name, phone: r.phone, matchedOn }
  })
}

export function nextCustomerCode(ctx: ServiceContext): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const code = formatReference(CUSTOMER_CODE_PREFIX, nextSequence(ctx, 'CUST'))
    if (!ctx.db.prepare('SELECT 1 FROM customers WHERE customer_code = ?').get(code)) return code
  }
  throw new AppError('INTERNAL', 'Could not allocate a customer code')
}

export interface InsertCustomerOptions {
  source?: 'MANUAL' | 'IMPORT' | 'DEMO'
  importId?: number | null
  customerCode?: string | null
  openingExternalRef?: string | null
}

/** Inserts a customer (and optional opening-balance ledger entry). Caller provides the transaction. */
export function insertCustomer(
  ctx: ServiceContext,
  input: z.output<typeof customerCreateSchema>,
  options: InsertCustomerOptions = {}
): CustomerCreateResult {
  const code = options.customerCode ?? nextCustomerCode(ctx)
  if (options.customerCode && ctx.db.prepare('SELECT 1 FROM customers WHERE customer_code = ?').get(code)) {
    throw new AppError('CONFLICT', `Customer code ${code} already exists`)
  }
  const now = nowIso(ctx)
  const result = ctx.db
    .prepare(
      `INSERT INTO customers (customer_code, name, phone, phone_normalized, email, address, registration_date,
        status, notes, idempotency_key, source, import_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      code,
      input.name.trim(),
      blankToNull(input.phone),
      normalizePhone(input.phone),
      blankToNull(input.email),
      blankToNull(input.address),
      input.registrationDate,
      input.status,
      blankToNull(input.notes),
      input.idempotencyKey,
      options.source ?? 'MANUAL',
      options.importId ?? null,
      currentActor(ctx),
      now,
      now
    )
  const id = Number(result.lastInsertRowid)
  let openingTxnReference: string | null = null
  if (input.openingBalance) {
    const opening = insertLedgerEntry(ctx, {
      customerId: id,
      type: 'OPENING_BALANCE',
      txnDate: input.openingBalance.date,
      amountMinor: input.openingBalance.amountMinor,
      description: input.openingBalance.explanation,
      source: options.source ?? 'MANUAL',
      importId: options.importId ?? null,
      externalRef: options.openingExternalRef ?? null
    })
    openingTxnReference = opening.reference
  }
  writeAudit(ctx, {
    action: 'CUSTOMER_CREATED',
    entityType: 'customer',
    entityId: id,
    summary: `${code} ${input.name.trim()}`,
    after: {
      customerCode: code,
      name: input.name.trim(),
      registrationDate: input.registrationDate,
      status: input.status,
      openingBalanceMinor: input.openingBalance?.amountMinor ?? 0,
      openingTxnReference
    }
  })
  return { id, reference: code, customerCode: code, openingTxnReference, duplicateRequest: false }
}

export function createCustomer(ctx: ServiceContext, raw: CustomerCreateInput): CustomerCreateResult {
  const input = customerCreateSchema.parse(raw)
  const run = ctx.db.transaction((): CustomerCreateResult => {
    const existing = ctx.db
      .prepare('SELECT id, customer_code FROM customers WHERE idempotency_key = ?')
      .get(input.idempotencyKey) as { id: number; customer_code: string } | undefined
    if (existing) {
      const opening = ctx.db
        .prepare("SELECT reference FROM transactions WHERE customer_id = ? AND type = 'OPENING_BALANCE' ORDER BY id LIMIT 1")
        .get(existing.id) as { reference: string } | undefined
      return {
        id: existing.id,
        reference: existing.customer_code,
        customerCode: existing.customer_code,
        openingTxnReference: opening?.reference ?? null,
        duplicateRequest: true
      }
    }
    if (!input.confirmPossibleDuplicate) {
      const matches = findPossibleDuplicates(ctx, { name: input.name, phone: input.phone })
      if (matches.length > 0) {
        throw new AppError(
          'POSSIBLE_DUPLICATE',
          'A customer with the same name or phone number already exists. Review the matches or confirm this is a different customer.',
          { matches }
        )
      }
    }
    return insertCustomer(ctx, input)
  })
  return run.immediate()
}

export function updateCustomer(ctx: ServiceContext, raw: CustomerUpdateInput): CustomerDetail {
  const input = customerUpdateSchema.parse(raw)
  const run = ctx.db.transaction(() => {
    const before = getCustomerRow(ctx, input.id)
    ctx.db
      .prepare(
        `UPDATE customers SET name = ?, phone = ?, phone_normalized = ?, email = ?, address = ?,
          registration_date = ?, notes = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        input.name.trim(),
        blankToNull(input.phone),
        normalizePhone(input.phone),
        blankToNull(input.email),
        blankToNull(input.address),
        input.registrationDate,
        blankToNull(input.notes),
        nowIso(ctx),
        input.id
      )
    const after = getCustomerRow(ctx, input.id)
    const fields = ['name', 'phone', 'email', 'address', 'registration_date', 'notes'] as const
    const changed = fields.filter((f) => before[f] !== after[f])
    if (changed.length > 0) {
      writeAudit(ctx, {
        action: 'CUSTOMER_UPDATED',
        entityType: 'customer',
        entityId: input.id,
        summary: `Changed ${changed.join(', ')}`,
        before: Object.fromEntries(changed.map((f) => [f, before[f]])),
        after: Object.fromEntries(changed.map((f) => [f, after[f]])),
        reason: blankToNull(input.reason)
      })
    }
  })
  run()
  return getCustomer(ctx, input.id)
}

export function setCustomerStatus(ctx: ServiceContext, raw: z.input<typeof customerSetStatusSchema>): CustomerDetail {
  const input = customerSetStatusSchema.parse(raw)
  const run = ctx.db.transaction(() => {
    const before = getCustomerRow(ctx, input.id)
    if (before.status === input.status) return
    ctx.db.prepare('UPDATE customers SET status = ?, updated_at = ? WHERE id = ?').run(input.status, nowIso(ctx), input.id)
    writeAudit(ctx, {
      action: input.status === 'ACTIVE' ? 'CUSTOMER_ACTIVATED' : 'CUSTOMER_DEACTIVATED',
      entityType: 'customer',
      entityId: input.id,
      before: { status: before.status },
      after: { status: input.status },
      reason: blankToNull(input.reason)
    })
  })
  run()
  return getCustomer(ctx, input.id)
}

export function quickSearchCustomers(ctx: ServiceContext, raw: z.input<typeof quickSearchSchema>): CustomerSearchHit[] {
  const input = quickSearchSchema.parse(raw)
  const query = input.query.trim()
  if (!query) {
    const recent = ctx.db
      .prepare(`${CUSTOMER_SELECT} WHERE c.status = 'ACTIVE' ORDER BY a.last_txn_date DESC NULLS LAST, c.name COLLATE NOCASE LIMIT ?`)
      .all(input.limit) as CustomerAggRow[]
    return recent.map(toHit)
  }
  const result = listCustomers(ctx, { search: query, pageSize: input.limit, sortBy: 'name' })
  return result.rows.map((r) => ({
    id: r.id,
    customerCode: r.customerCode,
    name: r.name,
    phone: r.phone,
    status: r.status,
    balanceMinor: r.balanceMinor
  }))
}

function toHit(row: CustomerAggRow): CustomerSearchHit {
  return {
    id: row.id,
    customerCode: row.customer_code,
    name: row.name,
    phone: row.phone,
    status: row.status,
    balanceMinor: row.balance_minor
  }
}

export function customerAnalytics(ctx: ServiceContext, raw: z.input<typeof customerAnalyticsSchema>): CustomerAnalytics {
  const input = customerAnalyticsSchema.parse(raw)
  getCustomerRow(ctx, input.customerId)
  const dailyEffects = ctx.db
    .prepare(
      `SELECT t.txn_date AS d, SUM(${balanceEffectSql('t')}) AS effect FROM transactions t
       WHERE t.customer_id = ? AND t.txn_date BETWEEN ? AND ? GROUP BY t.txn_date`
    )
    .all(input.customerId, input.from, input.to) as Array<{ d: string; effect: number }>
  const effectByDate = new Map(dailyEffects.map((r) => [r.d, r.effect]))
  let running = balanceBefore(ctx, input.customerId, input.from)
  const dates = eachDate(input.from, input.to)
  const balanceSeries: CustomerAnalytics['balanceSeries'] = []
  if (dates.length <= 400) {
    for (const date of dates) {
      running += effectByDate.get(date) ?? 0
      balanceSeries.push({ date, balanceMinor: running })
    }
  } else {
    const months = eachMonth(input.from, input.to)
    const byMonth = new Map<string, number>()
    for (const r of dailyEffects) byMonth.set(r.d.slice(0, 7), (byMonth.get(r.d.slice(0, 7)) ?? 0) + r.effect)
    for (const month of months) {
      running += byMonth.get(month) ?? 0
      balanceSeries.push({ date: `${month}-01`, balanceMinor: running })
    }
  }

  const usageByCategory = ctx.db
    .prepare(
      `SELECT uc.id AS id, uc.name AS name, SUM(t.amount_minor) AS amount, COUNT(*) AS n
       FROM transactions t
       JOIN daily_usage_entries u ON u.id = t.usage_entry_id
       JOIN usage_categories uc ON uc.id = u.category_id
       WHERE t.type = 'USAGE' AND t.customer_id = ? AND t.txn_date BETWEEN ? AND ?
       GROUP BY uc.id HAVING SUM(t.amount_minor) <> 0 ORDER BY amount DESC`
    )
    .all(input.customerId, input.from, input.to) as Array<{ id: number; name: string; amount: number; n: number }>

  const months = trailingMonths(input.to, 12)
  const monthlyRows = ctx.db
    .prepare(
      `SELECT substr(txn_date, 1, 7) AS m,
        SUM(CASE WHEN type = 'RECEIPT' THEN amount_minor ELSE 0 END) AS received,
        SUM(CASE WHEN type = 'PAYOUT' THEN amount_minor ELSE 0 END) AS paid,
        SUM(CASE WHEN type = 'USAGE' THEN amount_minor ELSE 0 END) AS usage
       FROM transactions WHERE customer_id = ? AND substr(txn_date, 1, 7) BETWEEN ? AND ?
       GROUP BY m`
    )
    .all(input.customerId, months[0], months[months.length - 1]) as Array<{
    m: string
    received: number
    paid: number
    usage: number
  }>
  const monthlyMap = new Map(monthlyRows.map((r) => [r.m, r]))
  return {
    balanceSeries,
    usageByCategory: usageByCategory.map((r) => ({ id: r.id, name: r.name, amountMinor: r.amount, count: r.n })),
    monthly: months.map((m) => ({
      month: m,
      receivedMinor: monthlyMap.get(m)?.received ?? 0,
      paidMinor: monthlyMap.get(m)?.paid ?? 0,
      usageMinor: monthlyMap.get(m)?.usage ?? 0
    }))
  }
}
