/**
 * Low-level ledger primitives shared by the customer, ledger, usage and import
 * services. All writes here must run inside a caller's database transaction.
 */
import { AppError } from '@shared/errors'
import {
  balanceEffectSql,
  breakdownFromTotals,
  REFERENCE_PREFIX,
  REVERSAL_PREFIX,
  type BalanceBreakdown,
  type TransactionType
} from '@shared/finance'
import { currentActor, nextReference, nowIso, type ServiceContext } from './context'
import { getCurrency } from './settings'

export interface CustomerRow {
  id: number
  customer_code: string
  name: string
  phone: string | null
  phone_normalized: string | null
  email: string | null
  address: string | null
  registration_date: string
  status: 'ACTIVE' | 'INACTIVE'
  notes: string | null
  idempotency_key: string | null
  source: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export function getCustomerRow(ctx: ServiceContext, customerId: number): CustomerRow {
  const row = ctx.db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as CustomerRow | undefined
  if (!row) throw new AppError('NOT_FOUND', 'Customer not found')
  return row
}

export interface LedgerInsert {
  customerId: number
  type: TransactionType
  txnDate: string
  amountMinor: number
  description: string
  paymentMethodId?: number | null
  categoryId?: number | null
  usageEntryId?: number | null
  paymentReference?: string | null
  relatedTxnId?: number | null
  reversesTxnId?: number | null
  reason?: string | null
  overrideReason?: string | null
  notes?: string | null
  idempotencyKey?: string | null
  externalRef?: string | null
  source?: 'MANUAL' | 'IMPORT' | 'CORRECTION' | 'DEMO'
  importId?: number | null
  currency?: string
}

export function insertLedgerEntry(ctx: ServiceContext, entry: LedgerInsert): { id: number; reference: string } {
  if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor === 0) {
    throw new AppError('VALIDATION', 'Ledger amount must be a non-zero whole number of minor units')
  }
  const prefix = entry.reversesTxnId ? REVERSAL_PREFIX : REFERENCE_PREFIX[entry.type]
  const reference = nextReference(ctx, prefix)
  const result = ctx.db
    .prepare(
      `INSERT INTO transactions (
        reference, external_ref, idempotency_key, customer_id, type, txn_date, amount_minor, currency,
        payment_method_id, category_id, usage_entry_id, description, payment_reference, related_txn_id,
        reverses_txn_id, reason, override_reason, notes, source, import_id, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      reference,
      entry.externalRef ?? null,
      entry.idempotencyKey ?? null,
      entry.customerId,
      entry.type,
      entry.txnDate,
      entry.amountMinor,
      entry.currency ?? getCurrency(ctx).code,
      entry.paymentMethodId ?? null,
      entry.categoryId ?? null,
      entry.usageEntryId ?? null,
      entry.description,
      entry.paymentReference ?? null,
      entry.relatedTxnId ?? null,
      entry.reversesTxnId ?? null,
      entry.reason ?? null,
      entry.overrideReason ?? null,
      entry.notes ?? null,
      entry.source ?? 'MANUAL',
      entry.importId ?? null,
      currentActor(ctx),
      nowIso(ctx)
    )
  return { id: Number(result.lastInsertRowid), reference }
}

/** SQL fragment: per-customer totals by type plus derived balance. */
export const CUSTOMER_TOTALS_SQL = `
  SELECT t.customer_id AS customer_id,
    SUM(CASE WHEN t.type = 'OPENING_BALANCE' THEN t.amount_minor ELSE 0 END) AS opening_minor,
    SUM(CASE WHEN t.type = 'RECEIPT' THEN t.amount_minor ELSE 0 END) AS received_minor,
    SUM(CASE WHEN t.type = 'PAYOUT' THEN t.amount_minor ELSE 0 END) AS paid_minor,
    SUM(CASE WHEN t.type = 'USAGE' THEN t.amount_minor ELSE 0 END) AS usage_minor,
    SUM(CASE WHEN t.type = 'CREDIT_ADJUSTMENT' THEN t.amount_minor ELSE 0 END) AS credit_adj_minor,
    SUM(CASE WHEN t.type = 'DEBIT_ADJUSTMENT' THEN t.amount_minor ELSE 0 END) AS debit_adj_minor,
    SUM(${balanceEffectSql('t')}) AS balance_minor,
    MAX(t.txn_date) AS last_txn_date,
    COUNT(*) AS txn_count
  FROM transactions t
  GROUP BY t.customer_id`

/**
 * Customer balance breakdown derived from the ledger, optionally only for
 * entries dated on or before `asOf`. The balance is recomputed from the
 * per-type totals with the shared TypeScript rule as a cross-check.
 */
export function customerBreakdown(ctx: ServiceContext, customerId: number, asOf?: string | null): BalanceBreakdown {
  const rows = ctx.db
    .prepare(
      `SELECT type, SUM(amount_minor) AS total FROM transactions
       WHERE customer_id = ? AND (? IS NULL OR txn_date <= ?) GROUP BY type`
    )
    .all(customerId, asOf ?? null, asOf ?? null) as Array<{ type: TransactionType; total: number }>
  const totals = {
    OPENING_BALANCE: 0,
    RECEIPT: 0,
    PAYOUT: 0,
    USAGE: 0,
    CREDIT_ADJUSTMENT: 0,
    DEBIT_ADJUSTMENT: 0
  } as Record<TransactionType, number>
  for (const row of rows) totals[row.type] = row.total
  return breakdownFromTotals(totals)
}

export function customerBalance(ctx: ServiceContext, customerId: number, asOf?: string | null): number {
  return customerBreakdown(ctx, customerId, asOf).balanceMinor
}

/** Balance of all entries strictly before `date`. */
export function balanceBefore(ctx: ServiceContext, customerId: number, date: string): number {
  const row = ctx.db
    .prepare(`SELECT COALESCE(SUM(${balanceEffectSql('t')}), 0) AS b FROM transactions t WHERE t.customer_id = ? AND t.txn_date < ?`)
    .get(customerId, date) as { b: number }
  return row.b
}

export function isReversed(ctx: ServiceContext, txnId: number): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM transactions WHERE reverses_txn_id = ?').get(txnId)
}

/** Net amount already paid out against a receipt (payouts minus their reversals). */
export function refundedAgainstReceipt(ctx: ServiceContext, receiptId: number): number {
  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_minor), 0) AS refunded FROM transactions p
       WHERE p.related_txn_id = ? AND p.type = 'PAYOUT' AND p.reverses_txn_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.reverses_txn_id = p.id)`
    )
    .get(receiptId) as { refunded: number }
  return row.refunded
}
