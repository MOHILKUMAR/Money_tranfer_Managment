import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openAndMigrate } from '../../src/main/db/connection'
import { createContext, type ServiceContext } from '../../src/main/services/context'
import { createCustomer } from '../../src/main/services/customers'
import { listLookups } from '../../src/main/services/lookups'
import type { Lookups } from '../../src/shared/types'

export interface TestEnv {
  dir: string
  dbPath: string
  db: Database.Database
  ctx: ServiceContext
  lookups: Lookups
  clock: { now: Date }
  cleanup(): void
}

/** Creates a migrated database in a temporary directory with a controllable clock. */
export function createTestEnv(now = new Date('2026-10-15T10:00:00')): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), 'cmm-test-'))
  const dbPath = join(dir, 'test.sqlite')
  const clock = { now }
  const { db } = openAndMigrate(dbPath)
  const ctx = createContext(db, () => clock.now)
  return {
    dir,
    dbPath,
    db,
    ctx,
    lookups: listLookups(ctx),
    clock,
    cleanup() {
      try {
        if (db.open) db.close()
      } catch {
        // already closed
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

export const key = (): string => randomUUID()

export function lookupId(lookups: Lookups, kind: keyof Lookups, name: string): number {
  const item = lookups[kind].find((l) => l.name.toLowerCase() === name.toLowerCase())
  if (!item) throw new Error(`Lookup ${kind}/${name} not found`)
  return item.id
}

export function addCustomer(
  env: TestEnv,
  name: string,
  opening?: { amountMinor: number; date?: string },
  extra: { phone?: string } = {}
): number {
  const result = createCustomer(env.ctx, {
    name,
    phone: extra.phone ?? null,
    registrationDate: '2026-10-01',
    status: 'ACTIVE',
    openingBalance: opening
      ? { amountMinor: opening.amountMinor, date: opening.date ?? '2026-10-01', explanation: 'Opening balance' }
      : null,
    idempotencyKey: key(),
    confirmPossibleDuplicate: true
  })
  return result.id
}
