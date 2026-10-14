/**
 * Database integrity and ledger reconciliation checks. Used by the Backup page,
 * after restores, and by `npm run db:check`.
 */
import { balanceEffectSql, breakdownFromTotals, type TransactionType } from '@shared/finance'
import { auditListSchema } from '@shared/schemas'
import type { AuditEntry, IntegrityReport, Paged } from '@shared/types'
import type { z } from 'zod'
import { nowIso, pageBounds, type ServiceContext } from './context'

export function runIntegrityCheck(ctx: ServiceContext): IntegrityReport {
  const db = ctx.db
  const problems: string[] = []
  const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>
  const sqliteIntegrity = integrityRows.map((r) => r.integrity_check).join('; ')
  if (sqliteIntegrity !== 'ok') problems.push(`SQLite integrity check: ${sqliteIntegrity.slice(0, 500)}`)
  const fk = db.pragma('foreign_key_check') as unknown[]
  if (fk.length) problems.push(`${fk.length} foreign key violation(s)`)

  const unposted = db
    .prepare(
      `SELECT u.id FROM daily_usage_entries u
       WHERE (SELECT COUNT(*) FROM transactions t WHERE t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL) <> 1`
    )
    .all() as Array<{ id: number }>
  if (unposted.length) problems.push(`${unposted.length} usage entr(ies) not posted to the ledger exactly once`)

  const mismatchedUsage = db
    .prepare(
      `SELECT u.id FROM daily_usage_entries u JOIN transactions t ON t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL
       WHERE t.amount_minor <> u.charge_minor OR t.customer_id <> u.customer_id OR t.txn_date <> u.usage_date OR t.type <> 'USAGE'`
    )
    .all() as unknown[]
  if (mismatchedUsage.length) problems.push(`${mismatchedUsage.length} usage posting(s) do not match their usage entry`)

  const badReversals = db
    .prepare(
      `SELECT r.id FROM transactions r JOIN transactions o ON o.id = r.reverses_txn_id
       WHERE r.amount_minor <> -o.amount_minor OR r.type <> o.type OR r.customer_id <> o.customer_id OR o.reverses_txn_id IS NOT NULL`
    )
    .all() as unknown[]
  if (badReversals.length) problems.push(`${badReversals.length} reversal(s) do not mirror their original entry`)

  const badExpenseReversals = db
    .prepare(
      `SELECT r.id FROM business_expenses r JOIN business_expenses o ON o.id = r.reverses_expense_id
       WHERE r.amount_minor <> -o.amount_minor OR o.reverses_expense_id IS NOT NULL`
    )
    .all() as unknown[]
  if (badExpenseReversals.length) problems.push(`${badExpenseReversals.length} expense reversal(s) are inconsistent`)

  const overRefunded = db
    .prepare(
      `SELECT r.reference FROM transactions r
       WHERE r.type = 'RECEIPT' AND r.reverses_txn_id IS NULL AND r.amount_minor < (
         SELECT COALESCE(SUM(p.amount_minor), 0) FROM transactions p
         WHERE p.related_txn_id = r.id AND p.type = 'PAYOUT' AND p.reverses_txn_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.reverses_txn_id = p.id))`
    )
    .all() as Array<{ reference: string }>
  if (overRefunded.length) problems.push(`Receipts refunded more than received: ${overRefunded.map((r) => r.reference).join(', ')}`)

  // Cross-check: SQL balance expression vs. the TypeScript balance rule per customer.
  const perType = db
    .prepare('SELECT customer_id, type, SUM(amount_minor) AS s FROM transactions GROUP BY customer_id, type')
    .all() as Array<{ customer_id: number; type: TransactionType; s: number }>
  const byCustomer = new Map<number, Record<TransactionType, number>>()
  for (const row of perType) {
    const totals =
      byCustomer.get(row.customer_id) ??
      ({ OPENING_BALANCE: 0, RECEIPT: 0, PAYOUT: 0, USAGE: 0, CREDIT_ADJUSTMENT: 0, DEBIT_ADJUSTMENT: 0 } as Record<TransactionType, number>)
    totals[row.type] = row.s
    byCustomer.set(row.customer_id, totals)
  }
  const sqlBalances = db
    .prepare(`SELECT t.customer_id, SUM(${balanceEffectSql('t')}) AS b FROM transactions t GROUP BY t.customer_id`)
    .all() as Array<{ customer_id: number; b: number }>
  const mismatched = sqlBalances.filter((r) => breakdownFromTotals(byCustomer.get(r.customer_id)!).balanceMinor !== r.b)
  if (mismatched.length) problems.push(`${mismatched.length} customer balance(s) disagree between SQL and the balance rule`)

  const multipleOpenings = db
    .prepare(
      `SELECT customer_id FROM transactions t WHERE type = 'OPENING_BALANCE' AND reverses_txn_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.reverses_txn_id = t.id)
       GROUP BY customer_id HAVING COUNT(*) > 1`
    )
    .all() as unknown[]
  if (multipleOpenings.length) problems.push(`${multipleOpenings.length} customer(s) have more than one active opening balance`)

  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return {
    ok: problems.length === 0,
    checkedAt: nowIso(ctx),
    sqliteIntegrity,
    foreignKeyViolations: fk.length,
    problems,
    counts: {
      customers: count('customers'),
      transactions: count('transactions'),
      expenses: count('business_expenses'),
      usageEntries: count('daily_usage_entries'),
      auditEntries: count('audit_logs')
    }
  }
}

export function listAudit(ctx: ServiceContext, raw: z.input<typeof auditListSchema>): Paged<AuditEntry> {
  const input = auditListSchema.parse(raw)
  const where: string[] = []
  const params: unknown[] = []
  if (input.entityType) {
    where.push('entity_type = ?')
    params.push(input.entityType)
  }
  if (input.entityId) {
    where.push('entity_id = ?')
    params.push(input.entityId)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const { limit, offset } = pageBounds(input.page, input.pageSize)
  const rows = ctx.db
    .prepare(`SELECT * FROM audit_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Record<string, string | number | null>>
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_logs ${whereSql}`).get(...params) as { n: number }).n
  return {
    rows: rows.map((r) => ({
      id: r.id as number,
      occurredAt: r.occurred_at as string,
      actor: r.actor as string | null,
      action: r.action as string,
      entityType: r.entity_type as string,
      entityId: r.entity_id as string | null,
      summary: r.summary as string | null,
      reason: r.reason as string | null,
      before: r.before_json ? JSON.parse(r.before_json as string) : null,
      after: r.after_json ? JSON.parse(r.after_json as string) : null
    })),
    total,
    page: input.page,
    pageSize: input.pageSize
  }
}
