/**
 * CSV import: column mapping, row-by-row validation with duplicate detection,
 * and an all-or-nothing commit inside one database transaction.
 *
 * Rules:
 *  - Nothing is written until the user commits; cancelling leaves data untouched.
 *  - Rows with errors are never imported. If any exist the user must explicitly
 *    choose to skip them, and they are listed in the result.
 *  - Existing customers/transactions are never overwritten. A reference that
 *    already exists with identical details is a DUPLICATE (skipped); with
 *    different details it is an ERROR.
 *  - Reversed entries and reversal rows are SKIPPED as a pair (they net to zero).
 *  - Imported payouts are historical records and bypass the overdraft policy.
 */
import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '@shared/errors'
import { normaliseHeader, stripFormulaGuard } from '@shared/csv'
import { parseFlexibleDate } from '@shared/dates'
import {
  balanceEffect,
  TRANSACTION_TYPE_LABELS,
  TRANSACTION_TYPES,
  type TransactionType
} from '@shared/finance'
import { parseMoney, parseQuantity } from '@shared/money'
import { computeUsageCharge } from '@shared/usage'
import { customerCreateSchema, usageLineSchema, type ImportKind } from '@shared/schemas'
import type {
  ImportCommitResult,
  ImportFieldSpec,
  ImportHistoryItem,
  ImportRowResult,
  ImportRowStatus,
  ImportValidationResult
} from '@shared/types'
import type { z } from 'zod'
import { blankToNull, currentActor, nowIso, today, writeAudit, type ServiceContext } from './context'
import { findPossibleDuplicates, insertCustomer } from './customers'
import { insertLedgerEntry } from './ledger-core'
import { findLookupByName } from './lookups'
import { insertUsageEntry } from './usage'
import { getCurrency } from './settings'

export interface ParsedImportFile {
  kind: ImportKind
  fileName: string
  sha256: string
  headers: string[]
  rows: string[][]
}

export type ImportMapping = Record<string, number | null>

export interface ImportOptions {
  dateFormat: 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd'
}

interface FieldDef extends ImportFieldSpec {
  aliases: string[]
}

export const IMPORT_FIELDS: Record<ImportKind, FieldDef[]> = {
  CUSTOMERS: [
    { key: 'customer_code', label: 'Customer code', required: false, description: 'Existing code to keep (auto-generated if blank)', aliases: ['customer_code', 'code', 'account_number', 'account_no', 'customer_id'] },
    { key: 'name', label: 'Name', required: true, description: 'Full or business name', aliases: ['name', 'customer_name', 'full_name', 'business_name'] },
    { key: 'phone', label: 'Phone', required: false, description: 'Phone number', aliases: ['phone', 'mobile', 'phone_number', 'contact'] },
    { key: 'email', label: 'Email', required: false, description: 'Email address', aliases: ['email', 'email_address'] },
    { key: 'address', label: 'Address', required: false, description: 'Postal address', aliases: ['address'] },
    { key: 'registration_date', label: 'Registration date', required: false, description: 'Defaults to today', aliases: ['registration_date', 'registered', 'joined', 'date'] },
    { key: 'status', label: 'Status', required: false, description: 'Active or Inactive (default Active)', aliases: ['status', 'account_status'] },
    { key: 'notes', label: 'Notes', required: false, description: 'Free-text notes', aliases: ['notes', 'remarks'] },
    { key: 'opening_balance', label: 'Opening balance', required: false, description: 'Positive = credit, negative = amount due', aliases: ['opening_balance', 'opening'] },
    { key: 'opening_balance_date', label: 'Opening balance date', required: false, description: 'Defaults to registration date', aliases: ['opening_balance_date', 'opening_date'] }
  ],
  TRANSACTIONS: [
    { key: 'reference', label: 'Reference', required: false, description: 'Original reference (used for duplicate detection)', aliases: ['reference', 'ref', 'transaction_reference', 'txn_ref', 'original_reference'] },
    { key: 'date', label: 'Date', required: true, description: 'Transaction date', aliases: ['date', 'transaction_date', 'txn_date'] },
    { key: 'customer_code', label: 'Customer code', required: true, description: 'Must match an existing customer', aliases: ['customer_code', 'code', 'account_number', 'customer'] },
    { key: 'type', label: 'Type', required: true, description: 'RECEIPT, PAYOUT, USAGE, CREDIT_ADJUSTMENT, DEBIT_ADJUSTMENT or OPENING_BALANCE', aliases: ['type', 'transaction_type', 'txn_type'] },
    { key: 'amount', label: 'Amount', required: true, description: 'Positive amount (opening balance may be negative)', aliases: ['amount', 'value'] },
    { key: 'payment_method', label: 'Payment method', required: false, description: 'Required for receipts and payouts', aliases: ['payment_method', 'method', 'mode'] },
    { key: 'category', label: 'Category', required: false, description: 'Transaction (or usage) category name', aliases: ['category', 'transaction_category'] },
    { key: 'description', label: 'Description', required: false, description: 'Description', aliases: ['description', 'details', 'narration'] },
    { key: 'payment_reference', label: 'Payment reference', required: false, description: 'Bank/UPI/cheque reference', aliases: ['payment_reference', 'utr', 'cheque_number', 'bank_reference'] },
    { key: 'notes', label: 'Notes', required: false, description: 'Notes', aliases: ['notes', 'remarks'] },
    { key: 'reason', label: 'Reason', required: false, description: 'Reason (payouts/adjustments)', aliases: ['reason'] },
    { key: 'reverses_reference', label: 'Reverses reference', required: false, description: 'Rows that reverse another entry are skipped', aliases: ['reverses_reference', 'reversal_of'] },
    { key: 'reversed_by_reference', label: 'Reversed by reference', required: false, description: 'Rows that were reversed are skipped', aliases: ['reversed_by_reference', 'reversed_by'] }
  ],
  USAGE: [
    { key: 'reference', label: 'Reference', required: false, description: 'Original usage reference (duplicate detection)', aliases: ['reference', 'ref', 'usage_reference'] },
    { key: 'date', label: 'Usage date', required: true, description: 'Date of usage', aliases: ['date', 'usage_date'] },
    { key: 'customer_code', label: 'Customer code', required: true, description: 'Must match an existing customer', aliases: ['customer_code', 'code', 'account_number', 'customer'] },
    { key: 'category', label: 'Usage category', required: true, description: 'Must match a usage category', aliases: ['category', 'usage_category'] },
    { key: 'description', label: 'Description', required: true, description: 'Item or service', aliases: ['description', 'item', 'service'] },
    { key: 'quantity', label: 'Quantity', required: false, description: 'With rate → quantity-based charge', aliases: ['quantity', 'qty'] },
    { key: 'unit', label: 'Unit', required: false, description: 'Unit name', aliases: ['unit', 'uom'] },
    { key: 'rate', label: 'Rate', required: false, description: 'Rate per unit', aliases: ['rate', 'rate_per_unit', 'unit_price'] },
    { key: 'fees', label: 'Fees', required: false, description: 'Additional fees', aliases: ['fees', 'additional_fees', 'fee'] },
    { key: 'discount', label: 'Discount', required: false, description: 'Discount amount', aliases: ['discount'] },
    { key: 'discount_reason', label: 'Discount reason', required: false, description: 'Required when a discount is present', aliases: ['discount_reason'] },
    { key: 'amount', label: 'Charge', required: false, description: 'Final charge (required if no quantity/rate)', aliases: ['charge', 'amount', 'final_charge', 'total'] },
    { key: 'status', label: 'Status', required: false, description: 'Rows marked REVERSED are skipped', aliases: ['status'] },
    { key: 'notes', label: 'Notes', required: false, description: 'Notes', aliases: ['notes', 'remarks'] }
  ]
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function suggestMapping(kind: ImportKind, headers: string[]): ImportMapping {
  const normalised = headers.map(normaliseHeader)
  const used = new Set<number>()
  const mapping: ImportMapping = {}
  for (const field of IMPORT_FIELDS[kind]) {
    let found: number | null = null
    for (const alias of field.aliases) {
      const index = normalised.findIndex((h, i) => h === alias && !used.has(i))
      if (index >= 0) {
        found = index
        break
      }
    }
    if (found !== null) used.add(found)
    mapping[field.key] = found
  }
  return mapping
}

function validateMapping(kind: ImportKind, mapping: ImportMapping, headerCount: number): void {
  const keys = new Set(IMPORT_FIELDS[kind].map((f) => f.key))
  const seen = new Set<number>()
  for (const [key, index] of Object.entries(mapping)) {
    if (!keys.has(key)) throw new AppError('VALIDATION', `Unknown import field "${key}"`)
    if (index === null) continue
    if (index >= headerCount) throw new AppError('VALIDATION', `Column ${index + 1} does not exist in the file`)
    if (seen.has(index)) throw new AppError('VALIDATION', 'Each file column can be mapped to only one field')
    seen.add(index)
  }
  for (const field of IMPORT_FIELDS[kind]) {
    if (field.required && (mapping[field.key] === null || mapping[field.key] === undefined)) {
      throw new AppError('VALIDATION', `Map a column to the required field "${field.label}"`)
    }
  }
}

const TYPE_ALIASES = new Map<string, TransactionType>()
for (const type of TRANSACTION_TYPES) {
  TYPE_ALIASES.set(normaliseHeader(type), type)
  TYPE_ALIASES.set(normaliseHeader(TRANSACTION_TYPE_LABELS[type]), type)
}
for (const [alias, type] of [
  ['receipt', 'RECEIPT'],
  ['received', 'RECEIPT'],
  ['payment_received', 'RECEIPT'],
  ['payout', 'PAYOUT'],
  ['paid', 'PAYOUT'],
  ['refund', 'PAYOUT'],
  ['payment_paid', 'PAYOUT'],
  ['usage', 'USAGE'],
  ['charge', 'USAGE'],
  ['service_charge', 'USAGE'],
  ['credit', 'CREDIT_ADJUSTMENT'],
  ['debit', 'DEBIT_ADJUSTMENT'],
  ['opening', 'OPENING_BALANCE']
] as const) {
  TYPE_ALIASES.set(alias, type)
}

type CustomerPlan = { kind: 'CUSTOMERS'; input: z.output<typeof customerCreateSchema>; customerCode: string | null }
type TransactionPlan = {
  kind: 'TRANSACTIONS'
  reference: string | null
  customerId: number
  type: TransactionType
  date: string
  amountMinor: number
  paymentMethodId: number | null
  categoryId: number | null
  usageCategoryId: number | null
  description: string
  paymentReference: string | null
  notes: string | null
  reason: string | null
}
type UsagePlan = { kind: 'USAGE'; reference: string | null; customerId: number; usageDate: string; line: z.output<typeof usageLineSchema> }
type Plan = CustomerPlan | TransactionPlan | UsagePlan

interface PlannedRow extends ImportRowResult {
  plan: Plan | null
  effectMinor: number
}

interface ValidationState {
  ctx: ServiceContext
  options: ImportOptions
  seenRefs: Map<string, string>
  seenCodes: Set<string>
  seenNamePhone: Set<string>
  openingCustomers: Set<number>
  customerCache: Map<string, { id: number; name: string } | null>
}

function cellGetter(row: string[], mapping: ImportMapping) {
  return (key: string): string => {
    const index = mapping[key]
    if (index === null || index === undefined) return ''
    return stripFormulaGuard((row[index] ?? '').trim())
  }
}

function lookupCustomer(state: ValidationState, code: string): { id: number; name: string } | null {
  const k = code.toLowerCase()
  if (!state.customerCache.has(k)) {
    const row = state.ctx.db.prepare('SELECT id, name FROM customers WHERE customer_code = ? COLLATE NOCASE').get(code) as
      | { id: number; name: string }
      | undefined
    state.customerCache.set(k, row ?? null)
  }
  return state.customerCache.get(k) ?? null
}

function parseDateCell(value: string, state: ValidationState, label: string, messages: string[]): string | null {
  if (!value) return null
  const parsed = parseFlexibleDate(value, state.options.dateFormat)
  if (!parsed) messages.push(`${label} "${value}" is not a valid date (expected ${state.options.dateFormat} or YYYY-MM-DD)`)
  return parsed
}

function parseAmountCell(
  value: string,
  label: string,
  messages: string[],
  minorDigits: number,
  opts: { allowNegative?: boolean; allowZero?: boolean } = {}
): number | null {
  if (!value) return null
  const parsed = parseMoney(value, { minorDigits, ...opts })
  if (!parsed.ok) {
    messages.push(`${label}: ${parsed.error} ("${value}")`)
    return null
  }
  return parsed.value
}

function validateCustomerRow(state: ValidationState, get: (k: string) => string, messages: string[]): { status: ImportRowStatus; plan: CustomerPlan | null; effect: number } {
  const minorDigits = getCurrency(state.ctx).minorDigits
  const code = get('customer_code')
  const name = get('name')
  if (!name) messages.push('Name is required')
  const registrationDate = parseDateCell(get('registration_date'), state, 'Registration date', messages) ?? today(state.ctx)
  const statusRaw = get('status').toUpperCase()
  let status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'
  if (statusRaw === 'INACTIVE') status = 'INACTIVE'
  else if (statusRaw && statusRaw !== 'ACTIVE') messages.push(`Status "${get('status')}" must be Active or Inactive`)
  const opening = parseAmountCell(get('opening_balance'), 'Opening balance', messages, minorDigits, { allowNegative: true, allowZero: true })
  const openingDate = parseDateCell(get('opening_balance_date'), state, 'Opening balance date', messages) ?? registrationDate
  if (code && !/^[A-Za-z0-9_-]{1,30}$/.test(code)) messages.push('Customer code may contain letters, digits, - and _ (max 30)')

  const parsed = customerCreateSchema.safeParse({
    name,
    phone: get('phone') || null,
    email: get('email') || null,
    address: get('address') || null,
    registrationDate,
    status,
    notes: get('notes') || null,
    openingBalance: opening ? { amountMinor: opening, date: openingDate, explanation: 'Opening balance (CSV import)' } : null,
    idempotencyKey: randomUUID()
  })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const msg = `${issue.path.join('.') || 'Row'}: ${issue.message}`
      if (!messages.includes(msg) && !(issue.path[0] === 'name' && !name)) messages.push(msg)
    }
  }
  if (messages.length > 0 || !parsed.success) return { status: 'ERROR', plan: null, effect: 0 }

  if (code) {
    if (state.seenCodes.has(code.toLowerCase())) {
      messages.push(`Customer code ${code} appears more than once in the file`)
      return { status: 'ERROR', plan: null, effect: 0 }
    }
    state.seenCodes.add(code.toLowerCase())
    const existing = lookupCustomer(state, code)
    if (existing) {
      if (existing.name.trim().toLowerCase() === name.trim().toLowerCase()) {
        messages.push(`Customer ${code} already exists — not overwritten`)
        return { status: 'DUPLICATE', plan: null, effect: 0 }
      }
      messages.push(`Customer code ${code} already belongs to "${existing.name}"`)
      return { status: 'ERROR', plan: null, effect: 0 }
    }
  }
  const plan: CustomerPlan = { kind: 'CUSTOMERS', input: parsed.data, customerCode: code || null }
  const namePhoneKey = `${name.trim().toLowerCase()}|${(get('phone') || '').replace(/\D/g, '').slice(-10)}`
  const matches = findPossibleDuplicates(state.ctx, { name, phone: get('phone') || null })
  if (matches.length > 0) {
    messages.push(`Possible duplicate of ${matches.map((m) => `${m.customerCode} ${m.name}`).join(', ')}`)
    return { status: 'POSSIBLE_DUPLICATE', plan, effect: opening ?? 0 }
  }
  if (state.seenNamePhone.has(namePhoneKey)) {
    messages.push('Same name and phone as an earlier row in this file')
    return { status: 'POSSIBLE_DUPLICATE', plan, effect: opening ?? 0 }
  }
  state.seenNamePhone.add(namePhoneKey)
  return { status: 'VALID', plan, effect: opening ?? 0 }
}

function findExistingByRef(state: ValidationState, ref: string) {
  const sql = `SELECT id, customer_id, type, txn_date, amount_minor FROM transactions WHERE %COL% = ? LIMIT 1`
  return (state.ctx.db.prepare(sql.replace('%COL%', 'external_ref')).get(ref) ??
    state.ctx.db.prepare(sql.replace('%COL%', 'reference')).get(ref)) as
    | { id: number; customer_id: number; type: TransactionType; txn_date: string; amount_minor: number }
    | undefined
}

function checkReference(
  state: ValidationState,
  ref: string,
  fingerprint: { customerId: number; type: TransactionType; date: string; amountMinor: number },
  messages: string[]
): ImportRowStatus | null {
  const fp = `${fingerprint.customerId}|${fingerprint.type}|${fingerprint.date}|${fingerprint.amountMinor}`
  const seen = state.seenRefs.get(ref.toLowerCase())
  if (seen !== undefined) {
    if (seen === fp) {
      messages.push(`Reference ${ref} repeats an earlier row in this file`)
      return 'DUPLICATE'
    }
    messages.push(`Reference ${ref} is used by another row in this file with different details`)
    return 'ERROR'
  }
  state.seenRefs.set(ref.toLowerCase(), fp)
  const existing = findExistingByRef(state, ref)
  if (!existing) return null
  if (
    existing.customer_id === fingerprint.customerId &&
    existing.type === fingerprint.type &&
    existing.txn_date === fingerprint.date &&
    existing.amount_minor === fingerprint.amountMinor
  ) {
    messages.push(`Reference ${ref} is already recorded — skipped`)
    return 'DUPLICATE'
  }
  messages.push(`Reference ${ref} already exists with different details; it will not be overwritten`)
  return 'ERROR'
}

function validateTransactionRow(state: ValidationState, get: (k: string) => string, messages: string[]): { status: ImportRowStatus; plan: TransactionPlan | null; effect: number } {
  if (get('reverses_reference') || get('reversed_by_reference')) {
    messages.push('Reversed entry or reversal — skipped (the pair nets to zero)')
    return { status: 'SKIPPED', plan: null, effect: 0 }
  }
  const minorDigits = getCurrency(state.ctx).minorDigits
  const ref = get('reference')
  const date = parseDateCell(get('date'), state, 'Date', messages)
  if (!get('date')) messages.push('Date is required')
  const code = get('customer_code')
  const customer = code ? lookupCustomer(state, code) : null
  if (!code) messages.push('Customer code is required')
  else if (!customer) messages.push(`Customer ${code} does not exist (import customers first)`)
  const typeRaw = get('type')
  const type = TYPE_ALIASES.get(normaliseHeader(typeRaw))
  if (!type) messages.push(`Type "${typeRaw}" is not recognised`)
  const amountRaw = get('amount')
  if (!amountRaw) messages.push('Amount is required')
  const amount = parseAmountCell(amountRaw, 'Amount', messages, minorDigits, { allowNegative: type === 'OPENING_BALANCE' })

  let paymentMethodId: number | null = null
  const methodName = get('payment_method')
  if (methodName) {
    const method = findLookupByName(state.ctx, 'payment_methods', methodName)
    if (!method) messages.push(`Payment method "${methodName}" does not exist`)
    else if (!method.isActive) messages.push(`Payment method "${methodName}" is inactive`)
    else paymentMethodId = method.id
  } else if (type === 'RECEIPT' || type === 'PAYOUT') {
    messages.push('Payment method is required for receipts and payouts')
  }

  let categoryId: number | null = null
  let usageCategoryId: number | null = null
  const categoryName = get('category')
  if (type === 'USAGE') {
    const cat = categoryName
      ? findLookupByName(state.ctx, 'usage_categories', categoryName)
      : findLookupByName(state.ctx, 'usage_categories', 'Other usage')
    if (!cat || !cat.isActive) messages.push(`Usage category "${categoryName || 'Other usage'}" does not exist or is inactive`)
    else usageCategoryId = cat.id
  } else if (categoryName && type && type !== 'OPENING_BALANCE') {
    const cat = findLookupByName(state.ctx, 'transaction_categories', categoryName)
    const applies = type === 'RECEIPT' ? 'RECEIPT' : type === 'PAYOUT' ? 'PAYOUT' : 'ADJUSTMENT'
    if (!cat || !cat.isActive) messages.push(`Category "${categoryName}" does not exist or is inactive`)
    else if (cat.appliesTo !== 'ANY' && cat.appliesTo !== applies) messages.push(`Category "${categoryName}" does not apply to ${type}`)
    else categoryId = cat.id
  }
  if (type === 'OPENING_BALANCE' && customer) {
    const hasOpening = state.ctx.db
      .prepare(
        `SELECT 1 FROM transactions t WHERE t.customer_id = ? AND t.type = 'OPENING_BALANCE' AND t.reverses_txn_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.reverses_txn_id = t.id)`
      )
      .get(customer.id)
    if (hasOpening || state.openingCustomers.has(customer.id)) messages.push(`Customer ${code} already has an opening balance`)
  }
  if (messages.length > 0 || !type || !date || !customer || amount === null) return { status: 'ERROR', plan: null, effect: 0 }

  const description =
    get('description') || `${TRANSACTION_TYPE_LABELS[type]} (CSV import)`
  if (description.length > 300) {
    messages.push('Description is longer than 300 characters')
    return { status: 'ERROR', plan: null, effect: 0 }
  }
  const plan: TransactionPlan = {
    kind: 'TRANSACTIONS',
    reference: ref || null,
    customerId: customer.id,
    type,
    date,
    amountMinor: amount,
    paymentMethodId,
    categoryId,
    usageCategoryId,
    description,
    paymentReference: blankToNull(get('payment_reference')),
    notes: blankToNull(get('notes')),
    reason: blankToNull(get('reason'))
  }
  const effect = balanceEffect(type, amount)
  if (ref) {
    const refStatus = checkReference(state, ref, { customerId: customer.id, type, date, amountMinor: amount }, messages)
    if (refStatus) return { status: refStatus, plan: null, effect: 0 }
  } else {
    const similar = state.ctx.db
      .prepare(
        'SELECT reference FROM transactions WHERE customer_id = ? AND type = ? AND txn_date = ? AND amount_minor = ? AND reverses_txn_id IS NULL LIMIT 1'
      )
      .get(customer.id, type, date, amount) as { reference: string } | undefined
    if (similar) {
      messages.push(`Same customer, type, date and amount as existing ${similar.reference}`)
      if (type === 'OPENING_BALANCE') state.openingCustomers.add(customer.id)
      return { status: 'POSSIBLE_DUPLICATE', plan, effect }
    }
  }
  if (type === 'OPENING_BALANCE') state.openingCustomers.add(customer.id)
  return { status: 'VALID', plan, effect }
}

function validateUsageRow(state: ValidationState, get: (k: string) => string, messages: string[]): { status: ImportRowStatus; plan: UsagePlan | null; effect: number } {
  if (get('status').toUpperCase() === 'REVERSED') {
    messages.push('Entry is marked REVERSED — skipped')
    return { status: 'SKIPPED', plan: null, effect: 0 }
  }
  const minorDigits = getCurrency(state.ctx).minorDigits
  const ref = get('reference')
  const date = parseDateCell(get('date'), state, 'Usage date', messages)
  if (!get('date')) messages.push('Usage date is required')
  const code = get('customer_code')
  const customer = code ? lookupCustomer(state, code) : null
  if (!code) messages.push('Customer code is required')
  else if (!customer) messages.push(`Customer ${code} does not exist (import customers first)`)
  const categoryName = get('category')
  const category = categoryName ? findLookupByName(state.ctx, 'usage_categories', categoryName) : null
  if (!categoryName) messages.push('Usage category is required')
  else if (!category || !category.isActive) messages.push(`Usage category "${categoryName}" does not exist or is inactive`)
  const description = get('description')
  if (!description) messages.push('Description is required')
  const unitName = get('unit')
  const unit = unitName ? findLookupByName(state.ctx, 'usage_units', unitName) : null
  if (unitName && (!unit || !unit.isActive)) messages.push(`Unit "${unitName}" does not exist or is inactive`)

  const quantityRaw = get('quantity')
  const rateRaw = get('rate')
  let quantityMilli: number | null = null
  if (quantityRaw) {
    const q = parseQuantity(quantityRaw)
    if (!q.ok) messages.push(`Quantity: ${q.error}`)
    else quantityMilli = q.value
  }
  const rate = rateRaw ? parseAmountCell(rateRaw, 'Rate', messages, minorDigits, { allowZero: true }) : null
  const fees = parseAmountCell(get('fees'), 'Fees', messages, minorDigits, { allowZero: true }) ?? 0
  const discount = parseAmountCell(get('discount'), 'Discount', messages, minorDigits, { allowZero: true }) ?? 0
  const amount = parseAmountCell(get('amount'), 'Charge', messages, minorDigits)
  const discountReason = get('discount_reason')
  if (discount > 0 && !discountReason) messages.push('Discount reason is required when a discount is present')
  const quantityBased = quantityMilli !== null && rate !== null
  if ((quantityRaw && !rateRaw) || (!quantityRaw && rateRaw)) messages.push('Provide both quantity and rate, or neither')
  if (!quantityBased && amount === null && !(quantityRaw || rateRaw)) messages.push('Provide quantity and rate, or a charge amount')
  if (messages.length > 0 || !customer || !category || !date) return { status: 'ERROR', plan: null, effect: 0 }

  const lineInput = quantityBased
    ? { categoryId: category.id, description, method: 'QUANTITY' as const, quantityMilli, unitId: unit?.id ?? null, rateMinor: rate, feesMinor: fees, discountMinor: discount, discountReason: discountReason || null, notes: get('notes') || null }
    : { categoryId: category.id, description, method: 'FIXED' as const, fixedAmountMinor: amount === null ? null : amount + discount - fees, fixedReason: 'Imported from CSV', unitId: unit?.id ?? null, feesMinor: fees, discountMinor: discount, discountReason: discountReason || null, notes: get('notes') || null }
  const parsedLine = usageLineSchema.safeParse(lineInput)
  if (!parsedLine.success) {
    for (const issue of parsedLine.error.issues) messages.push(`${issue.path.join('.')}: ${issue.message}`)
    return { status: 'ERROR', plan: null, effect: 0 }
  }
  const charge = computeUsageCharge(parsedLine.data)
  if (!charge.ok) {
    messages.push(charge.error)
    return { status: 'ERROR', plan: null, effect: 0 }
  }
  if (quantityBased && amount !== null && amount !== charge.value.chargeMinor) {
    messages.push(`Charge ${get('amount')} does not equal quantity × rate + fees − discount`)
    return { status: 'ERROR', plan: null, effect: 0 }
  }
  const plan: UsagePlan = { kind: 'USAGE', reference: ref || null, customerId: customer.id, usageDate: date, line: parsedLine.data }
  const effect = -charge.value.chargeMinor
  if (ref) {
    const refStatus = checkReference(state, ref, { customerId: customer.id, type: 'USAGE', date, amountMinor: charge.value.chargeMinor }, messages)
    if (refStatus) return { status: refStatus, plan: null, effect: 0 }
  } else {
    const similar = state.ctx.db
      .prepare(
        `SELECT t.reference FROM daily_usage_entries u JOIN transactions t ON t.usage_entry_id = u.id AND t.reverses_txn_id IS NULL
         WHERE u.customer_id = ? AND u.usage_date = ? AND u.charge_minor = ? AND lower(u.description) = lower(?) LIMIT 1`
      )
      .get(customer.id, date, charge.value.chargeMinor, description) as { reference: string } | undefined
    if (similar) {
      messages.push(`Same customer, date, description and charge as existing ${similar.reference}`)
      return { status: 'POSSIBLE_DUPLICATE', plan, effect }
    }
  }
  return { status: 'VALID', plan, effect }
}

function planRows(ctx: ServiceContext, file: ParsedImportFile, mapping: ImportMapping, options: ImportOptions): PlannedRow[] {
  validateMapping(file.kind, mapping, file.headers.length)
  const state: ValidationState = {
    ctx,
    options,
    seenRefs: new Map(),
    seenCodes: new Set(),
    seenNamePhone: new Set(),
    openingCustomers: new Set(),
    customerCache: new Map()
  }
  return file.rows.map((row, index) => {
    const get = cellGetter(row, mapping)
    const messages: string[] = []
    const preview: Record<string, string> = {}
    for (const field of IMPORT_FIELDS[file.kind]) {
      const value = get(field.key)
      if (value) preview[field.key] = value.slice(0, 120)
    }
    const isBlank = row.every((cell) => cell.trim() === '')
    if (isBlank) {
      return { rowNumber: index + 2, status: 'SKIPPED' as const, messages: ['Blank row'], preview, plan: null, effectMinor: 0 }
    }
    const result =
      file.kind === 'CUSTOMERS'
        ? validateCustomerRow(state, get, messages)
        : file.kind === 'TRANSACTIONS'
          ? validateTransactionRow(state, get, messages)
          : validateUsageRow(state, get, messages)
    return { rowNumber: index + 2, status: result.status, messages, preview, plan: result.plan, effectMinor: result.effect }
  })
}

function previousImportOf(ctx: ServiceContext, sha256: string): string | null {
  const row = ctx.db
    .prepare("SELECT created_at FROM csv_import_history WHERE file_sha256 = ? AND status = 'COMPLETED' ORDER BY id DESC LIMIT 1")
    .get(sha256) as { created_at: string } | undefined
  return row?.created_at ?? null
}

export function validateImport(
  ctx: ServiceContext,
  file: ParsedImportFile,
  mapping: ImportMapping,
  options: ImportOptions
): ImportValidationResult {
  const rows = planRows(ctx, file, mapping, options)
  const count = (s: ImportRowStatus) => rows.filter((r) => r.status === s).length
  return {
    sessionId: '',
    kind: file.kind,
    totalRows: rows.length,
    validRows: count('VALID'),
    duplicateRows: count('DUPLICATE'),
    possibleDuplicateRows: count('POSSIBLE_DUPLICATE'),
    skippedRows: count('SKIPPED'),
    errorRows: count('ERROR'),
    financialTotalMinor: rows.filter((r) => r.status === 'VALID').reduce((s, r) => s + r.effectMinor, 0),
    sameFileImportedAt: previousImportOf(ctx, file.sha256),
    rows: rows.map(({ rowNumber, status, messages, preview }) => ({ rowNumber, status, messages, preview }))
  }
}

export interface CommitOptions extends ImportOptions {
  confirmFinancial: boolean
  skipInvalidRows: boolean
  importPossibleDuplicates: boolean
}

export function commitImport(ctx: ServiceContext, file: ParsedImportFile, mapping: ImportMapping, options: CommitOptions): ImportCommitResult {
  const run = ctx.db.transaction((): ImportCommitResult => {
    const rows = planRows(ctx, file, mapping, options)
    const errors = rows.filter((r) => r.status === 'ERROR')
    if (errors.length > 0 && !options.skipInvalidRows) {
      throw new AppError('IMPORT_HAS_ERRORS', `${errors.length} row(s) have errors. Fix them or choose to skip invalid rows.`)
    }
    const toImport = rows.filter(
      (r) => r.plan && (r.status === 'VALID' || (r.status === 'POSSIBLE_DUPLICATE' && options.importPossibleDuplicates))
    )
    const financial =
      file.kind !== 'CUSTOMERS' ||
      toImport.some((r) => r.plan?.kind === 'CUSTOMERS' && r.plan.input.openingBalance)
    if (financial && !options.confirmFinancial) {
      throw new AppError('VALIDATION', 'Confirm that you want to import financial records before continuing.')
    }
    const duplicates = rows.filter((r) => r.status === 'DUPLICATE').length
    const skippedPossible = rows.filter((r) => r.status === 'POSSIBLE_DUPLICATE').length - (options.importPossibleDuplicates ? toImport.filter((r) => r.status === 'POSSIBLE_DUPLICATE').length : 0)
    const skipped = rows.filter((r) => r.status === 'SKIPPED').length
    const history = ctx.db
      .prepare(
        `INSERT INTO csv_import_history (import_kind, file_name, file_sha256, total_rows, imported_rows, skipped_duplicate_rows,
          failed_rows, status, summary_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)`
      )
      .run(
        file.kind,
        file.fileName,
        file.sha256,
        rows.length,
        toImport.length,
        duplicates + skippedPossible,
        errors.length,
        JSON.stringify({ skippedRows: skipped, skippedPossibleDuplicates: skippedPossible, failures: errors.slice(0, 200).map((e) => ({ row: e.rowNumber, messages: e.messages })) }),
        currentActor(ctx),
        nowIso(ctx)
      )
    const importId = Number(history.lastInsertRowid)
    for (const row of toImport) {
      const plan = row.plan!
      if (plan.kind === 'CUSTOMERS') {
        insertCustomer(ctx, plan.input, { source: 'IMPORT', importId, customerCode: plan.customerCode })
      } else if (plan.kind === 'TRANSACTIONS') {
        if (plan.type === 'USAGE') {
          insertUsageEntry(ctx, {
            customerId: plan.customerId,
            usageDate: plan.date,
            line: usageLineSchema.parse({
              categoryId: plan.usageCategoryId,
              description: plan.description,
              method: 'FIXED',
              fixedAmountMinor: plan.amountMinor,
              fixedReason: 'Imported from CSV',
              notes: plan.notes
            }),
            batchKey: `import-${importId}`,
            lineNo: row.rowNumber,
            source: 'IMPORT',
            importId,
            externalRef: plan.reference
          })
        } else {
          insertLedgerEntry(ctx, {
            customerId: plan.customerId,
            type: plan.type,
            txnDate: plan.date,
            amountMinor: plan.amountMinor,
            description: plan.description,
            paymentMethodId: plan.paymentMethodId,
            categoryId: plan.categoryId,
            paymentReference: plan.paymentReference,
            notes: plan.notes,
            reason: plan.reason ?? (plan.type === 'PAYOUT' ? 'Imported historical payout' : null),
            externalRef: plan.reference,
            source: 'IMPORT',
            importId
          })
        }
      } else {
        insertUsageEntry(ctx, {
          customerId: plan.customerId,
          usageDate: plan.usageDate,
          line: plan.line,
          batchKey: `import-${importId}`,
          lineNo: row.rowNumber,
          source: 'IMPORT',
          importId,
          externalRef: plan.reference
        })
      }
    }
    writeAudit(ctx, {
      action: 'CSV_IMPORTED',
      entityType: 'csv_import',
      entityId: importId,
      summary: `${file.kind}: ${toImport.length} imported, ${duplicates} duplicates, ${errors.length} failed (${file.fileName})`
    })
    return {
      importId,
      importedRows: toImport.length,
      skippedDuplicateRows: duplicates,
      skippedPossibleDuplicateRows: skippedPossible,
      skippedRows: skipped,
      failedRows: errors.length,
      failures: errors.map((e) => ({ rowNumber: e.rowNumber, messages: e.messages }))
    }
  })
  try {
    return run.immediate()
  } catch (error) {
    if (!(error instanceof AppError && (error.code === 'IMPORT_HAS_ERRORS' || error.code === 'VALIDATION'))) {
      ctx.db
        .prepare(
          `INSERT INTO csv_import_history (import_kind, file_name, file_sha256, total_rows, imported_rows, skipped_duplicate_rows,
            failed_rows, status, summary_json, created_by, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, 'FAILED', ?, ?, ?)`
        )
        .run(file.kind, file.fileName, file.sha256, file.rows.length, file.rows.length, JSON.stringify({ error: (error as Error).message }), currentActor(ctx), nowIso(ctx))
    }
    throw error
  }
}

export function listImportHistory(ctx: ServiceContext): ImportHistoryItem[] {
  const rows = ctx.db.prepare('SELECT * FROM csv_import_history ORDER BY id DESC LIMIT 100').all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r.id as number,
    kind: r.import_kind as ImportKind,
    fileName: r.file_name as string,
    totalRows: r.total_rows as number,
    importedRows: r.imported_rows as number,
    skippedDuplicateRows: r.skipped_duplicate_rows as number,
    failedRows: r.failed_rows as number,
    status: r.status as 'COMPLETED' | 'FAILED',
    createdAt: r.created_at as string,
    createdBy: r.created_by as string | null
  }))
}
