import { AppError } from '@shared/errors'
import {
  availableCredit,
  balanceEffect,
  balanceEffectSql,
  ledgerOrderSql,
  TRANSACTION_TYPE_LABELS,
  type TransactionType
} from '@shared/finance'
import {
  adjustmentCreateSchema,
  ledgerQuerySchema,
  payoutCreateSchema,
  payoutPreviewSchema,
  receiptCreateSchema,
  reverseTransactionSchema,
  transactionNotesSchema,
  type AdjustmentCreateInput,
  type LedgerQueryInput,
  type PayoutCreateInput,
  type ReceiptCreateInput,
  type ReverseTransactionInput
} from '@shared/schemas'
import type {
  AuditEntry,
  LedgerResult,
  LedgerRow,
  MutationResult,
  PayoutPreview,
  TransactionDetail
} from '@shared/types'
import type { z } from 'zod'
import { blankToNull, likePattern, pageBounds, writeAudit, type ServiceContext } from './context'
import {
  balanceBefore,
  customerBalance,
  getCustomerRow,
  insertLedgerEntry,
  isReversed,
  refundedAgainstReceipt
} from './ledger-core'
import { requireActiveLookup } from './lookups'
import { getCurrency, readSettings } from './settings'
import { formatMoney } from '@shared/money'
import { getUsageEntry } from './usage'

interface LedgerDbRow {
  id: number
  reference: string
  external_ref: string | null
  customer_id: number
  customer_code: string
  customer_name: string
  type: TransactionType
  txn_date: string
  amount_minor: number
  currency: string
  balance_effect: number
  running_balance: number
  payment_method: string | null
  payment_method_id: number | null
  category: string | null
  category_id: number | null
  description: string
  payment_reference: string | null
  notes: string | null
  reason: string | null
  override_reason: string | null
  reverses_txn_id: number | null
  reverses_reference: string | null
  reversed_by_id: number | null
  reversed_by_reference: string | null
  related_txn_id: number | null
  related_reference: string | null
  usage_entry_id: number | null
  source: LedgerRow['source']
  created_at: string
  created_by: string | null
}

/**
 * Running balances are computed with a window over each customer's complete
 * ledger (ordered by date, opening-first, then insertion id), and only then
 * filtered — so filtered views still show the true account balance.
 */
const LEDGER_CTE = `
WITH ledger AS (
  SELECT t.*,
    ${balanceEffectSql('t')} AS balance_effect,
    SUM(${balanceEffectSql('t')}) OVER (
      PARTITION BY t.customer_id ORDER BY ${ledgerOrderSql('t')} ROWS UNBOUNDED PRECEDING
    ) AS running_balance
  FROM transactions t
)
SELECT l.*, c.customer_code AS customer_code, c.name AS customer_name,
  pm.name AS payment_method, tc.name AS category,
  orig.reference AS reverses_reference,
  rev.id AS reversed_by_id, rev.reference AS reversed_by_reference,
  rel.reference AS related_reference
FROM ledger l
JOIN customers c ON c.id = l.customer_id
LEFT JOIN payment_methods pm ON pm.id = l.payment_method_id
LEFT JOIN transaction_categories tc ON tc.id = l.category_id
LEFT JOIN transactions orig ON orig.id = l.reverses_txn_id
LEFT JOIN transactions rev ON rev.reverses_txn_id = l.id
LEFT JOIN transactions rel ON rel.id = l.related_txn_id`

function toLedgerRow(row: LedgerDbRow): LedgerRow {
  return {
    id: row.id,
    reference: row.reference,
    externalRef: row.external_ref,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerName: row.customer_name,
    type: row.type,
    txnDate: row.txn_date,
    amountMinor: row.amount_minor,
    balanceEffectMinor: row.balance_effect,
    runningBalanceMinor: row.running_balance,
    paymentMethod: row.payment_method,
    paymentMethodId: row.payment_method_id,
    category: row.category,
    categoryId: row.category_id,
    description: row.description,
    paymentReference: row.payment_reference,
    notes: row.notes,
    reason: row.reason,
    overrideReason: row.override_reason,
    isReversal: row.reverses_txn_id !== null,
    reversesTxnId: row.reverses_txn_id,
    reversesReference: row.reverses_reference,
    reversedByTxnId: row.reversed_by_id,
    reversedByReference: row.reversed_by_reference,
    relatedTxnId: row.related_txn_id,
    relatedReference: row.related_reference,
    usageEntryId: row.usage_entry_id,
    source: row.source,
    createdAt: row.created_at,
    createdBy: row.created_by
  }
}

function buildLedgerFilter(input: z.output<typeof ledgerQuerySchema>): { sql: string; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (input.customerId) {
    where.push('l.customer_id = ?')
    params.push(input.customerId)
  }
  if (input.from) {
    where.push('l.txn_date >= ?')
    params.push(input.from)
  }
  if (input.to) {
    where.push('l.txn_date <= ?')
    params.push(input.to)
  }
  if (input.types && input.types.length > 0) {
    where.push(`l.type IN (${input.types.map(() => '?').join(', ')})`)
    params.push(...input.types)
  }
  if (input.categoryId) {
    where.push('l.category_id = ?')
    params.push(input.categoryId)
  }
  if (input.paymentMethodId) {
    where.push('l.payment_method_id = ?')
    params.push(input.paymentMethodId)
  }
  if (input.search) {
    const p = likePattern(input.search)
    where.push(
      `(l.reference LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\' OR l.notes LIKE ? ESCAPE '\\'
        OR l.payment_reference LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR c.customer_code LIKE ? ESCAPE '\\'
        OR l.external_ref LIKE ? ESCAPE '\\')`
    )
    params.push(p, p, p, p, p, p, p)
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

export function listLedger(ctx: ServiceContext, raw: LedgerQueryInput = {}): LedgerResult {
  const input = ledgerQuerySchema.parse(raw)
  if (input.from && input.to && input.from > input.to) {
    throw new AppError('VALIDATION', 'Start date must be on or before end date')
  }
  const filter = buildLedgerFilter(input)
  const { limit, offset } = pageBounds(input.page, input.pageSize)
  const dir = input.sortDir === 'desc' ? 'DESC' : 'ASC'
  const order = `l.txn_date ${dir}, CASE WHEN l.type = 'OPENING_BALANCE' THEN 0 ELSE 1 END ${dir}, l.id ${dir}`
  const rows = ctx.db
    .prepare(`${LEDGER_CTE} ${filter.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...filter.params, limit, offset) as LedgerDbRow[]
  const totals = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n,
        COALESCE(SUM(CASE WHEN l.type = 'OPENING_BALANCE' THEN l.amount_minor END), 0) AS opening,
        COALESCE(SUM(CASE WHEN l.type = 'RECEIPT' THEN l.amount_minor END), 0) AS received,
        COALESCE(SUM(CASE WHEN l.type = 'PAYOUT' THEN l.amount_minor END), 0) AS paid,
        COALESCE(SUM(CASE WHEN l.type = 'USAGE' THEN l.amount_minor END), 0) AS usage,
        COALESCE(SUM(CASE WHEN l.type = 'CREDIT_ADJUSTMENT' THEN l.amount_minor END), 0) AS credit_adj,
        COALESCE(SUM(CASE WHEN l.type = 'DEBIT_ADJUSTMENT' THEN l.amount_minor END), 0) AS debit_adj,
        COALESCE(SUM(l.balance_effect), 0) AS net
       FROM (SELECT t.*, ${balanceEffectSql('t')} AS balance_effect FROM transactions t) l
       JOIN customers c ON c.id = l.customer_id ${filter.sql}`
    )
    .get(...filter.params) as {
    n: number
    opening: number
    received: number
    paid: number
    usage: number
    credit_adj: number
    debit_adj: number
    net: number
  }

  let periodOpeningMinor: number | null = null
  let periodClosingMinor: number | null = null
  if (input.customerId) {
    periodOpeningMinor = input.from ? balanceBefore(ctx, input.customerId, input.from) : 0
    periodClosingMinor = customerBalance(ctx, input.customerId, input.to ?? null)
  }
  return {
    rows: rows.map(toLedgerRow),
    total: totals.n,
    page: input.page,
    pageSize: input.pageSize,
    totals: {
      openingMinor: totals.opening,
      receivedMinor: totals.received,
      paidMinor: totals.paid,
      usageMinor: totals.usage,
      creditAdjustmentsMinor: totals.credit_adj,
      debitAdjustmentsMinor: totals.debit_adj,
      netEffectMinor: totals.net
    },
    periodOpeningMinor,
    periodClosingMinor
  }
}

/** All ledger rows matching a query, unpaged (for exports). */
export function allLedgerRows(ctx: ServiceContext, raw: LedgerQueryInput = {}): LedgerRow[] {
  const input = ledgerQuerySchema.parse({ ...raw, page: 1, pageSize: 1 })
  const filter = buildLedgerFilter(input)
  const dir = input.sortDir === 'desc' ? 'DESC' : 'ASC'
  const rows = ctx.db
    .prepare(
      `${LEDGER_CTE} ${filter.sql} ORDER BY l.txn_date ${dir}, CASE WHEN l.type = 'OPENING_BALANCE' THEN 0 ELSE 1 END ${dir}, l.id ${dir}`
    )
    .all(...filter.params) as LedgerDbRow[]
  return rows.map(toLedgerRow)
}

export function getLedgerRow(ctx: ServiceContext, txnId: number): LedgerRow {
  const row = ctx.db.prepare(`${LEDGER_CTE} WHERE l.id = ?`).get(txnId) as LedgerDbRow | undefined
  if (!row) throw new AppError('NOT_FOUND', 'Transaction not found')
  return toLedgerRow(row)
}

function reverseBlockReason(ctx: ServiceContext, row: LedgerRow): string | null {
  if (row.isReversal) return 'This entry is itself a reversal and cannot be reversed.'
  if (row.reversedByTxnId) return `Already reversed by ${row.reversedByReference}.`
  if (row.type === 'RECEIPT' && refundedAgainstReceipt(ctx, row.id) > 0) {
    return 'Payouts are linked to this receipt. Reverse the linked payouts first.'
  }
  return null
}

export function getTransactionDetail(ctx: ServiceContext, txnId: number): TransactionDetail {
  const row = getLedgerRow(ctx, txnId)
  const currency = (ctx.db.prepare('SELECT currency FROM transactions WHERE id = ?').get(txnId) as { currency: string })
    .currency
  const linkedPayouts = (
    ctx.db
      .prepare(
        `SELECT p.id, p.reference, p.txn_date, p.amount_minor,
          EXISTS (SELECT 1 FROM transactions r WHERE r.reverses_txn_id = p.id) AS reversed
         FROM transactions p WHERE p.related_txn_id = ? AND p.reverses_txn_id IS NULL ORDER BY p.id`
      )
      .all(txnId) as Array<{ id: number; reference: string; txn_date: string; amount_minor: number; reversed: number }>
  ).map((p) => ({ id: p.id, reference: p.reference, txnDate: p.txn_date, amountMinor: p.amount_minor, reversed: p.reversed === 1 }))
  const audit = listAuditFor(ctx, 'transaction', String(txnId))
  const blocked = reverseBlockReason(ctx, row)
  return {
    ...row,
    currency,
    linkedPayouts,
    usageEntry: row.usageEntryId ? getUsageEntry(ctx, row.usageEntryId) : null,
    audit,
    canReverse: blocked === null,
    reverseBlockedReason: blocked
  }
}

export function listAuditFor(ctx: ServiceContext, entityType: string, entityId: string): AuditEntry[] {
  const rows = ctx.db
    .prepare('SELECT * FROM audit_logs WHERE entity_type = ? AND entity_id = ? ORDER BY id')
    .all(entityType, entityId) as Array<{
    id: number
    occurred_at: string
    actor: string | null
    action: string
    entity_type: string
    entity_id: string | null
    summary: string | null
    reason: string | null
    before_json: string | null
    after_json: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    actor: r.actor,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    summary: r.summary,
    reason: r.reason,
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null
  }))
}

function existingByIdempotencyKey(ctx: ServiceContext, key: string): MutationResult | null {
  const row = ctx.db.prepare('SELECT id, reference FROM transactions WHERE idempotency_key = ?').get(key) as
    | { id: number; reference: string }
    | undefined
  return row ? { id: row.id, reference: row.reference, duplicateRequest: true } : null
}

function validateCategory(ctx: ServiceContext, categoryId: number | null | undefined, appliesTo: 'RECEIPT' | 'PAYOUT' | 'ADJUSTMENT'): number | null {
  if (!categoryId) return null
  const category = requireActiveLookup(ctx, 'transaction_categories', categoryId, 'Category')
  if (category.appliesTo !== 'ANY' && category.appliesTo !== appliesTo) {
    throw new AppError('VALIDATION', `Category "${category.name}" cannot be used for this transaction type`)
  }
  return category.id
}

export function recordReceipt(ctx: ServiceContext, raw: ReceiptCreateInput): MutationResult {
  const input = receiptCreateSchema.parse(raw)
  const run = ctx.db.transaction((): MutationResult => {
    const existing = existingByIdempotencyKey(ctx, input.idempotencyKey)
    if (existing) return existing
    const customer = getCustomerRow(ctx, input.customerId)
    const method = requireActiveLookup(ctx, 'payment_methods', input.paymentMethodId, 'Payment method')
    const categoryId = validateCategory(ctx, input.categoryId, 'RECEIPT')
    const description = blankToNull(input.description) ?? `Money received from ${customer.name}`
    const entry = insertLedgerEntry(ctx, {
      customerId: customer.id,
      type: 'RECEIPT',
      txnDate: input.date,
      amountMinor: input.amountMinor,
      description,
      paymentMethodId: method.id,
      categoryId,
      paymentReference: blankToNull(input.paymentReference),
      notes: blankToNull(input.notes),
      idempotencyKey: input.idempotencyKey
    })
    writeAudit(ctx, {
      action: 'RECEIPT_RECORDED',
      entityType: 'transaction',
      entityId: entry.id,
      summary: `${entry.reference} ${customer.customer_code}`,
      after: { amountMinor: input.amountMinor, date: input.date, paymentMethod: method.name }
    })
    return { ...entry, duplicateRequest: false }
  })
  return run.immediate()
}

export function previewPayout(ctx: ServiceContext, raw: z.input<typeof payoutPreviewSchema>): PayoutPreview {
  const input = payoutPreviewSchema.parse(raw)
  getCustomerRow(ctx, input.customerId)
  const balance = customerBalance(ctx, input.customerId)
  const available = availableCredit(balance)
  const policy = readSettings(ctx).payoutOverdraftPolicy
  let relatedReceipt: PayoutPreview['relatedReceipt'] = null
  let relatedReceiptError: string | null = null
  if (input.relatedTxnId) {
    try {
      relatedReceipt = checkRelatedReceipt(ctx, input.customerId, input.relatedTxnId, input.amountMinor)
    } catch (error) {
      relatedReceiptError = (error as Error).message
      const row = ctx.db
        .prepare("SELECT id, reference, amount_minor FROM transactions WHERE id = ? AND type = 'RECEIPT'")
        .get(input.relatedTxnId) as { id: number; reference: string; amount_minor: number } | undefined
      if (row) {
        const refunded = refundedAgainstReceipt(ctx, row.id)
        relatedReceipt = {
          id: row.id,
          reference: row.reference,
          amountMinor: row.amount_minor,
          alreadyRefundedMinor: refunded,
          refundableMinor: Math.max(0, row.amount_minor - refunded)
        }
      }
    }
  }
  return {
    currentBalanceMinor: balance,
    availableCreditMinor: available,
    balanceAfterMinor: balance - input.amountMinor,
    exceedsCredit: input.amountMinor > available,
    shortfallMinor: Math.max(0, input.amountMinor - available),
    policy,
    relatedReceipt,
    relatedReceiptError
  }
}

function checkRelatedReceipt(
  ctx: ServiceContext,
  customerId: number,
  receiptId: number,
  amountMinor: number
): NonNullable<PayoutPreview['relatedReceipt']> {
  const receipt = ctx.db
    .prepare('SELECT id, reference, customer_id, type, amount_minor, reverses_txn_id FROM transactions WHERE id = ?')
    .get(receiptId) as
    | { id: number; reference: string; customer_id: number; type: string; amount_minor: number; reverses_txn_id: number | null }
    | undefined
  if (!receipt || receipt.type !== 'RECEIPT' || receipt.reverses_txn_id !== null) {
    throw new AppError('VALIDATION', 'The linked transaction must be an original receipt')
  }
  if (receipt.customer_id !== customerId) {
    throw new AppError('VALIDATION', 'The linked receipt belongs to a different customer')
  }
  if (isReversed(ctx, receipt.id)) {
    throw new AppError('VALIDATION', `Receipt ${receipt.reference} has been reversed and cannot be refunded`)
  }
  const refunded = refundedAgainstReceipt(ctx, receipt.id)
  const refundable = receipt.amount_minor - refunded
  if (amountMinor > refundable) {
    const currency = getCurrency(ctx)
    throw new AppError(
      'REFUND_EXCEEDS_RECEIPT',
      `Only ${formatMoney(refundable, currency)} of receipt ${receipt.reference} remains refundable (already refunded: ${formatMoney(refunded, currency)}).`,
      { refundableMinor: refundable, alreadyRefundedMinor: refunded, receiptReference: receipt.reference }
    )
  }
  return {
    id: receipt.id,
    reference: receipt.reference,
    amountMinor: receipt.amount_minor,
    alreadyRefundedMinor: refunded,
    refundableMinor: refundable
  }
}

export function recordPayout(ctx: ServiceContext, raw: PayoutCreateInput): MutationResult {
  const input = payoutCreateSchema.parse(raw)
  const run = ctx.db.transaction((): MutationResult => {
    const existing = existingByIdempotencyKey(ctx, input.idempotencyKey)
    if (existing) return existing
    const customer = getCustomerRow(ctx, input.customerId)
    const method = requireActiveLookup(ctx, 'payment_methods', input.paymentMethodId, 'Payment method')
    const categoryId = validateCategory(ctx, input.categoryId, 'PAYOUT')
    if (input.relatedTxnId) checkRelatedReceipt(ctx, customer.id, input.relatedTxnId, input.amountMinor)

    const balance = customerBalance(ctx, customer.id)
    const available = availableCredit(balance)
    let overrideReason: string | null = null
    if (input.amountMinor > available) {
      const policy = readSettings(ctx).payoutOverdraftPolicy
      const details = { availableMinor: available, shortfallMinor: input.amountMinor - available, balanceMinor: balance }
      if (policy === 'BLOCK') {
        throw new AppError(
          'INSUFFICIENT_CREDIT',
          'The payout exceeds the customer\'s available credit, and overdraft payouts are disabled in Settings.',
          details
        )
      }
      if (!input.override?.confirmed) {
        throw new AppError(
          'OVERRIDE_REQUIRED',
          'The payout exceeds the customer\'s available credit and would leave a negative balance. An authorised override with a reason is required.',
          details
        )
      }
      overrideReason = input.override.reason
    }

    const entry = insertLedgerEntry(ctx, {
      customerId: customer.id,
      type: 'PAYOUT',
      txnDate: input.date,
      amountMinor: input.amountMinor,
      description: `Paid to ${customer.name}: ${input.reason}`.slice(0, 300),
      paymentMethodId: method.id,
      categoryId,
      paymentReference: blankToNull(input.paymentReference),
      relatedTxnId: input.relatedTxnId ?? null,
      reason: input.reason,
      overrideReason,
      notes: blankToNull(input.notes),
      idempotencyKey: input.idempotencyKey
    })
    writeAudit(ctx, {
      action: overrideReason ? 'PAYOUT_RECORDED_WITH_OVERRIDE' : 'PAYOUT_RECORDED',
      entityType: 'transaction',
      entityId: entry.id,
      summary: `${entry.reference} ${customer.customer_code}`,
      after: {
        amountMinor: input.amountMinor,
        date: input.date,
        paymentMethod: method.name,
        balanceBeforeMinor: balance,
        balanceAfterMinor: balance - input.amountMinor
      },
      reason: overrideReason ?? input.reason
    })
    return { ...entry, duplicateRequest: false }
  })
  return run.immediate()
}

export function recordAdjustment(ctx: ServiceContext, raw: AdjustmentCreateInput): MutationResult {
  const input = adjustmentCreateSchema.parse(raw)
  const run = ctx.db.transaction((): MutationResult => {
    const existing = existingByIdempotencyKey(ctx, input.idempotencyKey)
    if (existing) return existing
    const customer = getCustomerRow(ctx, input.customerId)
    const categoryId = validateCategory(ctx, input.categoryId, 'ADJUSTMENT')
    const type: TransactionType = input.direction === 'CREDIT' ? 'CREDIT_ADJUSTMENT' : 'DEBIT_ADJUSTMENT'
    const entry = insertLedgerEntry(ctx, {
      customerId: customer.id,
      type,
      txnDate: input.date,
      amountMinor: input.amountMinor,
      description: `${TRANSACTION_TYPE_LABELS[type]}: ${input.reason}`.slice(0, 300),
      categoryId,
      reason: input.reason,
      notes: blankToNull(input.notes),
      idempotencyKey: input.idempotencyKey
    })
    writeAudit(ctx, {
      action: 'ADJUSTMENT_RECORDED',
      entityType: 'transaction',
      entityId: entry.id,
      summary: `${entry.reference} ${customer.customer_code}`,
      after: { type, amountMinor: input.amountMinor, date: input.date },
      reason: input.reason
    })
    return { ...entry, duplicateRequest: false }
  })
  return run.immediate()
}

/**
 * Posts a reversal: a new ledger row of the same type with the negated amount.
 * The original row is never modified or deleted. By default the reversal is
 * dated on the original's date so date-based reports show the corrected figure.
 */
export function reverseTransactionInTxn(
  ctx: ServiceContext,
  input: z.output<typeof reverseTransactionSchema>,
  options: { source?: 'MANUAL' | 'CORRECTION' } = {}
): MutationResult {
  const existing = existingByIdempotencyKey(ctx, input.idempotencyKey)
  if (existing) return existing
  const original = getLedgerRow(ctx, input.txnId)
  const blocked = reverseBlockReason(ctx, original)
  if (blocked) {
    throw new AppError(original.reversedByTxnId ? 'ALREADY_REVERSED' : 'VALIDATION', blocked)
  }
  const date = input.date ?? original.txnDate
  const entry = insertLedgerEntry(ctx, {
    customerId: original.customerId,
    type: original.type,
    txnDate: date,
    amountMinor: -original.amountMinor,
    description: `Reversal of ${original.reference}: ${original.description}`.slice(0, 300),
    paymentMethodId: original.paymentMethodId,
    categoryId: original.categoryId,
    usageEntryId: original.usageEntryId,
    reversesTxnId: original.id,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    source: options.source ?? 'MANUAL',
    currency: (ctx.db.prepare('SELECT currency FROM transactions WHERE id = ?').get(original.id) as { currency: string })
      .currency
  })
  writeAudit(ctx, {
    action: 'TRANSACTION_REVERSED',
    entityType: 'transaction',
    entityId: original.id,
    summary: `${original.reference} reversed by ${entry.reference}`,
    before: { amountMinor: original.amountMinor, balanceEffectMinor: balanceEffect(original.type, original.amountMinor) },
    after: { reversalReference: entry.reference, reversalDate: date },
    reason: input.reason
  })
  writeAudit(ctx, {
    action: 'REVERSAL_POSTED',
    entityType: 'transaction',
    entityId: entry.id,
    summary: `Reverses ${original.reference}`,
    reason: input.reason
  })
  return { ...entry, duplicateRequest: false }
}

export function reverseTransaction(ctx: ServiceContext, raw: ReverseTransactionInput): MutationResult {
  const input = reverseTransactionSchema.parse(raw)
  return ctx.db.transaction(() => reverseTransactionInTxn(ctx, input)).immediate()
}

export function updateTransactionNotes(ctx: ServiceContext, raw: z.input<typeof transactionNotesSchema>): LedgerRow {
  const input = transactionNotesSchema.parse(raw)
  const run = ctx.db.transaction(() => {
    const before = getLedgerRow(ctx, input.txnId)
    ctx.db
      .prepare('UPDATE transactions SET description = ?, notes = ? WHERE id = ?')
      .run(input.description, blankToNull(input.notes), input.txnId)
    writeAudit(ctx, {
      action: 'TRANSACTION_NOTES_UPDATED',
      entityType: 'transaction',
      entityId: input.txnId,
      before: { description: before.description, notes: before.notes },
      after: { description: input.description, notes: blankToNull(input.notes) },
      reason: blankToNull(input.reason)
    })
  })
  run()
  return getLedgerRow(ctx, input.txnId)
}
