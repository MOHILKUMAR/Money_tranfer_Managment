import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase } from '../../src/main/db/connection'
import { APPLICATION_ID, currentSchemaVersion, latestSchemaVersion, MIGRATIONS, runMigrations, type Migration } from '../../src/main/db/migrations'
import { DatabaseManager } from '../../src/main/db/manager'
import { createContext } from '../../src/main/services/context'
import { createCustomer, listCustomers } from '../../src/main/services/customers'
import { recordReceipt } from '../../src/main/services/ledger'
import { customerBalance } from '../../src/main/services/ledger-core'
import { listLookups } from '../../src/main/services/lookups'
import { decryptBuffer, encryptBuffer, prepareRestore, verifyDatabaseFile, writeBackup } from '../../src/main/services/backup'
import { runIntegrityCheck } from '../../src/main/services/integrity'
import { AppError } from '../../src/shared/errors'
import { key } from './helpers'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmm-db-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function manager(name = 'app') {
  return new DatabaseManager({
    dataDir: join(dir, name, 'data'),
    dbPath: join(dir, name, 'data', 'db.sqlite'),
    backupDir: join(dir, name, 'backups'),
    workDir: join(dir, name, 'tmp')
  })
}

function seed(m: DatabaseManager, name = 'Persisted Customer', amount = 123_456) {
  const c = createCustomer(m.ctx, { name, registrationDate: '2026-10-01', idempotencyKey: key(), confirmPossibleDuplicate: true })
  const cash = listLookups(m.ctx).payment_methods[0].id
  recordReceipt(m.ctx, { customerId: c.id, date: '2026-10-02', amountMinor: amount, paymentMethodId: cash, idempotencyKey: key() })
  return c.id
}

describe('database creation and migrations', () => {
  it('creates the schema with the application id, WAL and foreign keys', () => {
    const m = manager()
    const outcome = m.open()
    expect(outcome).toMatchObject({ fromVersion: 0, toVersion: latestSchemaVersion() })
    expect(m.db.pragma('application_id', { simple: true })).toBe(APPLICATION_ID)
    expect(m.db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(m.db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(m.db.pragma('synchronous', { simple: true })).toBe(2)
    const tables = (m.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name)
    for (const t of ['customers', 'transactions', 'usage_categories', 'daily_usage_entries', 'expense_categories', 'business_expenses', 'audit_logs', 'app_settings', 'schema_migrations', 'csv_import_history']) {
      expect(tables).toContain(t)
    }
    m.close()
  })

  it('is idempotent on reopen and preserves data across restarts', () => {
    const m = manager()
    m.open()
    const id = seed(m)
    m.close()
    const again = manager()
    expect(again.open().applied).toEqual([])
    expect(customerBalance(again.ctx, id)).toBe(123_456)
    expect(listCustomers(again.ctx).rows[0].name).toBe('Persisted Customer')
    again.close()
  })

  it('applies a new migration, writes a safety backup first, and keeps existing records', () => {
    const m = manager()
    m.open()
    seed(m)
    m.close()
    const extra: Migration = {
      version: latestSchemaVersion() + 1,
      name: 'add_customer_tags',
      up(db) {
        db.exec('ALTER TABLE customers ADD COLUMN tags TEXT')
      }
    }
    const db = openDatabase(join(dir, 'app', 'data', 'db.sqlite'))
    let backupTaken = false
    const outcome = runMigrations(db, {
      migrations: [...MIGRATIONS, extra],
      beforeMigrate: () => {
        backupTaken = true
        db.prepare('VACUUM INTO ?').run(join(dir, 'pre.sqlite'))
      }
    })
    expect(backupTaken).toBe(true)
    expect(outcome.applied).toEqual([`${extra.version}_add_customer_tags`])
    expect(currentSchemaVersion(db)).toBe(extra.version)
    expect((db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n).toBe(1)
    expect(verifyDatabaseFile(join(dir, 'pre.sqlite')).schemaVersion).toBe(latestSchemaVersion())
    db.close()
  })

  it('rolls back a failing migration and leaves the previous version intact', () => {
    const m = manager()
    m.open()
    seed(m)
    m.close()
    const broken: Migration = {
      version: latestSchemaVersion() + 1,
      name: 'broken',
      up(db) {
        db.exec('ALTER TABLE customers ADD COLUMN half_done TEXT')
        db.exec('THIS IS NOT SQL')
      }
    }
    const db = openDatabase(join(dir, 'app', 'data', 'db.sqlite'))
    expect(() => runMigrations(db, { migrations: [...MIGRATIONS, broken] })).toThrow(/rolled back/)
    expect(currentSchemaVersion(db)).toBe(latestSchemaVersion())
    const columns = (db.prepare('PRAGMA table_info(customers)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).not.toContain('half_done')
    db.close()
  })

  it('refuses databases from newer versions or other applications', () => {
    const foreign = new Database(join(dir, 'foreign.sqlite'))
    foreign.exec('CREATE TABLE other (x)')
    expect(() => runMigrations(foreign)).toThrow(/not created by Customer Money Manager/)
    foreign.close()
    const m = manager()
    m.open()
    m.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, ?, ?)').run('future', 'now')
    m.close()
    expect(() => manager().open()).toThrow(/newer than this application supports/)
  })
})

describe('backup and restore', () => {
  it('writes a consistent, verified backup while the database is open', async () => {
    const m = manager()
    m.open()
    seed(m)
    const dest = join(dir, 'backup.sqlite')
    const result = await writeBackup(m.db, dest)
    expect(result).toMatchObject({ integrity: 'ok', encrypted: false })
    const verified = verifyDatabaseFile(dest)
    expect(verified).toMatchObject({ valid: true, schemaVersion: latestSchemaVersion(), counts: { customers: 1, transactions: 1 } })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    m.close()
  })

  it('encrypts backups with AES-256-GCM and rejects wrong passphrases or tampering', async () => {
    const m = manager()
    m.open()
    seed(m)
    const dest = join(dir, 'backup.cmmbak')
    await writeBackup(m.db, dest, { passphrase: 'correct horse battery' })
    const bytes = readFileSync(dest)
    expect(bytes.subarray(0, 8).toString()).toBe('CMMBAK01')
    expect(bytes.includes(Buffer.from('Persisted Customer'))).toBe(false)
    expect(() => decryptBuffer(bytes, 'wrong passphrase')).toThrow(AppError)
    const tampered = Buffer.from(bytes)
    tampered[200] ^= 0xff
    expect(() => decryptBuffer(tampered, 'correct horse battery')).toThrow(/incorrect|damaged/)
    expect(decryptBuffer(encryptBuffer(Buffer.from('hello'), 'pw-123456'), 'pw-123456').toString()).toBe('hello')
    const needs = prepareRestore(dest, join(dir, 'app', 'tmp'), null)
    expect(needs.inspection.needsPassphrase).toBe(true)
    const ok = prepareRestore(dest, join(dir, 'app', 'tmp'), 'correct horse battery')
    expect(ok.inspection.valid).toBe(true)
    m.close()
  })

  it('restores a backup: safety copy first, full replacement (no mixing), integrity verified', async () => {
    const m = manager()
    m.open()
    const original = seed(m, 'Before Backup', 1_000)
    const dest = join(dir, 'snapshot.sqlite')
    await writeBackup(m.db, dest)
    seed(m, 'After Backup', 2_000)
    expect(listCustomers(m.ctx).total).toBe(2)
    const prepared = prepareRestore(dest, m.paths.workDir, null)
    expect(prepared.inspection.valid).toBe(true)
    const result = m.restoreFrom(prepared.plainPath!, 'snapshot.sqlite')
    expect(result).toMatchObject({ restored: true, integrity: 'ok', counts: { customers: 1, transactions: 1 } })
    expect(listCustomers(m.ctx).rows.map((c) => c.name)).toEqual(['Before Backup'])
    expect(customerBalance(m.ctx, original)).toBe(1_000)
    expect(runIntegrityCheck(m.ctx).ok).toBe(true)
    // The safety backup contains the pre-restore state.
    const safety = verifyDatabaseFile(join(m.paths.backupDir, result.safetyBackupFile))
    expect(safety.counts?.customers).toBe(2)
    m.close()
  })

  it('rejects invalid backup files without touching live data', () => {
    const m = manager()
    m.open()
    seed(m)
    const junk = join(dir, 'junk.sqlite')
    writeFileSync(junk, 'not a database at all')
    const prepared = prepareRestore(junk, m.paths.workDir, null)
    expect(prepared.inspection.valid).toBe(false)
    expect(prepared.plainPath).toBeNull()
    const foreign = join(dir, 'foreign.sqlite')
    const f = new Database(foreign)
    f.exec('CREATE TABLE x (y)')
    f.close()
    expect(prepareRestore(foreign, m.paths.workDir, null).inspection.problems.join(' ')).toMatch(/not created by Customer Money Manager/)
    expect(() => m.restoreFrom(junk, 'junk')).toThrow(AppError)
    expect(listCustomers(m.ctx).total).toBe(1)
    m.close()
  })

  it('integrity check passes on a healthy ledger and detects tampering', () => {
    const m = manager()
    m.open()
    seed(m)
    expect(runIntegrityCheck(m.ctx)).toMatchObject({ ok: true, sqliteIntegrity: 'ok', foreignKeyViolations: 0 })
    // Simulate tampering outside the app (triggers bypassed by dropping them in a raw connection).
    m.close()
    const raw = new Database(m.paths.dbPath)
    raw.exec('DROP TRIGGER trg_usage_no_delete; DROP TRIGGER trg_transactions_no_delete;')
    const ctx = createContext(raw)
    const svc = listLookups(ctx).usage_categories[0].id
    raw.prepare(
      `INSERT INTO daily_usage_entries (customer_id, usage_date, category_id, description, method, base_amount_minor, charge_minor, batch_key, line_no, created_at, updated_at)
       VALUES (1, '2026-10-02', ?, 'orphan', 'FIXED', 500, 500, 'x', 0, 'now', 'now')`
    ).run(svc)
    const report = runIntegrityCheck(ctx)
    expect(report.ok).toBe(false)
    expect(report.problems.join(' ')).toMatch(/not posted to the ledger exactly once/)
    raw.close()
    expect(existsSync(m.paths.dbPath)).toBe(true)
  })
})
