import type Database from 'better-sqlite3'
import { AppError } from '@shared/errors'
import { migration001 } from './migrations/001_initial'

export interface Migration {
  version: number
  name: string
  up(db: Database.Database): void
}

/** "CMM1" — identifies Customer Money Manager database files. */
export const APPLICATION_ID = 0x434d4d31

/** Ordered list of schema migrations. Append only; never edit a released migration. */
export const MIGRATIONS: readonly Migration[] = [migration001]

export function latestSchemaVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0)
}

export function currentSchemaVersion(db: Database.Database): number {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { present: number } | undefined
  if (!table) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null
  }
  return row.version ?? 0
}

function userTableCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number }
  return row.n
}

export interface MigrationOutcome {
  fromVersion: number
  toVersion: number
  applied: string[]
}

export interface RunMigrationsOptions {
  migrations?: readonly Migration[]
  /** Called once before the first pending migration on an existing database (e.g. to take a safety backup). */
  beforeMigrate?: (fromVersion: number, toVersion: number) => void
  now?: () => Date
}

/**
 * Applies pending migrations in order. Each migration runs inside its own
 * transaction together with its schema_migrations record, so a failure leaves
 * the database at the previous version. Never drops user data.
 */
export function runMigrations(db: Database.Database, options: RunMigrationsOptions = {}): MigrationOutcome {
  const migrations = [...(options.migrations ?? MIGRATIONS)].sort((a, b) => a.version - b.version)
  const now = options.now ?? (() => new Date())
  const latest = latestSchemaVersion(migrations)

  const appId = db.pragma('application_id', { simple: true }) as number
  const existingTables = userTableCount(db)
  if (existingTables > 0 && appId !== APPLICATION_ID) {
    throw new AppError(
      'DB_ERROR',
      'The database file was not created by Customer Money Manager and will not be modified.'
    )
  }

  const fromVersion = currentSchemaVersion(db)
  if (fromVersion > latest) {
    throw new AppError(
      'DB_ERROR',
      `This database uses schema version ${fromVersion}, which is newer than this application supports (${latest}). Install the newer application version.`
    )
  }

  const pending = migrations.filter((m) => m.version > fromVersion)
  if (pending.length === 0) return { fromVersion, toVersion: fromVersion, applied: [] }

  if (fromVersion > 0 && options.beforeMigrate) options.beforeMigrate(fromVersion, latest)

  const applied: string[] = []
  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        now().toISOString()
      )
      db.pragma(`user_version = ${migration.version}`)
      if (migration.version === pending[0].version && fromVersion === 0) {
        db.pragma(`application_id = ${APPLICATION_ID}`)
      }
    })
    try {
      apply()
    } catch (error) {
      throw new AppError(
        'DB_ERROR',
        `Database upgrade to version ${migration.version} (${migration.name}) failed and was rolled back: ${
          (error as Error).message
        }`
      )
    }
    applied.push(`${migration.version}_${migration.name}`)
  }
  return { fromVersion, toVersion: latest, applied }
}
