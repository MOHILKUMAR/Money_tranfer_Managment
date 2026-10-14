/** Request/response types for every IPC channel (used by the renderer for type safety). */
import type { z } from 'zod'
import type * as S from './schemas'
import type * as T from './types'
import type { IpcChannel } from './channels'

type In<Schema extends z.ZodType> = z.input<Schema>

export interface ApiContract {
  'app:info': [void, T.AppInfo]
  'app:notifications': [void, T.AppNotification[]]
  'app:revealDataFolder': [void, null]
  'app:integrityCheck': [void, T.IntegrityReport]
  'settings:get': [void, T.AppSettings]
  'settings:update': [S.SettingsUpdateInput, T.AppSettings]
  'lookups:list': [void, T.Lookups]
  'lookups:create': [In<typeof S.lookupCreateSchema>, T.LookupItem]
  'lookups:update': [In<typeof S.lookupUpdateSchema>, T.LookupItem]
  'customers:list': [S.CustomerListInput, T.CustomerListResult]
  'customers:get': [{ id: number }, T.CustomerDetail]
  'customers:create': [S.CustomerCreateInput, T.CustomerCreateResult]
  'customers:update': [S.CustomerUpdateInput, T.CustomerDetail]
  'customers:setStatus': [In<typeof S.customerSetStatusSchema>, T.CustomerDetail]
  'customers:checkDuplicates': [In<typeof S.customerDuplicateCheckSchema>, T.PossibleDuplicate[]]
  'customers:search': [In<typeof S.quickSearchSchema>, T.CustomerSearchHit[]]
  'customers:analytics': [In<typeof S.customerAnalyticsSchema>, T.CustomerAnalytics]
  'ledger:list': [S.LedgerQueryInput, T.LedgerResult]
  'ledger:get': [{ id: number }, T.TransactionDetail]
  'ledger:recordReceipt': [S.ReceiptCreateInput, T.MutationResult]
  'ledger:recordPayout': [S.PayoutCreateInput, T.MutationResult]
  'ledger:previewPayout': [In<typeof S.payoutPreviewSchema>, T.PayoutPreview]
  'ledger:recordAdjustment': [S.AdjustmentCreateInput, T.MutationResult]
  'ledger:reverse': [S.ReverseTransactionInput, T.MutationResult]
  'ledger:updateNotes': [In<typeof S.transactionNotesSchema>, T.LedgerRow]
  'usage:list': [S.UsageListInput, T.Paged<T.UsageEntry> & { totalMinor: number }]
  'usage:recordBatch': [S.UsageBatchInput, T.UsageBatchResult]
  'usage:correct': [S.UsageCorrectInput, T.UsageCorrectionResult]
  'usage:summary': [{ from: string; to: string }, T.UsageSummary]
  'expenses:list': [S.ExpenseListInput, T.ExpenseListResult]
  'expenses:create': [S.ExpenseCreateInput, T.MutationResult]
  'expenses:reverse': [In<typeof S.expenseReverseSchema>, T.MutationResult]
  'expenses:summary': [{ from: string; to: string }, T.ExpenseSummary]
  'analytics:dashboard': [{ from: string; to: string }, T.DashboardData]
  'reports:preview': [S.ReportParams, T.ReportData & { totalRows: number }]
  'reports:exportCsv': [S.ReportParams, T.FileSaveResult]
  'reports:saveHtml': [S.ReportParams, T.FileSaveResult]
  'reports:print': [S.ReportParams, { opened: boolean }]
  'imports:open': [{ kind: S.ImportKind }, T.ImportSessionInfo | null]
  'imports:validate': [In<typeof S.importValidateSchema>, T.ImportValidationResult]
  'imports:commit': [In<typeof S.importCommitSchema>, T.ImportCommitResult]
  'imports:cancel': [{ sessionId: string }, { cancelled: boolean }]
  'imports:history': [void, T.ImportHistoryItem[]]
  'backup:status': [void, T.BackupStatus]
  'backup:create': [In<typeof S.backupCreateSchema>, T.BackupResult]
  'backup:chooseFolder': [void, T.AppSettings]
  'backup:pickRestore': [void, T.BackupInspection | null]
  'backup:inspectRestore': [In<typeof S.restoreInspectSchema>, T.BackupInspection]
  'backup:confirmRestore': [In<typeof S.restoreConfirmSchema>, T.RestoreResult]
  'audit:list': [In<typeof S.auditListSchema>, T.Paged<T.AuditEntry>]
}

// Compile-time check that the contract covers exactly the channel list.
type MissingChannels = Exclude<IpcChannel, keyof ApiContract>
type ExtraChannels = Exclude<keyof ApiContract, IpcChannel>
export const contractIsComplete: [MissingChannels, ExtraChannels] extends [never, never] ? true : never = true

export type ApiInput<C extends IpcChannel> = ApiContract[C][0]
export type ApiOutput<C extends IpcChannel> = ApiContract[C][1]
