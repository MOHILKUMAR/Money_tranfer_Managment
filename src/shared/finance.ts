/**
 * Central financial rules. Every balance in the application — SQL aggregates,
 * running balances and UI summaries — is derived from the definitions in this
 * file. Do not re-implement the sign convention anywhere else.
 *
 * Balance convention "credit-positive-v1":
 *   Closing balance = Opening balance
 *                   + Money received from customer
 *                   − Money paid to customer
 *                   − Daily usage / service charges
 *                   + Credit adjustments
 *                   − Debit adjustments
 *
 *   balance > 0  → customer has credit (funds remaining with the business)
 *   balance = 0  → settled
 *   balance < 0  → customer owes the business
 *
 * Ledger rows store `amount_minor` in the natural direction of their type
 * (positive for normal entries). A reversal row repeats the original type with
 * the negated amount, so per-type totals net out reversals on the reversal date.
 * OPENING_BALANCE may be negative (an opening amount due).
 */
import { assertSafeInteger, sumMinor } from './money'

export const TRANSACTION_TYPES = [
  'OPENING_BALANCE',
  'RECEIPT',
  'PAYOUT',
  'USAGE',
  'CREDIT_ADJUSTMENT',
  'DEBIT_ADJUSTMENT'
] as const

export type TransactionType = (typeof TRANSACTION_TYPES)[number]

export const BALANCE_CONVENTION_ID = 'credit-positive-v1'

/** Sign applied to `amount_minor` when computing a customer's balance. */
export const BALANCE_SIGN: Readonly<Record<TransactionType, 1 | -1>> = Object.freeze({
  OPENING_BALANCE: 1,
  RECEIPT: 1,
  PAYOUT: -1,
  USAGE: -1,
  CREDIT_ADJUSTMENT: 1,
  DEBIT_ADJUSTMENT: -1
})

/** Types that represent an actual recorded movement of cash. */
export const CASH_MOVEMENT_TYPES: ReadonlySet<TransactionType> = new Set(['RECEIPT', 'PAYOUT'])

export const TRANSACTION_TYPE_LABELS: Readonly<Record<TransactionType, string>> = {
  OPENING_BALANCE: 'Opening balance',
  RECEIPT: 'Money received',
  PAYOUT: 'Money paid to customer',
  USAGE: 'Daily usage charge',
  CREDIT_ADJUSTMENT: 'Credit adjustment',
  DEBIT_ADJUSTMENT: 'Debit adjustment'
}

export const REFERENCE_PREFIX: Readonly<Record<TransactionType, string>> = {
  OPENING_BALANCE: 'OPN',
  RECEIPT: 'RCP',
  PAYOUT: 'PAY',
  USAGE: 'USG',
  CREDIT_ADJUSTMENT: 'CRA',
  DEBIT_ADJUSTMENT: 'DRA'
}
export const REVERSAL_PREFIX = 'REV'
export const EXPENSE_PREFIX = 'EXP'
export const CUSTOMER_CODE_PREFIX = 'CUST'

export function isTransactionType(value: unknown): value is TransactionType {
  return typeof value === 'string' && (TRANSACTION_TYPES as readonly string[]).includes(value)
}

/** Signed effect of one ledger row on the customer's balance. */
export function balanceEffect(type: TransactionType, amountMinor: number): number {
  assertSafeInteger(amountMinor)
  return BALANCE_SIGN[type] * amountMinor
}

export interface LedgerAmount {
  type: TransactionType
  amountMinor: number
}

export function computeBalance(entries: Iterable<LedgerAmount>): number {
  const effects: number[] = []
  for (const entry of entries) effects.push(balanceEffect(entry.type, entry.amountMinor))
  return sumMinor(effects)
}

export interface BalanceBreakdown {
  openingMinor: number
  receivedMinor: number
  paidMinor: number
  usageMinor: number
  creditAdjustmentsMinor: number
  debitAdjustmentsMinor: number
  balanceMinor: number
}

export function computeBreakdown(entries: Iterable<LedgerAmount>): BalanceBreakdown {
  const totals: Record<TransactionType, number> = {
    OPENING_BALANCE: 0,
    RECEIPT: 0,
    PAYOUT: 0,
    USAGE: 0,
    CREDIT_ADJUSTMENT: 0,
    DEBIT_ADJUSTMENT: 0
  }
  for (const entry of entries) {
    totals[entry.type] = sumMinor([totals[entry.type], entry.amountMinor])
  }
  return breakdownFromTotals(totals)
}

export function breakdownFromTotals(totals: Record<TransactionType, number>): BalanceBreakdown {
  const balanceMinor = sumMinor(
    TRANSACTION_TYPES.map((type) => balanceEffect(type, totals[type] ?? 0))
  )
  return {
    openingMinor: totals.OPENING_BALANCE ?? 0,
    receivedMinor: totals.RECEIPT ?? 0,
    paidMinor: totals.PAYOUT ?? 0,
    usageMinor: totals.USAGE ?? 0,
    creditAdjustmentsMinor: totals.CREDIT_ADJUSTMENT ?? 0,
    debitAdjustmentsMinor: totals.DEBIT_ADJUSTMENT ?? 0,
    balanceMinor
  }
}

/** Running balance after each entry, in the order given (caller sorts chronologically). */
export function runningBalances(entries: readonly LedgerAmount[], startingBalance = 0): number[] {
  let balance = startingBalance
  return entries.map((entry) => {
    balance = sumMinor([balance, balanceEffect(entry.type, entry.amountMinor)])
    return balance
  })
}

export type BalanceStatus = 'CREDIT' | 'SETTLED' | 'DUE'

export function classifyBalance(balanceMinor: number): BalanceStatus {
  if (balanceMinor > 0) return 'CREDIT'
  if (balanceMinor < 0) return 'DUE'
  return 'SETTLED'
}

/** Amount the customer owes the business (0 when in credit or settled). */
export function outstandingDue(balanceMinor: number): number {
  return balanceMinor < 0 ? -balanceMinor : 0
}

/** Credit the business can pay out without the account going negative. */
export function availableCredit(balanceMinor: number): number {
  return balanceMinor > 0 ? balanceMinor : 0
}

/**
 * Net recorded cash flow = money received from customers − money paid to
 * customers − business expenses. Usage charges, opening balances and
 * adjustments are not cash and are excluded.
 */
export function netCashFlow(input: {
  receivedMinor: number
  paidMinor: number
  expensesMinor: number
}): number {
  return sumMinor([input.receivedMinor, -input.paidMinor, -input.expensesMinor])
}

/**
 * SQL expression for a row's balance effect, generated from BALANCE_SIGN so the
 * database and TypeScript use exactly the same rule.
 */
export function balanceEffectSql(alias = 't'): string {
  const cases = TRANSACTION_TYPES.map(
    (type) => `WHEN '${type}' THEN ${BALANCE_SIGN[type] === 1 ? '' : '-'}${alias}.amount_minor`
  ).join(' ')
  return `(CASE ${alias}.type ${cases} ELSE 0 END)`
}

/** Sort key that places opening balances first within a date. */
export function ledgerOrderSql(alias = 't'): string {
  return `${alias}.txn_date, CASE WHEN ${alias}.type = 'OPENING_BALANCE' THEN 0 ELSE 1 END, ${alias}.id`
}
