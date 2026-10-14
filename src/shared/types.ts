/** Data transfer objects returned by the main process. All money is integer minor units. */
import type { CurrencyConfig } from './money'
import type { DateFormatOption } from './dates'
import type { TransactionType, BalanceStatus } from './finance'
import type { CategoryAppliesTo, ImportKind, LookupKind, ReportKind } from './schemas'
import type { UsageMethod } from './usage'

export interface AppSettings {
  businessName: string
  currency: CurrencyConfig
  currencyLocked: boolean
  dateFormat: DateFormatOption
  operatorName: string
  payoutOverdraftPolicy: 'BLOCK' | 'REQUIRE_OVERRIDE'
  backupFolder: string | null
  autoBackupEnabled: boolean
  autoBackupKeep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
  balanceConvention: string
}

export interface AppInfo {
  appVersion: string
  schemaVersion: number
  databasePath: string
  dataFolder: string
  defaultBackupFolder: string
  demoMode: boolean
  platform: string
  today: string
  isPackaged: boolean
}

export interface LookupItem {
  id: number
  name: string
  isActive: boolean
  sortOrder: number
  appliesTo?: CategoryAppliesTo | null
}

export type Lookups = Record<LookupKind, LookupItem[]>

export interface CustomerSummary {
  id: number
  customerCode: string
  name: string
  phone: string | null
  email: string | null
  status: 'ACTIVE' | 'INACTIVE'
  registrationDate: string
  openingMinor: number
  receivedMinor: number
  paidMinor: number
  usageMinor: number
  creditAdjustmentsMinor: number
  debitAdjustmentsMinor: number
  balanceMinor: number
  balanceStatus: BalanceStatus
  lastTxnDate: string | null
}

export interface CustomerDetail extends CustomerSummary {
  address: string | null
  notes: string | null
  createdAt: string
  updatedAt: string
  createdBy: string | null
  outstandingMinor: number
  availableCreditMinor: number
  transactionCount: number
}

export interface Paged<T> {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export interface CustomerListResult extends Paged<CustomerSummary> {
  totals: { customers: number; balanceMinor: number; creditMinor: number; dueMinor: number }
}

export interface PossibleDuplicate {
  id: number
  customerCode: string
  name: string
  phone: string | null
  matchedOn: Array<'name' | 'phone'>
}

export interface CustomerSearchHit {
  id: number
  customerCode: string
  name: string
  phone: string | null
  status: 'ACTIVE' | 'INACTIVE'
  balanceMinor: number
}

export interface LedgerRow {
  id: number
  reference: string
  externalRef: string | null
  customerId: number
  customerCode: string
  customerName: string
  type: TransactionType
  txnDate: string
  amountMinor: number
  balanceEffectMinor: number
  runningBalanceMinor: number
  paymentMethod: string | null
  paymentMethodId: number | null
  category: string | null
  categoryId: number | null
  description: string
  paymentReference: string | null
  notes: string | null
  reason: string | null
  overrideReason: string | null
  isReversal: boolean
  reversesTxnId: number | null
  reversesReference: string | null
  reversedByTxnId: number | null
  reversedByReference: string | null
  relatedTxnId: number | null
  relatedReference: string | null
  usageEntryId: number | null
  source: 'MANUAL' | 'IMPORT' | 'CORRECTION' | 'DEMO'
  createdAt: string
  createdBy: string | null
}

export interface LedgerTotals {
  openingMinor: number
  receivedMinor: number
  paidMinor: number
  usageMinor: number
  creditAdjustmentsMinor: number
  debitAdjustmentsMinor: number
  netEffectMinor: number
}

export interface LedgerResult extends Paged<LedgerRow> {
  totals: LedgerTotals
  /** Customer balance before `from` (only for single-customer queries). */
  periodOpeningMinor: number | null
  /** Customer balance at the end of `to` (only for single-customer queries). */
  periodClosingMinor: number | null
}

export interface AuditEntry {
  id: number
  occurredAt: string
  actor: string | null
  action: string
  entityType: string
  entityId: string | null
  summary: string | null
  reason: string | null
  before: unknown
  after: unknown
}

export interface TransactionDetail extends LedgerRow {
  currency: string
  linkedPayouts: Array<{ id: number; reference: string; txnDate: string; amountMinor: number; reversed: boolean }>
  usageEntry: UsageEntry | null
  audit: AuditEntry[]
  canReverse: boolean
  reverseBlockedReason: string | null
}

export interface PayoutPreview {
  currentBalanceMinor: number
  availableCreditMinor: number
  balanceAfterMinor: number
  exceedsCredit: boolean
  shortfallMinor: number
  policy: 'BLOCK' | 'REQUIRE_OVERRIDE'
  relatedReceipt: { id: number; reference: string; amountMinor: number; alreadyRefundedMinor: number; refundableMinor: number } | null
  relatedReceiptError: string | null
}

export interface MutationResult {
  id: number
  reference: string
  /** True when an identical earlier request (same idempotency key) was returned instead of creating a duplicate. */
  duplicateRequest: boolean
}

export interface CustomerCreateResult extends MutationResult {
  customerCode: string
  openingTxnReference: string | null
}

export interface UsageEntry {
  id: number
  customerId: number
  customerCode: string
  customerName: string
  usageDate: string
  categoryId: number
  category: string
  description: string
  method: UsageMethod
  quantityMilli: number | null
  unitId: number | null
  unit: string | null
  rateMinor: number | null
  baseAmountMinor: number
  feesMinor: number
  discountMinor: number
  discountReason: string | null
  chargeMinor: number
  fixedReason: string | null
  notes: string | null
  status: 'POSTED' | 'REVERSED'
  txnId: number
  txnReference: string
  reversalReference: string | null
  replacesEntryId: number | null
  replacedByEntryId: number | null
  createdAt: string
  createdBy: string | null
}

export interface UsageBatchResult {
  batchKey: string
  duplicateRequest: boolean
  entries: Array<{ id: number; txnId: number; reference: string; chargeMinor: number }>
  totalMinor: number
}

export interface UsageCorrectionResult {
  reversalReference: string
  replacement: { id: number; reference: string; chargeMinor: number } | null
  duplicateRequest: boolean
}

export interface NamedAmount {
  id: number | null
  name: string
  amountMinor: number
  count?: number
}

export interface UsageSummary {
  range: { from: string; to: string }
  today: string
  todayTotalMinor: number
  periodTotalMinor: number
  averageDailyMinor: number
  activeDays: number
  byCustomer: Array<NamedAmount & { customerCode: string }>
  byCategory: NamedAmount[]
  daily: Array<{ date: string; amountMinor: number }>
  weekly: Array<{ weekStart: string; amountMinor: number }>
  monthly: Array<{ month: string; amountMinor: number }>
}

export interface ExpenseRow {
  id: number
  reference: string
  expenseDate: string
  categoryId: number
  category: string
  description: string
  amountMinor: number
  paymentMethodId: number
  paymentMethod: string
  paymentReference: string | null
  supplier: string | null
  notes: string | null
  isReversal: boolean
  reversesExpenseId: number | null
  reversesReference: string | null
  reversedByReference: string | null
  reason: string | null
  createdAt: string
  createdBy: string | null
}

export interface ExpenseListResult extends Paged<ExpenseRow> {
  totalMinor: number
}

export interface ExpenseSummary {
  range: { from: string; to: string }
  todayMinor: number
  thisWeekMinor: number
  thisMonthMinor: number
  periodTotalMinor: number
  byCategory: NamedAmount[]
  byPaymentMethod: NamedAmount[]
  monthlyTrend: Array<{ month: string; amountMinor: number }>
}

export interface KpiSet {
  receivedMinor: number
  paidMinor: number
  usageMinor: number
  expensesMinor: number
  netCashFlowMinor: number
  creditAdjustmentsMinor: number
  debitAdjustmentsMinor: number
  transactionCount: number
}

export interface DashboardData {
  today: string
  range: { from: string; to: string }
  granularity: 'day' | 'month'
  customers: { total: number; active: number; inactive: number }
  balances: {
    creditOutstandingMinor: number
    dueFromCustomersMinor: number
    customersInCredit: number
    customersWithDue: number
    customersSettled: number
  }
  todayKpis: KpiSet
  monthKpis: KpiSet
  periodKpis: KpiSet
  cashFlowSeries: Array<{ bucket: string; receivedMinor: number; paidMinor: number; expensesMinor: number; netMinor: number }>
  usageSeries: Array<{ bucket: string; amountMinor: number }>
  expensesByCategory: NamedAmount[]
  usageByCategory: NamedAmount[]
  topCustomersByUsage: Array<NamedAmount & { customerCode: string }>
  topCustomersByReceipts: Array<NamedAmount & { customerCode: string }>
  monthlyCashFlow: Array<{ month: string; inflowMinor: number; outflowMinor: number; payoutsMinor: number; expensesMinor: number }>
  monthlyExpenseTrend: Array<{ month: string; amountMinor: number }>
  balanceDistribution: Array<{ bucket: string; count: number; amountMinor: number; order: number }>
  transactionTypeBreakdown: Array<{ type: TransactionType | 'BUSINESS_EXPENSE'; label: string; count: number; amountMinor: number }>
  latestTransactions: LedgerRow[]
  dateBasis: string
}

export interface CustomerAnalytics {
  balanceSeries: Array<{ date: string; balanceMinor: number }>
  usageByCategory: NamedAmount[]
  monthly: Array<{ month: string; receivedMinor: number; paidMinor: number; usageMinor: number }>
}

export interface ReportColumn {
  key: string
  label: string
  kind: 'text' | 'money' | 'number' | 'date'
  align?: 'left' | 'right'
}

export interface ReportData {
  kind: ReportKind
  title: string
  subtitle: string
  generatedAt: string
  dateBasis: string
  filters: Array<{ label: string; value: string }>
  columns: ReportColumn[]
  rows: Array<Record<string, string | number | null>>
  totals: Record<string, string | number | null> | null
  summary: Array<{ label: string; value: string }>
}

export interface FileSaveResult {
  saved: boolean
  fileName: string | null
  rowCount?: number
}

export interface ImportFieldSpec {
  key: string
  label: string
  required: boolean
  description: string
}

export interface ImportSessionInfo {
  sessionId: string
  kind: ImportKind
  fileName: string
  headers: string[]
  rowCount: number
  fields: ImportFieldSpec[]
  suggestedMapping: Record<string, number | null>
  sample: string[][]
}

export type ImportRowStatus = 'VALID' | 'DUPLICATE' | 'POSSIBLE_DUPLICATE' | 'SKIPPED' | 'ERROR'

export interface ImportRowResult {
  rowNumber: number
  status: ImportRowStatus
  messages: string[]
  preview: Record<string, string>
}

export interface ImportValidationResult {
  sessionId: string
  kind: ImportKind
  totalRows: number
  validRows: number
  duplicateRows: number
  possibleDuplicateRows: number
  skippedRows: number
  errorRows: number
  financialTotalMinor: number
  sameFileImportedAt: string | null
  rows: ImportRowResult[]
}

export interface ImportCommitResult {
  importId: number
  importedRows: number
  skippedDuplicateRows: number
  skippedPossibleDuplicateRows: number
  skippedRows: number
  failedRows: number
  failures: Array<{ rowNumber: number; messages: string[] }>
}

export interface ImportHistoryItem {
  id: number
  kind: ImportKind
  fileName: string
  totalRows: number
  importedRows: number
  skippedDuplicateRows: number
  failedRows: number
  status: 'COMPLETED' | 'FAILED'
  createdAt: string
  createdBy: string | null
}

export interface BackupResult {
  saved: boolean
  fileName: string | null
  folder: string | null
  sizeBytes: number
  encrypted: boolean
  integrity: string
  createdAt: string | null
}

export interface BackupInspection {
  token: string
  fileName: string
  encrypted: boolean
  needsPassphrase: boolean
  valid: boolean
  problems: string[]
  schemaVersion: number | null
  counts: { customers: number; transactions: number; expenses: number; usageEntries: number } | null
  lastTransactionDate: string | null
  sizeBytes: number
}

export interface RestoreResult {
  restored: boolean
  safetyBackupFile: string
  integrity: string
  counts: { customers: number; transactions: number; expenses: number; usageEntries: number }
}

export interface IntegrityReport {
  ok: boolean
  checkedAt: string
  sqliteIntegrity: string
  foreignKeyViolations: number
  problems: string[]
  counts: { customers: number; transactions: number; expenses: number; usageEntries: number; auditEntries: number }
}

export interface BackupStatus {
  lastBackupAt: string | null
  lastBackupFile: string | null
  backupFolder: string
  autoBackupEnabled: boolean
  daysSinceBackup: number | null
  recentBackups: Array<{ fileName: string; sizeBytes: number; modifiedAt: string }>
}

export interface AppNotification {
  id: string
  level: 'info' | 'warning'
  title: string
  message: string
  link?: string
}
