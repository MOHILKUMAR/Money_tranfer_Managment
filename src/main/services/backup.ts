/**
 * Backup and restore.
 *
 *  - Backups use SQLite's online backup API (consistent snapshot while the app
 *    is open). Safety copies taken synchronously use `VACUUM INTO`.
 *  - Every backup is re-opened and integrity-checked before it is reported as saved.
 *  - Optional encryption: AES-256-GCM, key derived from a passphrase with scrypt.
 *    The passphrase is never stored.
 *  - Restore validates the file first, takes a safety backup of the current
 *    database, then replaces the whole file (never merges) and re-verifies.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type Database from 'better-sqlite3'
import { AppError } from '@shared/errors'
import type { BackupInspection } from '@shared/types'
import { openDatabase } from '../db/connection'
import { APPLICATION_ID, currentSchemaVersion, latestSchemaVersion } from '../db/migrations'

const MAGIC = Buffer.from('CMMBAK01', 'ascii')
const SQLITE_HEADER = Buffer.from('SQLite format 3\u0000', 'binary')
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }
const MAX_ENCRYPTED_BYTES = 1024 * 1024 * 1024

const REQUIRED_TABLES = [
  'customers',
  'transactions',
  'daily_usage_entries',
  'business_expenses',
  'audit_logs',
  'app_settings',
  'schema_migrations'
]

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT)
}

export function encryptBuffer(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  cipher.setAAD(MAGIC)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()])
}

export function decryptBuffer(data: Buffer, passphrase: string): Buffer {
  if (!isEncryptedBackupBuffer(data) || data.length < MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new AppError('BACKUP_INVALID', 'Not an encrypted Customer Money Manager backup')
  }
  const salt = data.subarray(MAGIC.length, MAGIC.length + SALT_BYTES)
  const iv = data.subarray(MAGIC.length + SALT_BYTES, MAGIC.length + SALT_BYTES + IV_BYTES)
  const tag = data.subarray(data.length - TAG_BYTES)
  const body = data.subarray(MAGIC.length + SALT_BYTES + IV_BYTES, data.length - TAG_BYTES)
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
    decipher.setAAD(MAGIC)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new AppError('BACKUP_INVALID', 'The passphrase is incorrect or the backup file is damaged')
  }
}

export function isEncryptedBackupBuffer(data: Buffer): boolean {
  return data.length >= MAGIC.length && data.subarray(0, MAGIC.length).equals(MAGIC)
}

function readHeader(filePath: string, bytes: number): Buffer {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export interface VerifiedDatabase {
  valid: boolean
  problems: string[]
  integrity: string
  schemaVersion: number | null
  counts: BackupInspection['counts']
  lastTransactionDate: string | null
}

/** Opens a database file read-only and checks it is a healthy Customer Money Manager database. */
export function verifyDatabaseFile(filePath: string): VerifiedDatabase {
  const problems: string[] = []
  if (!readHeader(filePath, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    return { valid: false, problems: ['The file is not a SQLite database'], integrity: 'not sqlite', schemaVersion: null, counts: null, lastTransactionDate: null }
  }
  let db: Database.Database | null = null
  try {
    db = openDatabase(filePath, { readonly: true, fileMustExist: true })
    const integrityRows = db.pragma('integrity_check') as Array<{ integrity_check: string }>
    const integrity = integrityRows.map((r) => r.integrity_check).join('; ')
    if (integrity !== 'ok') problems.push(`SQLite integrity check failed: ${integrity.slice(0, 300)}`)
    const appId = db.pragma('application_id', { simple: true }) as number
    if (appId !== APPLICATION_ID) problems.push('The database was not created by Customer Money Manager')
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name)
    )
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t))
    if (missing.length) problems.push(`Missing tables: ${missing.join(', ')}`)
    const schemaVersion = tables.has('schema_migrations') ? currentSchemaVersion(db) : null
    if (schemaVersion !== null && schemaVersion > latestSchemaVersion()) {
      problems.push(`The backup uses schema version ${schemaVersion}; this application supports up to ${latestSchemaVersion()}`)
    }
    const fkViolations = db.pragma('foreign_key_check') as unknown[]
    if (fkViolations.length > 0) problems.push(`${fkViolations.length} foreign key violation(s)`)
    let counts: BackupInspection['counts'] = null
    let lastTransactionDate: string | null = null
    if (missing.length === 0) {
      const count = (table: string) => (db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      counts = {
        customers: count('customers'),
        transactions: count('transactions'),
        expenses: count('business_expenses'),
        usageEntries: count('daily_usage_entries')
      }
      lastTransactionDate = (db.prepare('SELECT MAX(txn_date) AS d FROM transactions').get() as { d: string | null }).d
    }
    return { valid: problems.length === 0, problems, integrity, schemaVersion, counts, lastTransactionDate }
  } catch (error) {
    return {
      valid: false,
      problems: [`The file could not be opened as a database: ${(error as Error).message}`],
      integrity: 'error',
      schemaVersion: null,
      counts: null,
      lastTransactionDate: null
    }
  } finally {
    db?.close()
  }
}

export interface BackupWriteResult {
  sizeBytes: number
  integrity: string
  encrypted: boolean
}

/**
 * Writes a verified backup of `db` to `destPath`. The snapshot is written to a
 * temporary file next to the destination, verified, optionally encrypted, and
 * then moved into place so a failed backup never leaves a partial file.
 */
export async function writeBackup(
  db: Database.Database,
  destPath: string,
  options: { passphrase?: string | null } = {}
): Promise<BackupWriteResult> {
  const tmpPath = join(dirname(destPath), `.${basename(destPath)}.${randomUUID()}.tmp`)
  try {
    await db.backup(tmpPath)
    const verified = verifyDatabaseFile(tmpPath)
    if (!verified.valid) {
      throw new AppError('BACKUP_INVALID', `Backup verification failed: ${verified.problems.join('; ')}`)
    }
    if (options.passphrase) {
      const size = statSync(tmpPath).size
      if (size > MAX_ENCRYPTED_BYTES) throw new AppError('VALIDATION', 'The database is too large for an encrypted backup')
      writeFileSync(destPath, encryptBuffer(readFileSync(tmpPath), options.passphrase), { mode: 0o600 })
      rmSync(tmpPath, { force: true })
    } else {
      renameSync(tmpPath, destPath)
    }
    return { sizeBytes: statSync(destPath).size, integrity: verified.integrity, encrypted: !!options.passphrase }
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

/** Synchronous consistent copy (used for safety backups before migrations and restores). */
export function writeSnapshotSync(db: Database.Database, destPath: string): void {
  if (existsSync(destPath)) throw new AppError('CONFLICT', 'Snapshot destination already exists')
  db.prepare('VACUUM INTO ?').run(destPath)
}

export interface PreparedRestore {
  inspection: Omit<BackupInspection, 'token'>
  /** Path of a plain SQLite file ready to be copied over the live database (if valid). */
  plainPath: string | null
}

/**
 * Validates a backup file. Encrypted backups are decrypted into `workDir`
 * first. Nothing in the live database is touched.
 */
export function prepareRestore(sourcePath: string, workDir: string, passphrase?: string | null): PreparedRestore {
  const sizeBytes = statSync(sourcePath).size
  const fileName = basename(sourcePath)
  const header = readHeader(sourcePath, MAGIC.length)
  const encrypted = isEncryptedBackupBuffer(header)
  const base = { fileName, encrypted, sizeBytes }
  let plainPath: string
  if (encrypted) {
    if (!passphrase) {
      return {
        inspection: { ...base, needsPassphrase: true, valid: false, problems: [], schemaVersion: null, counts: null, lastTransactionDate: null },
        plainPath: null
      }
    }
    if (sizeBytes > MAX_ENCRYPTED_BYTES) throw new AppError('BACKUP_INVALID', 'The encrypted backup is too large')
    const plain = decryptBuffer(readFileSync(sourcePath), passphrase)
    plainPath = join(workDir, `restore-${randomUUID()}.sqlite`)
    writeFileSync(plainPath, plain, { mode: 0o600 })
  } else {
    // Work on a private copy so the source file cannot change between validation and restore.
    const copyPath = join(workDir, `restore-${randomUUID()}.sqlite`)
    writeFileSync(copyPath, readFileSync(sourcePath), { mode: 0o600 })
    plainPath = copyPath
  }
  const verified = verifyDatabaseFile(plainPath)
  return {
    inspection: {
      ...base,
      needsPassphrase: false,
      valid: verified.valid,
      problems: verified.problems,
      schemaVersion: verified.schemaVersion,
      counts: verified.counts,
      lastTransactionDate: verified.lastTransactionDate
    },
    plainPath: verified.valid ? plainPath : (rmSync(plainPath, { force: true }), null)
  }
}

export function removeDatabaseFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${dbPath}${suffix}`, { force: true })
}

export function backupFileName(now: Date, encrypted: boolean, prefix = 'customer-money-manager'): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}-${stamp}${encrypted ? '.cmmbak' : '.sqlite'}`
}
