/**
 * Maps every IPC channel to a validated service call. File-system access is
 * only ever initiated here through native dialogs; the renderer never supplies
 * a path. Electron-specific capabilities are injected so this module can be
 * tested without Electron.
 */
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import { parseCsv, CsvParseError } from '@shared/csv'
import {
  adjustmentCreateSchema,
  auditListSchema,
  backupCreateSchema,
  customerAnalyticsSchema,
  customerCreateSchema,
  customerDuplicateCheckSchema,
  customerListSchema,
  customerSetStatusSchema,
  customerUpdateSchema,
  dateRangeSchema,
  emptySchema,
  expenseCreateSchema,
  expenseListSchema,
  expenseReverseSchema,
  idSchema,
  importCancelSchema,
  importCommitSchema,
  importOpenSchema,
  importValidateSchema,
  ledgerQuerySchema,
  lookupCreateSchema,
  lookupUpdateSchema,
  payoutCreateSchema,
  payoutPreviewSchema,
  quickSearchSchema,
  receiptCreateSchema,
  reportParamsSchema,
  restoreConfirmSchema,
  restoreInspectSchema,
  reverseTransactionSchema,
  settingsUpdateSchema,
  transactionNotesSchema,
  usageBatchSchema,
  usageCorrectSchema,
  usageListSchema,
  type ImportKind
} from '@shared/schemas'
import type { AppInfo, AppNotification, BackupInspection, BackupResult, BackupStatus, FileSaveResult, ImportSessionInfo } from '@shared/types'
import { todayIso } from '@shared/dates'
import type { DatabaseManager, LoggerLike } from '../db/manager'
import { currentSchemaVersion } from '../db/migrations'
import { route, type Routes } from './router'
import * as customers from '../services/customers'
import * as ledger from '../services/ledger'
import * as usage from '../services/usage'
import * as expenses from '../services/expenses'
import * as lookups from '../services/lookups'
import * as settings from '../services/settings'
import { getDashboard } from '../services/analytics'
import { buildReport, reportToCsv, reportToHtml } from '../services/reports'
import { commitImport, hashContent, IMPORT_FIELDS, listImportHistory, suggestMapping, validateImport, type ParsedImportFile } from '../services/csv-import'
import { backupFileName, prepareRestore, writeBackup } from '../services/backup'
import { listAudit, runIntegrityCheck } from '../services/integrity'
import { writeAudit } from '../services/context'
import { CUSTOMER_TOTALS_SQL } from '../services/ledger-core'

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024
const MAX_IMPORT_ROWS = 50_000
const SESSION_TTL_MS = 60 * 60 * 1000

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface MainDeps {
  manager: DatabaseManager
  logger: LoggerLike
  appMeta(): { appVersion: string; demoMode: boolean; platform: string; isPackaged: boolean; dataFolder: string }
  defaultBackupDir: string
  defaultExportDir(): string
  dialogs: {
    saveFile(options: { title: string; defaultPath: string; filters: FileFilter[] }): Promise<string | null>
    openFile(options: { title: string; filters: FileFilter[] }): Promise<string | null>
    openDirectory(options: { title: string }): Promise<string | null>
  }
  revealPath(path: string): void
  printHtml(html: string, title: string): Promise<void>
  onDatabaseReplaced?(): void
}

interface ImportSession {
  file: ParsedImportFile
  createdAt: number
}

interface RestoreToken {
  sourcePath: string
  plainPath: string | null
  createdAt: number
}

const CSV_FILTER: FileFilter[] = [{ name: 'CSV files', extensions: ['csv'] }]

export function buildRoutes(deps: MainDeps): Routes {
  const ctx = () => deps.manager.ctx
  const importSessions = new Map<string, ImportSession>()
  const restoreTokens = new Map<string, RestoreToken>()

  const prune = () => {
    const now = Date.now()
    for (const [id, session] of importSessions) if (now - session.createdAt > SESSION_TTL_MS) importSessions.delete(id)
    for (const [id, token] of restoreTokens) {
      if (now - token.createdAt > SESSION_TTL_MS) {
        if (token.plainPath) rmSync(token.plainPath, { force: true })
        restoreTokens.delete(id)
      }
    }
  }

  const getSession = (id: string): ImportSession => {
    const session = importSessions.get(id)
    if (!session) throw new AppError('NOT_FOUND', 'The import session has expired. Choose the file again.')
    return session
  }

  const backupFolder = () => settings.readSettings(ctx()).backupFolder ?? deps.defaultBackupDir

  const exportFile = async (kindLabel: string, extension: 'csv' | 'html', content: string, rowCount?: number): Promise<FileSaveResult> => {
    const filePath = await deps.dialogs.saveFile({
      title: `Save ${kindLabel}`,
      defaultPath: join(deps.defaultExportDir(), `${kindLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${todayIso()}.${extension}`),
      filters: extension === 'csv' ? CSV_FILTER : [{ name: 'HTML report', extensions: ['html'] }]
    })
    if (!filePath) return { saved: false, fileName: null }
    writeFileSync(filePath, content, { encoding: 'utf8' })
    deps.logger.info(`Exported ${extension.toUpperCase()} report (${rowCount ?? 0} rows)`)
    return { saved: true, fileName: basename(filePath), rowCount }
  }

  const listRecentBackups = (folder: string): BackupStatus['recentBackups'] => {
    try {
      return readdirSync(folder)
        .filter((f) => /\.(sqlite|cmmbak)$/i.test(f) && !f.startsWith('.'))
        .map((f) => {
          const s = statSync(join(folder, f))
          return { fileName: f, sizeBytes: s.size, modifiedAt: s.mtime.toISOString() }
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
        .slice(0, 10)
    } catch {
      return []
    }
  }

  return {
    'app:info': route(emptySchema, (): AppInfo => {
      const meta = deps.appMeta()
      return {
        ...meta,
        schemaVersion: currentSchemaVersion(deps.manager.db),
        databasePath: deps.manager.paths.dbPath,
        defaultBackupFolder: deps.defaultBackupDir,
        today: todayIso(ctx().now())
      }
    }),
    'app:notifications': route(emptySchema, (): AppNotification[] => {
      const out: AppNotification[] = []
      const s = settings.readSettings(ctx())
      const hasData = (ctx().db.prepare('SELECT EXISTS (SELECT 1 FROM transactions) OR EXISTS (SELECT 1 FROM business_expenses) AS x').get() as { x: number }).x === 1
      if (hasData) {
        const days = s.lastBackupAt ? Math.floor((ctx().now().getTime() - new Date(s.lastBackupAt).getTime()) / 86_400_000) : null
        if (days === null) out.push({ id: 'backup-never', level: 'warning', title: 'No backup yet', message: 'Create a backup and keep a second copy on a separate drive.', link: '/backup' })
        else if (days >= 7) out.push({ id: 'backup-old', level: 'warning', title: 'Backup is out of date', message: `Last backup was ${days} days ago.`, link: '/backup' })
      }
      const due = ctx().db
        .prepare(`SELECT COUNT(*) AS n FROM (${CUSTOMER_TOTALS_SQL}) WHERE balance_minor < 0`)
        .get() as { n: number }
      if (due.n > 0) out.push({ id: 'dues', level: 'info', title: 'Customers with dues', message: `${due.n} customer account(s) have an amount due.`, link: '/customers?balance=DUE' })
      if (deps.appMeta().demoMode) out.push({ id: 'demo', level: 'info', title: 'Demo environment', message: 'You are viewing synthetic demo data stored in a separate demo database.' })
      return out
    }),
    'app:revealDataFolder': route(emptySchema, () => deps.revealPath(deps.manager.paths.dbPath)),
    'app:integrityCheck': route(emptySchema, () => runIntegrityCheck(ctx())),

    'settings:get': route(emptySchema, () => settings.getSettings(ctx())),
    'settings:update': route(settingsUpdateSchema, (input) => settings.updateSettings(ctx(), input)),

    'lookups:list': route(emptySchema, () => lookups.listLookups(ctx())),
    'lookups:create': route(lookupCreateSchema, (input) => lookups.createLookup(ctx(), input)),
    'lookups:update': route(lookupUpdateSchema, (input) => lookups.updateLookup(ctx(), input)),

    'customers:list': route(customerListSchema, (input) => customers.listCustomers(ctx(), input)),
    'customers:get': route(z.strictObject({ id: idSchema }), (input) => customers.getCustomer(ctx(), input.id)),
    'customers:create': route(customerCreateSchema, (input) => customers.createCustomer(ctx(), input)),
    'customers:update': route(customerUpdateSchema, (input) => customers.updateCustomer(ctx(), input)),
    'customers:setStatus': route(customerSetStatusSchema, (input) => customers.setCustomerStatus(ctx(), input)),
    'customers:checkDuplicates': route(customerDuplicateCheckSchema, (input) => customers.findPossibleDuplicates(ctx(), input)),
    'customers:search': route(quickSearchSchema, (input) => customers.quickSearchCustomers(ctx(), input)),
    'customers:analytics': route(customerAnalyticsSchema, (input) => customers.customerAnalytics(ctx(), input)),

    'ledger:list': route(ledgerQuerySchema, (input) => ledger.listLedger(ctx(), input)),
    'ledger:get': route(z.strictObject({ id: idSchema }), (input) => ledger.getTransactionDetail(ctx(), input.id)),
    'ledger:recordReceipt': route(receiptCreateSchema, (input) => ledger.recordReceipt(ctx(), input)),
    'ledger:recordPayout': route(payoutCreateSchema, (input) => ledger.recordPayout(ctx(), input)),
    'ledger:previewPayout': route(payoutPreviewSchema, (input) => ledger.previewPayout(ctx(), input)),
    'ledger:recordAdjustment': route(adjustmentCreateSchema, (input) => ledger.recordAdjustment(ctx(), input)),
    'ledger:reverse': route(reverseTransactionSchema, (input) => ledger.reverseTransaction(ctx(), input)),
    'ledger:updateNotes': route(transactionNotesSchema, (input) => ledger.updateTransactionNotes(ctx(), input)),

    'usage:list': route(usageListSchema, (input) => usage.listUsage(ctx(), input)),
    'usage:recordBatch': route(usageBatchSchema, (input) => usage.recordUsageBatch(ctx(), input)),
    'usage:correct': route(usageCorrectSchema, (input) => usage.correctUsage(ctx(), input)),
    'usage:summary': route(dateRangeSchema, (input) => usage.usageSummary(ctx(), input)),

    'expenses:list': route(expenseListSchema, (input) => expenses.listExpenses(ctx(), input)),
    'expenses:create': route(expenseCreateSchema, (input) => expenses.recordExpense(ctx(), input)),
    'expenses:reverse': route(expenseReverseSchema, (input) => expenses.reverseExpense(ctx(), input)),
    'expenses:summary': route(dateRangeSchema, (input) => expenses.expenseSummary(ctx(), input)),

    'analytics:dashboard': route(dateRangeSchema, (input) => getDashboard(ctx(), input)),

    'reports:preview': route(reportParamsSchema, (input) => {
      const report = buildReport(ctx(), input)
      return { ...report, rows: report.rows.slice(0, 1000), totalRows: report.rows.length }
    }),
    'reports:exportCsv': route(reportParamsSchema, async (input) => {
      const report = buildReport(ctx(), input)
      const csv = reportToCsv(report, settings.getCurrency(ctx()))
      return exportFile(report.title, 'csv', csv, report.rows.length)
    }),
    'reports:saveHtml': route(reportParamsSchema, async (input) => {
      const report = buildReport(ctx(), input)
      const s = settings.getSettings(ctx())
      const html = reportToHtml(report, { currency: s.currency, dateFormat: s.dateFormat, businessName: s.businessName })
      return exportFile(report.title, 'html', html, report.rows.length)
    }),
    'reports:print': route(reportParamsSchema, async (input) => {
      const report = buildReport(ctx(), input)
      const s = settings.getSettings(ctx())
      await deps.printHtml(reportToHtml(report, { currency: s.currency, dateFormat: s.dateFormat, businessName: s.businessName }), report.title)
      return { opened: true }
    }),

    'imports:open': route(importOpenSchema, async (input): Promise<ImportSessionInfo | null> => {
      prune()
      const filePath = await deps.dialogs.openFile({ title: 'Choose a CSV file to import', filters: CSV_FILTER })
      if (!filePath) return null
      const size = statSync(filePath).size
      if (size > MAX_IMPORT_BYTES) throw new AppError('VALIDATION', 'The file is larger than 20 MB. Split it into smaller files.')
      const content = readFileSync(filePath, 'utf8')
      let parsed
      try {
        parsed = parseCsv(content, { maxRows: MAX_IMPORT_ROWS })
      } catch (error) {
        if (error instanceof CsvParseError) throw new AppError('VALIDATION', `The CSV file could not be read: ${error.message}`)
        throw error
      }
      if (parsed.rows.length === 0) throw new AppError('VALIDATION', 'The file has a header row but no data rows')
      const sessionId = randomUUID()
      const file: ParsedImportFile = {
        kind: input.kind as ImportKind,
        fileName: basename(filePath),
        sha256: hashContent(content),
        headers: parsed.headers,
        rows: parsed.rows
      }
      importSessions.set(sessionId, { file, createdAt: Date.now() })
      if (importSessions.size > 5) importSessions.delete(importSessions.keys().next().value!)
      return {
        sessionId,
        kind: file.kind,
        fileName: file.fileName,
        headers: file.headers,
        rowCount: file.rows.length,
        fields: IMPORT_FIELDS[file.kind].map(({ key, label, required, description }) => ({ key, label, required, description })),
        suggestedMapping: suggestMapping(file.kind, file.headers),
        sample: file.rows.slice(0, 5)
      }
    }),
    'imports:validate': route(importValidateSchema, (input) => {
      const session = getSession(input.sessionId)
      const result = validateImport(ctx(), session.file, input.mapping, { dateFormat: input.dateFormat })
      let validShown = 0
      const rows = result.rows.filter((r) => r.status !== 'VALID' || validShown++ < 1000)
      return { ...result, sessionId: input.sessionId, rows }
    }),
    'imports:commit': route(importCommitSchema, (input) => {
      const session = getSession(input.sessionId)
      const result = commitImport(ctx(), session.file, input.mapping, {
        dateFormat: input.dateFormat,
        confirmFinancial: input.confirmFinancial,
        skipInvalidRows: input.skipInvalidRows,
        importPossibleDuplicates: input.importPossibleDuplicates
      })
      importSessions.delete(input.sessionId)
      deps.logger.info(`CSV import ${session.file.kind}: ${result.importedRows} imported, ${result.failedRows} failed`)
      return result
    }),
    'imports:cancel': route(importCancelSchema, (input) => {
      importSessions.delete(input.sessionId)
      return { cancelled: true }
    }),
    'imports:history': route(emptySchema, () => listImportHistory(ctx())),

    'backup:status': route(emptySchema, (): BackupStatus => {
      const s = settings.readSettings(ctx())
      const folder = backupFolder()
      return {
        lastBackupAt: s.lastBackupAt,
        lastBackupFile: s.lastBackupFile,
        backupFolder: folder,
        autoBackupEnabled: s.autoBackupEnabled,
        daysSinceBackup: s.lastBackupAt ? Math.floor((ctx().now().getTime() - new Date(s.lastBackupAt).getTime()) / 86_400_000) : null,
        recentBackups: listRecentBackups(folder)
      }
    }),
    'backup:create': route(backupCreateSchema, async (input): Promise<BackupResult> => {
      const now = ctx().now()
      const name = backupFileName(now, input.encrypt)
      let destPath: string | null
      if (input.destination === 'CHOOSE') {
        destPath = await deps.dialogs.saveFile({
          title: 'Save database backup',
          defaultPath: join(backupFolder(), name),
          filters: input.encrypt
            ? [{ name: 'Encrypted backup', extensions: ['cmmbak'] }]
            : [{ name: 'SQLite backup', extensions: ['sqlite'] }]
        })
      } else {
        mkdirSync(backupFolder(), { recursive: true })
        destPath = join(backupFolder(), name)
      }
      if (!destPath) return { saved: false, fileName: null, folder: null, sizeBytes: 0, encrypted: input.encrypt, integrity: '', createdAt: null }
      const result = await writeBackup(deps.manager.db, destPath, { passphrase: input.encrypt ? input.passphrase : null })
      const fileName = basename(destPath)
      ctx().db.transaction(() => {
        settings.writeSetting(ctx(), 'lastBackupAt', now.toISOString())
        settings.writeSetting(ctx(), 'lastBackupFile', fileName)
        writeAudit(ctx(), { action: 'BACKUP_CREATED', entityType: 'database', entityId: null, summary: `${fileName}${result.encrypted ? ' (encrypted)' : ''}` })
      })()
      deps.logger.info(`Backup created (${result.sizeBytes} bytes, encrypted=${result.encrypted})`)
      return { saved: true, fileName, folder: destPath.slice(0, destPath.length - fileName.length - 1), sizeBytes: result.sizeBytes, encrypted: result.encrypted, integrity: result.integrity, createdAt: now.toISOString() }
    }),
    'backup:chooseFolder': route(emptySchema, async () => {
      const folder = await deps.dialogs.openDirectory({ title: 'Choose a backup folder' })
      if (folder) {
        settings.writeSetting(ctx(), 'backupFolder', folder)
        writeAudit(ctx(), { action: 'BACKUP_FOLDER_CHANGED', entityType: 'settings', entityId: null, summary: 'Backup folder changed' })
      }
      return settings.getSettings(ctx())
    }),
    'backup:pickRestore': route(emptySchema, async (): Promise<BackupInspection | null> => {
      prune()
      const filePath = await deps.dialogs.openFile({
        title: 'Choose a backup to restore',
        filters: [{ name: 'Customer Money Manager backup', extensions: ['sqlite', 'cmmbak', 'db'] }]
      })
      if (!filePath) return null
      const token = randomUUID()
      const prepared = prepareRestore(filePath, deps.manager.paths.workDir, null)
      restoreTokens.set(token, { sourcePath: filePath, plainPath: prepared.plainPath, createdAt: Date.now() })
      return { token, ...prepared.inspection }
    }),
    'backup:inspectRestore': route(restoreInspectSchema, (input): BackupInspection => {
      const entry = restoreTokens.get(input.token)
      if (!entry) throw new AppError('NOT_FOUND', 'Choose the backup file again.')
      if (entry.plainPath) rmSync(entry.plainPath, { force: true })
      const prepared = prepareRestore(entry.sourcePath, deps.manager.paths.workDir, input.passphrase)
      entry.plainPath = prepared.plainPath
      return { token: input.token, ...prepared.inspection }
    }),
    'backup:confirmRestore': route(restoreConfirmSchema, (input) => {
      const entry = restoreTokens.get(input.token)
      if (!entry || !entry.plainPath) throw new AppError('BACKUP_INVALID', 'The backup has not been validated. Choose it again.')
      try {
        const result = deps.manager.restoreFrom(entry.plainPath, basename(entry.sourcePath))
        deps.onDatabaseReplaced?.()
        return result
      } finally {
        rmSync(entry.plainPath, { force: true })
        restoreTokens.delete(input.token)
      }
    }),

    'audit:list': route(auditListSchema, (input) => listAudit(ctx(), input))
  }
}
