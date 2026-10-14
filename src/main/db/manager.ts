import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { AppError } from '@shared/errors'
import type { RestoreResult } from '@shared/types'
import { openDatabase } from './connection'
import { runMigrations, type MigrationOutcome } from './migrations'
import { createContext, writeAudit, type ServiceContext } from '../services/context'
import { backupFileName, removeDatabaseFiles, verifyDatabaseFile, writeSnapshotSync } from '../services/backup'
import { runIntegrityCheck } from '../services/integrity'

export interface DatabasePaths {
  dataDir: string
  dbPath: string
  backupDir: string
  workDir: string
}

export interface LoggerLike {
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

const silentLogger: LoggerLike = { info() {}, warn() {}, error() {} }

/**
 * Owns the single SQLite connection used by the main process, including
 * migrations with pre-migration safety backups and whole-file restores.
 */
export class DatabaseManager {
  private connection: Database.Database | null = null
  private context: ServiceContext | null = null
  lastMigration: MigrationOutcome | null = null

  constructor(
    readonly paths: DatabasePaths,
    private readonly logger: LoggerLike = silentLogger,
    private readonly now: () => Date = () => new Date()
  ) {}

  open(): MigrationOutcome {
    for (const dir of [this.paths.dataDir, this.paths.backupDir, this.paths.workDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const db = openDatabase(this.paths.dbPath)
    try {
      const outcome = runMigrations(db, {
        now: this.now,
        beforeMigrate: (from, to) => {
          const name = backupFileName(this.now(), false, `pre-migration-v${from}-to-v${to}`)
          writeSnapshotSync(db, join(this.paths.backupDir, name))
          this.logger.info(`Safety backup before migration written: ${name}`)
        }
      })
      if (outcome.applied.length) this.logger.info(`Applied migrations: ${outcome.applied.join(', ')}`)
      const quick = db.pragma('quick_check', { simple: true })
      if (quick !== 'ok') this.logger.warn(`quick_check reported: ${String(quick).slice(0, 200)}`)
      this.connection = db
      this.context = createContext(db, this.now)
      this.lastMigration = outcome
      if (process.platform !== 'win32') {
        try {
          chmodSync(this.paths.dbPath, 0o600)
        } catch {
          // best effort
        }
      }
      return outcome
    } catch (error) {
      db.close()
      throw error
    }
  }

  get isOpen(): boolean {
    return this.connection !== null
  }

  get db(): Database.Database {
    if (!this.connection) throw new AppError('DB_ERROR', 'The database is not open')
    return this.connection
  }

  get ctx(): ServiceContext {
    if (!this.context) throw new AppError('DB_ERROR', 'The database is not open')
    return this.context
  }

  close(): void {
    if (this.connection) {
      try {
        this.connection.pragma('wal_checkpoint(TRUNCATE)')
      } catch {
        // ignore — closing still checkpoints
      }
      this.connection.close()
    }
    this.connection = null
    this.context = null
  }

  /**
   * Replaces the live database with a validated plain SQLite file. A safety
   * snapshot of the current data is written first; if anything fails, the
   * snapshot is put back.
   */
  restoreFrom(plainPath: string, sourceLabel: string): RestoreResult {
    const incoming = verifyDatabaseFile(plainPath)
    if (!incoming.valid) throw new AppError('BACKUP_INVALID', incoming.problems.join('; '))
    const safetyName = backupFileName(this.now(), false, 'pre-restore')
    const safetyPath = join(this.paths.backupDir, safetyName)
    writeSnapshotSync(this.db, safetyPath)
    const safety = verifyDatabaseFile(safetyPath)
    if (!safety.valid) {
      throw new AppError('BACKUP_INVALID', 'Could not create a valid safety backup; restore cancelled and nothing was changed.')
    }
    this.logger.info(`Restore: safety backup ${safetyName} written`)
    this.close()
    const staging = `${this.paths.dbPath}.restoring`
    try {
      copyFileSync(plainPath, staging)
      removeDatabaseFiles(this.paths.dbPath)
      renameSync(staging, this.paths.dbPath)
      this.open()
      const report = runIntegrityCheck(this.ctx)
      if (!report.ok) throw new AppError('BACKUP_INVALID', `Restored data failed checks: ${report.problems.join('; ')}`)
      writeAudit(this.ctx, {
        action: 'DATABASE_RESTORED',
        entityType: 'database',
        entityId: null,
        summary: `Restored from ${sourceLabel}; previous data saved as ${safetyName}`
      })
      this.logger.info('Restore completed')
      return {
        restored: true,
        safetyBackupFile: safetyName,
        integrity: report.sqliteIntegrity,
        counts: {
          customers: report.counts.customers,
          transactions: report.counts.transactions,
          expenses: report.counts.expenses,
          usageEntries: report.counts.usageEntries
        }
      }
    } catch (error) {
      this.logger.error('Restore failed; rolling back to safety backup', error)
      try {
        this.close()
      } catch {
        // ignore
      }
      rmSync(staging, { force: true })
      removeDatabaseFiles(this.paths.dbPath)
      copyFileSync(safetyPath, this.paths.dbPath)
      this.open()
      throw new AppError(
        'BACKUP_INVALID',
        `Restore failed and your previous data was put back: ${(error as Error).message}`
      )
    }
  }

  databaseExists(): boolean {
    return existsSync(this.paths.dbPath)
  }
}
