import Database from 'better-sqlite3'
import { runMigrations, type RunMigrationsOptions, type MigrationOutcome } from './migrations'

export interface OpenOptions {
  readonly?: boolean
  fileMustExist?: boolean
}

/**
 * Opens a SQLite connection with the application's safety settings:
 *  - foreign keys enforced
 *  - WAL journal + synchronous=FULL so committed transactions survive crashes/power loss
 *  - trusted_schema=OFF so schema-embedded functions cannot run unexpectedly
 */
export function openDatabase(filePath: string, options: OpenOptions = {}): Database.Database {
  const db = new Database(filePath, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false
  })
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('trusted_schema = OFF')
  if (!options.readonly) {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
  }
  return db
}

/** Opens (creating if needed) and migrates a database. Used by the app and tests. */
export function openAndMigrate(
  filePath: string,
  options: RunMigrationsOptions = {}
): { db: Database.Database; migration: MigrationOutcome } {
  const db = openDatabase(filePath)
  try {
    const migration = runMigrations(db, options)
    return { db, migration }
  } catch (error) {
    db.close()
    throw error
  }
}
