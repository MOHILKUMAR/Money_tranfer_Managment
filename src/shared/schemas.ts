/**
 * Zod schemas for every IPC request. The main process validates all renderer
 * input against these before touching the database.
 */
import { z } from 'zod'
import { isValidIsoDate, DATE_FORMAT_OPTIONS } from './dates'
import { TRANSACTION_TYPES } from './finance'
import { MAX_AMOUNT_MINOR, MAX_QUANTITY_MILLI } from './money'
import { USAGE_METHODS } from './usage'

export const idSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const isoDateSchema = z.string().refine(isValidIsoDate, 'Enter a valid date')
export const positiveMinorSchema = z
  .number()
  .int('Amount must be in whole minor units')
  .positive('Amount must be greater than zero')
  .max(MAX_AMOUNT_MINOR, 'Amount is too large')
export const nonNegativeMinorSchema = z.number().int().min(0).max(MAX_AMOUNT_MINOR)
export const signedMinorSchema = z.number().int().min(-MAX_AMOUNT_MINOR).max(MAX_AMOUNT_MINOR)
export const idempotencyKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Invalid request key')

const text = (max: number) => z.string().trim().max(max, `Must be at most ${max} characters`)
const requiredText = (max: number, label = 'This field') =>
  text(max).min(1, `${label} is required`)
const optionalText = (max: number) => text(max).nullish()

const PHONE_PATTERN = /^[0-9+()\-.\s]*$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const pageFields = {
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(500).default(50)
}

export const customerStatusSchema = z.enum(['ACTIVE', 'INACTIVE'])
export const transactionTypeSchema = z.enum(TRANSACTION_TYPES)

export const openingBalanceSchema = z.strictObject({
  amountMinor: signedMinorSchema.refine((v) => v !== 0, 'Opening balance cannot be zero'),
  date: isoDateSchema,
  explanation: requiredText(500, 'Explanation')
})

const customerProfileFields = {
  name: requiredText(200, 'Name'),
  phone: optionalText(30).refine((v) => !v || PHONE_PATTERN.test(v), 'Phone may contain digits, spaces, + ( ) - .'),
  email: optionalText(200).refine((v) => !v || EMAIL_PATTERN.test(v), 'Enter a valid email address'),
  address: optionalText(500),
  registrationDate: isoDateSchema,
  notes: optionalText(2000)
}

export const customerCreateSchema = z.strictObject({
  ...customerProfileFields,
  status: customerStatusSchema.default('ACTIVE'),
  openingBalance: openingBalanceSchema.nullish(),
  idempotencyKey: idempotencyKeySchema,
  confirmPossibleDuplicate: z.boolean().optional()
})
export type CustomerCreateInput = z.input<typeof customerCreateSchema>

export const customerUpdateSchema = z.strictObject({
  id: idSchema,
  ...customerProfileFields,
  reason: optionalText(500)
})
export type CustomerUpdateInput = z.input<typeof customerUpdateSchema>

export const customerSetStatusSchema = z.strictObject({
  id: idSchema,
  status: customerStatusSchema,
  reason: optionalText(500)
})

export const customerListSchema = z.strictObject({
  search: optionalText(100),
  status: z.enum(['ALL', 'ACTIVE', 'INACTIVE']).default('ALL'),
  balanceFilter: z.enum(['ALL', 'CREDIT', 'DUE', 'SETTLED']).default('ALL'),
  sortBy: z.enum(['name', 'code', 'registrationDate', 'balance', 'lastTxnDate']).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  ...pageFields
})
export type CustomerListInput = z.input<typeof customerListSchema>

export const customerDuplicateCheckSchema = z.strictObject({
  name: text(200),
  phone: optionalText(30),
  excludeId: idSchema.nullish()
})

export const quickSearchSchema = z.strictObject({ query: text(100), limit: z.number().int().min(1).max(50).default(10) })

export const receiptCreateSchema = z.strictObject({
  customerId: idSchema,
  date: isoDateSchema,
  amountMinor: positiveMinorSchema,
  paymentMethodId: idSchema,
  paymentReference: optionalText(100),
  categoryId: idSchema.nullish(),
  description: optionalText(300),
  notes: optionalText(2000),
  idempotencyKey: idempotencyKeySchema
})
export type ReceiptCreateInput = z.input<typeof receiptCreateSchema>

export const overrideSchema = z.strictObject({
  confirmed: z.literal(true),
  reason: requiredText(500, 'Override reason').min(3, 'Explain why the override is authorised')
})

export const payoutCreateSchema = z.strictObject({
  customerId: idSchema,
  date: isoDateSchema,
  amountMinor: positiveMinorSchema,
  paymentMethodId: idSchema,
  paymentReference: optionalText(100),
  categoryId: idSchema.nullish(),
  reason: requiredText(500, 'Reason for payment'),
  relatedTxnId: idSchema.nullish(),
  notes: optionalText(2000),
  override: overrideSchema.nullish(),
  idempotencyKey: idempotencyKeySchema
})
export type PayoutCreateInput = z.input<typeof payoutCreateSchema>

export const payoutPreviewSchema = z.strictObject({
  customerId: idSchema,
  amountMinor: nonNegativeMinorSchema,
  relatedTxnId: idSchema.nullish()
})

export const adjustmentCreateSchema = z.strictObject({
  customerId: idSchema,
  direction: z.enum(['CREDIT', 'DEBIT']),
  date: isoDateSchema,
  amountMinor: positiveMinorSchema,
  categoryId: idSchema.nullish(),
  reason: requiredText(500, 'Reason'),
  notes: optionalText(2000),
  idempotencyKey: idempotencyKeySchema
})
export type AdjustmentCreateInput = z.input<typeof adjustmentCreateSchema>

export const reverseTransactionSchema = z.strictObject({
  txnId: idSchema,
  reason: requiredText(500, 'Reason').min(3, 'Explain the reason for the reversal'),
  date: isoDateSchema.nullish(),
  idempotencyKey: idempotencyKeySchema
})
export type ReverseTransactionInput = z.input<typeof reverseTransactionSchema>

export const transactionNotesSchema = z.strictObject({
  txnId: idSchema,
  description: requiredText(300, 'Description'),
  notes: optionalText(2000),
  reason: optionalText(500)
})

export const ledgerQuerySchema = z.strictObject({
  customerId: idSchema.nullish(),
  from: isoDateSchema.nullish(),
  to: isoDateSchema.nullish(),
  types: z.array(transactionTypeSchema).max(TRANSACTION_TYPES.length).nullish(),
  categoryId: idSchema.nullish(),
  paymentMethodId: idSchema.nullish(),
  search: optionalText(100),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  ...pageFields
})
export type LedgerQueryInput = z.input<typeof ledgerQuerySchema>

export const usageLineSchema = z
  .strictObject({
    categoryId: idSchema,
    description: requiredText(300, 'Description'),
    method: z.enum(USAGE_METHODS),
    quantityMilli: z.number().int().positive().max(MAX_QUANTITY_MILLI).nullish(),
    unitId: idSchema.nullish(),
    rateMinor: nonNegativeMinorSchema.nullish(),
    fixedAmountMinor: positiveMinorSchema.nullish(),
    fixedReason: optionalText(300),
    feesMinor: nonNegativeMinorSchema.default(0),
    discountMinor: nonNegativeMinorSchema.default(0),
    discountReason: optionalText(300),
    notes: optionalText(1000)
  })
  .superRefine((line, ctx) => {
    if (line.method === 'QUANTITY') {
      if (!line.quantityMilli) ctx.addIssue({ code: 'custom', path: ['quantityMilli'], message: 'Quantity is required' })
      if (line.rateMinor === null || line.rateMinor === undefined) {
        ctx.addIssue({ code: 'custom', path: ['rateMinor'], message: 'Rate is required' })
      }
    } else {
      if (!line.fixedAmountMinor) {
        ctx.addIssue({ code: 'custom', path: ['fixedAmountMinor'], message: 'Amount is required' })
      }
      if (!line.fixedReason) {
        ctx.addIssue({ code: 'custom', path: ['fixedReason'], message: 'Give a reason for the fixed charge' })
      }
    }
    if ((line.discountMinor ?? 0) > 0 && !line.discountReason) {
      ctx.addIssue({ code: 'custom', path: ['discountReason'], message: 'A discount requires an authorisation note' })
    }
  })
export type UsageLineInput = z.input<typeof usageLineSchema>

export const usageBatchSchema = z.strictObject({
  customerId: idSchema,
  usageDate: isoDateSchema,
  lines: z.array(usageLineSchema).min(1, 'Add at least one usage line').max(100),
  idempotencyKey: idempotencyKeySchema
})
export type UsageBatchInput = z.input<typeof usageBatchSchema>

export const usageCorrectSchema = z.strictObject({
  entryId: idSchema,
  reason: requiredText(500, 'Reason').min(3, 'Explain the reason for the correction'),
  replacement: z
    .strictObject({ usageDate: isoDateSchema, line: usageLineSchema })
    .nullish(),
  idempotencyKey: idempotencyKeySchema
})
export type UsageCorrectInput = z.input<typeof usageCorrectSchema>

export const usageListSchema = z.strictObject({
  from: isoDateSchema.nullish(),
  to: isoDateSchema.nullish(),
  customerId: idSchema.nullish(),
  categoryId: idSchema.nullish(),
  search: optionalText(100),
  includeReversed: z.boolean().default(true),
  ...pageFields
})
export type UsageListInput = z.input<typeof usageListSchema>

export const dateRangeSchema = z
  .strictObject({ from: isoDateSchema, to: isoDateSchema })
  .refine((r) => r.from <= r.to, { message: 'Start date must be on or before end date', path: ['to'] })

export const customerAnalyticsSchema = z.strictObject({
  customerId: idSchema,
  from: isoDateSchema,
  to: isoDateSchema
})

export const expenseCreateSchema = z.strictObject({
  date: isoDateSchema,
  categoryId: idSchema,
  description: requiredText(300, 'Description'),
  amountMinor: positiveMinorSchema,
  paymentMethodId: idSchema,
  paymentReference: optionalText(100),
  supplier: optionalText(200),
  notes: optionalText(2000),
  idempotencyKey: idempotencyKeySchema
})
export type ExpenseCreateInput = z.input<typeof expenseCreateSchema>

export const expenseReverseSchema = z.strictObject({
  expenseId: idSchema,
  reason: requiredText(500, 'Reason').min(3, 'Explain the reason for the reversal'),
  date: isoDateSchema.nullish(),
  idempotencyKey: idempotencyKeySchema
})

export const expenseListSchema = z.strictObject({
  from: isoDateSchema.nullish(),
  to: isoDateSchema.nullish(),
  categoryId: idSchema.nullish(),
  paymentMethodId: idSchema.nullish(),
  search: optionalText(100),
  ...pageFields
})
export type ExpenseListInput = z.input<typeof expenseListSchema>

export const LOOKUP_KINDS = [
  'payment_methods',
  'transaction_categories',
  'usage_categories',
  'usage_units',
  'expense_categories'
] as const
export type LookupKind = (typeof LOOKUP_KINDS)[number]
export const CATEGORY_APPLIES_TO = ['RECEIPT', 'PAYOUT', 'ADJUSTMENT', 'ANY'] as const
export type CategoryAppliesTo = (typeof CATEGORY_APPLIES_TO)[number]

export const lookupCreateSchema = z.strictObject({
  kind: z.enum(LOOKUP_KINDS),
  name: requiredText(60, 'Name'),
  appliesTo: z.enum(CATEGORY_APPLIES_TO).nullish()
})

export const lookupUpdateSchema = z.strictObject({
  kind: z.enum(LOOKUP_KINDS),
  id: idSchema,
  name: requiredText(60, 'Name').optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional()
})

export const settingsUpdateSchema = z.strictObject({
  businessName: text(120).optional(),
  currency: z
    .strictObject({
      code: z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code'),
      locale: z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/, 'Invalid locale'),
      minorDigits: z.number().int().min(0).max(3)
    })
    .optional(),
  dateFormat: z.enum(DATE_FORMAT_OPTIONS).optional(),
  operatorName: text(60).optional(),
  payoutOverdraftPolicy: z.enum(['BLOCK', 'REQUIRE_OVERRIDE']).optional(),
  autoBackupEnabled: z.boolean().optional(),
  autoBackupKeep: z.number().int().min(1).max(100).optional()
})
export type SettingsUpdateInput = z.input<typeof settingsUpdateSchema>

export const REPORT_KINDS = [
  'customer_directory',
  'customer_statement',
  'customer_balances',
  'transactions',
  'receipts',
  'payouts',
  'usage',
  'expenses',
  'daily_cashbook',
  'daily_summary',
  'monthly_summary',
  'customer_payment_summary',
  'customer_payout_summary',
  'dashboard_summary'
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export const reportParamsSchema = z.strictObject({
  kind: z.enum(REPORT_KINDS),
  from: isoDateSchema.nullish(),
  to: isoDateSchema.nullish(),
  asOf: isoDateSchema.nullish(),
  customerId: idSchema.nullish(),
  types: z.array(transactionTypeSchema).max(TRANSACTION_TYPES.length).nullish(),
  categoryId: idSchema.nullish(),
  paymentMethodId: idSchema.nullish(),
  status: z.enum(['ALL', 'ACTIVE', 'INACTIVE']).nullish()
})
export type ReportParams = z.input<typeof reportParamsSchema>

export const IMPORT_KINDS = ['CUSTOMERS', 'TRANSACTIONS', 'USAGE'] as const
export type ImportKind = (typeof IMPORT_KINDS)[number]

export const importOpenSchema = z.strictObject({ kind: z.enum(IMPORT_KINDS) })
const sessionIdSchema = idempotencyKeySchema
export const importMappingSchema = z.record(z.string().max(60), z.number().int().min(0).max(500).nullable())
export const importValidateSchema = z.strictObject({
  sessionId: sessionIdSchema,
  mapping: importMappingSchema,
  dateFormat: z.enum(['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']).default('dd/MM/yyyy')
})
export const importCommitSchema = z.strictObject({
  sessionId: sessionIdSchema,
  mapping: importMappingSchema,
  dateFormat: z.enum(['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd']).default('dd/MM/yyyy'),
  confirmFinancial: z.boolean(),
  skipInvalidRows: z.boolean(),
  importPossibleDuplicates: z.boolean().default(false)
})
export const importCancelSchema = z.strictObject({ sessionId: sessionIdSchema })

export const backupCreateSchema = z
  .strictObject({
    destination: z.enum(['CHOOSE', 'FOLDER']),
    encrypt: z.boolean(),
    passphrase: z.string().max(200).nullish()
  })
  .refine((v) => !v.encrypt || (v.passphrase && v.passphrase.length >= 8), {
    message: 'Encrypted backups need a passphrase of at least 8 characters',
    path: ['passphrase']
  })

export const restoreInspectSchema = z.strictObject({
  token: sessionIdSchema,
  passphrase: z.string().max(200).nullish()
})
export const restoreConfirmSchema = z.strictObject({
  token: sessionIdSchema,
  passphrase: z.string().max(200).nullish(),
  confirmText: z.literal('RESTORE')
})

export const auditListSchema = z.strictObject({
  entityType: optionalText(40),
  entityId: optionalText(40),
  ...pageFields
})

export const emptySchema = z.strictObject({}).optional()
