/**
 * The 15-step end-to-end scenario from the specification, run against the
 * real services, a file-backed database, the IPC routes for exports, and a
 * real close/reopen cycle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseManager } from '../../src/main/db/manager'
import { createRouter } from '../../src/main/ipc/router'
import { buildRoutes } from '../../src/main/ipc/routes'
import { isTrustedRendererUrl } from '../../src/main/security'
import { parseCsv } from '../../src/shared/csv'
import { createCustomer, getCustomer } from '../../src/main/services/customers'
import { listLedger, recordPayout, recordReceipt } from '../../src/main/services/ledger'
import { recordUsageBatch } from '../../src/main/services/usage'
import { recordExpense } from '../../src/main/services/expenses'
import { getDashboard } from '../../src/main/services/analytics'
import { listLookups } from '../../src/main/services/lookups'
import { prepareRestore, writeBackup, verifyDatabaseFile } from '../../src/main/services/backup'
import { runIntegrityCheck } from '../../src/main/services/integrity'
import { key } from './helpers'

const SENDER = 'app://bundle/index.html'
let dir: string
let manager: DatabaseManager
let saveTarget = ''
const clock = { now: new Date('2026-10-15T11:00:00') }

function makeManager(root: string) {
  return new DatabaseManager(
    { dataDir: join(root, 'data'), dbPath: join(root, 'data', 'cmm.sqlite'), backupDir: join(root, 'backups'), workDir: join(root, 'tmp') },
    undefined,
    () => clock.now
  )
}

function router() {
  return createRouter(
    buildRoutes({
      manager,
      logger: { info() {}, warn() {}, error() {} },
      appMeta: () => ({ appVersion: 'test', demoMode: false, platform: 'test', isPackaged: false, dataFolder: dir }),
      defaultBackupDir: join(dir, 'backups'),
      defaultExportDir: () => dir,
      dialogs: { saveFile: async () => saveTarget, openFile: async () => null, openDirectory: async () => null },
      revealPath: () => {},
      printHtml: async () => {}
    }),
    { isTrustedSender: (u) => isTrustedRendererUrl(u) }
  )
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmm-flow-'))
  manager = makeManager(dir)
  manager.open()
})
afterAll(() => {
  if (manager.isOpen) manager.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('end-to-end workflow', () => {
  let customerId = 0
  const ids = { cash: 0, upi: 0, service: 0, hours: 0, rent: 0 }

  it('1–2. registers a customer with an opening balance', () => {
    const l = listLookups(manager.ctx)
    ids.cash = l.payment_methods.find((m) => m.name === 'Cash')!.id
    ids.upi = l.payment_methods.find((m) => m.name === 'UPI')!.id
    ids.service = l.usage_categories.find((m) => m.name === 'Service')!.id
    ids.hours = l.usage_units.find((m) => m.name === 'hours')!.id
    ids.rent = l.expense_categories.find((m) => m.name === 'Rent')!.id
    const r = createCustomer(manager.ctx, {
      name: 'ABC Traders',
      phone: '+91 98765 43210',
      registrationDate: '2026-10-01',
      openingBalance: { amountMinor: 100_000, date: '2026-10-01', explanation: 'Carried forward from old book' },
      idempotencyKey: key()
    })
    customerId = r.id
    expect(r.openingTxnReference).toMatch(/^OPN-/)
    expect(getCustomer(manager.ctx, customerId).balanceMinor).toBe(100_000)
  })

  it('3. records money received', () => {
    recordReceipt(manager.ctx, { customerId, date: '2026-10-05', amountMinor: 1_000_000, paymentMethodId: ids.upi, paymentReference: 'UTR123', idempotencyKey: key() })
    expect(getCustomer(manager.ctx, customerId).balanceMinor).toBe(1_100_000)
  })

  it('4. adds several daily usage entries on one date', () => {
    const r = recordUsageBatch(manager.ctx, {
      customerId,
      usageDate: '2026-10-15',
      idempotencyKey: key(),
      lines: [
        { categoryId: ids.service, description: 'Service A', method: 'QUANTITY', quantityMilli: 10_000, rateMinor: 10_000 },
        { categoryId: ids.service, description: 'Service B', method: 'QUANTITY', quantityMilli: 3_000, unitId: ids.hours, rateMinor: 20_000 },
        { categoryId: ids.service, description: 'Additional usage', method: 'FIXED', fixedAmountMinor: 25_000, fixedReason: 'Extra' }
      ]
    })
    expect(r.totalMinor).toBe(185_000)
  })

  it('5. records a payment back to the customer', () => {
    recordPayout(manager.ctx, { customerId, date: '2026-10-15', amountMinor: 150_000, paymentMethodId: ids.cash, reason: 'Return of unused advance', idempotencyKey: key() })
  })

  it('6. records a business expense that does not affect the customer', () => {
    recordExpense(manager.ctx, { date: '2026-10-15', categoryId: ids.rent, description: 'Office rent', amountMinor: 500_000, paymentMethodId: ids.cash, idempotencyKey: key() })
    expect(getCustomer(manager.ctx, customerId).balanceMinor).toBe(1_100_000 - 185_000 - 150_000)
  })

  it('7–8. opens the ledger and verifies the running balance', () => {
    const ledger = listLedger(manager.ctx, { customerId })
    expect(ledger.rows.map((r) => [r.type, r.runningBalanceMinor])).toEqual([
      ['OPENING_BALANCE', 100_000],
      ['RECEIPT', 1_100_000],
      ['USAGE', 1_000_000],
      ['USAGE', 940_000],
      ['USAGE', 915_000],
      ['PAYOUT', 765_000]
    ])
    expect(ledger.periodClosingMinor).toBe(765_000)
  })

  it('9. filters dashboard statistics to the month', () => {
    const d = getDashboard(manager.ctx, { from: '2026-10-01', to: '2026-10-31' })
    expect(d.periodKpis).toMatchObject({ receivedMinor: 1_000_000, paidMinor: 150_000, usageMinor: 185_000, expensesMinor: 500_000, netCashFlowMinor: 350_000 })
    expect(d.balances.creditOutstandingMinor).toBe(765_000)
    const september = getDashboard(manager.ctx, { from: '2026-09-01', to: '2026-09-30' })
    expect(september.periodKpis.receivedMinor).toBe(0)
  })

  it('10. exports the customer statement to CSV through IPC', async () => {
    saveTarget = join(dir, 'statement.csv')
    const res = await router().dispatch('reports:exportCsv', { kind: 'customer_statement', customerId, from: '2026-10-01', to: '2026-10-31' }, SENDER)
    expect(res).toMatchObject({ ok: true, data: { saved: true } })
    const csv = parseCsv(readFileSync(saveTarget, 'utf8'))
    const balanceCol = csv.headers.indexOf('Running Balance (INR)')
    expect(csv.rows.at(-1)![balanceCol]).toBe('7650.00')
  })

  it('11. exports a daily usage report', async () => {
    saveTarget = join(dir, 'usage.csv')
    const res = await router().dispatch('reports:exportCsv', { kind: 'usage', from: '2026-10-15', to: '2026-10-15' }, SENDER)
    expect(res).toMatchObject({ ok: true, data: { saved: true, rowCount: 3 } })
    const csv = parseCsv(readFileSync(saveTarget, 'utf8'))
    expect(csv.rows.map((r) => r[csv.headers.indexOf('Charge (INR)')])).toEqual(['1000.00', '600.00', '250.00'])
  })

  let backupPath = ''
  it('12. creates a full database backup', async () => {
    backupPath = join(dir, 'full-backup.sqlite')
    const result = await writeBackup(manager.db, backupPath)
    expect(result.integrity).toBe('ok')
  })

  it('13–14. closes and reopens the application; all data remains', () => {
    manager.close()
    manager = makeManager(dir)
    manager.open()
    expect(getCustomer(manager.ctx, customerId)).toMatchObject({ name: 'ABC Traders', balanceMinor: 765_000, usageMinor: 185_000 })
    expect(listLedger(manager.ctx).total).toBe(6)
    expect(runIntegrityCheck(manager.ctx).ok).toBe(true)
  })

  it('15. restores the backup into a separate test environment and verifies integrity', () => {
    const testRoot = join(dir, 'restore-env')
    const other = makeManager(testRoot)
    other.open()
    const prepared = prepareRestore(backupPath, other.paths.workDir, null)
    expect(prepared.inspection.valid).toBe(true)
    const result = other.restoreFrom(prepared.plainPath!, 'full-backup.sqlite')
    expect(result).toMatchObject({ restored: true, integrity: 'ok', counts: { customers: 1, transactions: 6, usageEntries: 3, expenses: 1 } })
    expect(getCustomer(other.ctx, customerId).balanceMinor).toBe(765_000)
    expect(runIntegrityCheck(other.ctx).ok).toBe(true)
    expect(verifyDatabaseFile(other.paths.dbPath).valid).toBe(true)
    other.close()
  })
})
