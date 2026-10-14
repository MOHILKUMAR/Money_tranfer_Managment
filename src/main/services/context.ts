import type Database from 'better-sqlite3'
import { AppError } from '@shared/errors'
import { todayIso } from '@shared/dates'

export interface ServiceContext {
  db: Database.Database
  now: () => Date
}

export function createContext(db: Database.Database, now: () => Date = () => new Date()): ServiceContext {
  return { db, now }
}

export function nowIso(ctx: ServiceContext): string {
  return ctx.now().toISOString()
}

export function today(ctx: ServiceContext): string {
  return todayIso(ctx.now())
}

/** Operator name recorded on new entries (single-user mode; not an authenticated identity). */
export function currentActor(ctx: ServiceContext): string | null {
  const row = ctx.db.prepare("SELECT value FROM app_settings WHERE key = 'operatorName'").get() as
    | { value: string }
    | undefined
  const name = row ? (JSON.parse(row.value) as string) : ''
  return name && name.trim() ? name.trim() : null
}

export function blankToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 0) return null
  // Compare on the last 10 digits so "+91 98765 43210" matches "9876543210".
  return digits.length > 10 ? digits.slice(-10) : digits
}

/** Allocates the next value of a named sequence. Must run inside a transaction. */
export function nextSequence(ctx: ServiceContext, name: string): number {
  const row = ctx.db
    .prepare('UPDATE sequences SET next_value = next_value + 1 WHERE name = ? RETURNING next_value - 1 AS value')
    .get(name) as { value: number } | undefined
  if (!row) throw new AppError('INTERNAL', `Unknown sequence ${name}`)
  return row.value
}

export function formatReference(prefix: string, value: number): string {
  return `${prefix}-${String(value).padStart(6, '0')}`
}

export function nextReference(ctx: ServiceContext, prefix: string): string {
  // Skip any value whose reference already exists (e.g. after a restore or import).
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const reference = formatReference(prefix, nextSequence(ctx, prefix))
    const table = prefix === 'EXP' ? 'business_expenses' : 'transactions'
    const exists = ctx.db.prepare(`SELECT 1 FROM ${table} WHERE reference = ?`).get(reference)
    if (!exists) return reference
  }
  throw new AppError('INTERNAL', 'Could not allocate a unique reference')
}

export interface AuditInput {
  action: string
  entityType: string
  entityId: string | number | null
  summary?: string | null
  before?: unknown
  after?: unknown
  reason?: string | null
}

export function writeAudit(ctx: ServiceContext, input: AuditInput): void {
  ctx.db
    .prepare(
      `INSERT INTO audit_logs (occurred_at, actor, action, entity_type, entity_id, summary, before_json, after_json, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      nowIso(ctx),
      currentActor(ctx),
      input.action,
      input.entityType,
      input.entityId === null ? null : String(input.entityId),
      input.summary ?? null,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null
    )
}

export function pageBounds(page: number, pageSize: number): { limit: number; offset: number } {
  return { limit: pageSize, offset: (page - 1) * pageSize }
}

/** Escapes LIKE wildcards in user search text. Use with ESCAPE '\\'. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

export function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined || row === null) throw new AppError('NOT_FOUND', message)
  return row
}
