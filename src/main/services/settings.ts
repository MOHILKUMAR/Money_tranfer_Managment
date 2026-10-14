import { AppError } from '@shared/errors'
import { BALANCE_CONVENTION_ID } from '@shared/finance'
import { DEFAULT_CURRENCY, type CurrencyConfig } from '@shared/money'
import { settingsUpdateSchema, type SettingsUpdateInput } from '@shared/schemas'
import type { AppSettings } from '@shared/types'
import type { DateFormatOption } from '@shared/dates'
import { nowIso, writeAudit, type ServiceContext } from './context'

interface StoredSettings {
  businessName: string
  currency: CurrencyConfig
  dateFormat: DateFormatOption
  operatorName: string
  payoutOverdraftPolicy: 'BLOCK' | 'REQUIRE_OVERRIDE'
  backupFolder: string | null
  autoBackupEnabled: boolean
  autoBackupKeep: number
  lastBackupAt: string | null
  lastBackupFile: string | null
  lastAutoBackupAt: string | null
  balanceConvention: string
}

const DEFAULTS: StoredSettings = {
  businessName: '',
  currency: DEFAULT_CURRENCY,
  dateFormat: 'dd MMM yyyy',
  operatorName: '',
  payoutOverdraftPolicy: 'REQUIRE_OVERRIDE',
  backupFolder: null,
  autoBackupEnabled: false,
  autoBackupKeep: 14,
  lastBackupAt: null,
  lastBackupFile: null,
  lastAutoBackupAt: null,
  balanceConvention: BALANCE_CONVENTION_ID
}

export type SettingKey = keyof StoredSettings

export function readSettings(ctx: ServiceContext): StoredSettings {
  const rows = ctx.db.prepare('SELECT key, value FROM app_settings').all() as Array<{ key: string; value: string }>
  const stored: Partial<StoredSettings> = {}
  for (const row of rows) {
    if (row.key in DEFAULTS) {
      try {
        ;(stored as Record<string, unknown>)[row.key] = JSON.parse(row.value)
      } catch {
        // Ignore a corrupted value and fall back to the default.
      }
    }
  }
  return { ...DEFAULTS, ...stored }
}

export function writeSetting<K extends SettingKey>(ctx: ServiceContext, key: K, value: StoredSettings[K]): void {
  ctx.db
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), nowIso(ctx))
}

export function getCurrency(ctx: ServiceContext): CurrencyConfig {
  return readSettings(ctx).currency
}

export function isCurrencyLocked(ctx: ServiceContext): boolean {
  const row = ctx.db
    .prepare('SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM business_expenses) AS n')
    .get() as { n: number }
  return row.n > 0
}

export function getSettings(ctx: ServiceContext): AppSettings {
  const s = readSettings(ctx)
  return {
    businessName: s.businessName,
    currency: s.currency,
    currencyLocked: isCurrencyLocked(ctx),
    dateFormat: s.dateFormat,
    operatorName: s.operatorName,
    payoutOverdraftPolicy: s.payoutOverdraftPolicy,
    backupFolder: s.backupFolder,
    autoBackupEnabled: s.autoBackupEnabled,
    autoBackupKeep: s.autoBackupKeep,
    lastBackupAt: s.lastBackupAt,
    lastBackupFile: s.lastBackupFile,
    balanceConvention: s.balanceConvention
  }
}

export function updateSettings(ctx: ServiceContext, rawInput: SettingsUpdateInput): AppSettings {
  const input = settingsUpdateSchema.parse(rawInput)
  const run = ctx.db.transaction(() => {
    const before = readSettings(ctx)
    if (input.currency) {
      const changed =
        input.currency.code !== before.currency.code || input.currency.minorDigits !== before.currency.minorDigits
      if (changed && isCurrencyLocked(ctx)) {
        throw new AppError(
          'CURRENCY_LOCKED',
          'The currency cannot be changed after transactions have been recorded, because existing amounts would change meaning.'
        )
      }
      try {
        new Intl.NumberFormat(input.currency.locale, { style: 'currency', currency: input.currency.code })
      } catch {
        throw new AppError('VALIDATION', 'Unsupported currency or locale')
      }
      writeSetting(ctx, 'currency', input.currency)
    }
    if (input.businessName !== undefined) writeSetting(ctx, 'businessName', input.businessName)
    if (input.dateFormat !== undefined) writeSetting(ctx, 'dateFormat', input.dateFormat)
    if (input.operatorName !== undefined) writeSetting(ctx, 'operatorName', input.operatorName)
    if (input.payoutOverdraftPolicy !== undefined) {
      writeSetting(ctx, 'payoutOverdraftPolicy', input.payoutOverdraftPolicy)
    }
    if (input.autoBackupEnabled !== undefined) writeSetting(ctx, 'autoBackupEnabled', input.autoBackupEnabled)
    if (input.autoBackupKeep !== undefined) writeSetting(ctx, 'autoBackupKeep', input.autoBackupKeep)
    const after = readSettings(ctx)
    writeAudit(ctx, {
      action: 'SETTINGS_UPDATED',
      entityType: 'settings',
      entityId: null,
      summary: `Updated: ${Object.keys(input).join(', ')}`,
      before: pick(before, Object.keys(input)),
      after: pick(after, Object.keys(input))
    })
  })
  run()
  return getSettings(ctx)
}

function pick(source: StoredSettings, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) out[key] = (source as unknown as Record<string, unknown>)[key]
  return out
}
