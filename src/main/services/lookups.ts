import { AppError } from '@shared/errors'
import {
  LOOKUP_KINDS,
  lookupCreateSchema,
  lookupUpdateSchema,
  type LookupKind
} from '@shared/schemas'
import type { LookupItem, Lookups } from '@shared/types'
import { nowIso, requireRow, writeAudit, type ServiceContext } from './context'
import type { z } from 'zod'

/** Whitelist of lookup tables; table names are never taken from user input. */
const TABLES: Record<LookupKind, string> = {
  payment_methods: 'payment_methods',
  transaction_categories: 'transaction_categories',
  usage_categories: 'usage_categories',
  usage_units: 'usage_units',
  expense_categories: 'expense_categories'
}

interface LookupRow {
  id: number
  name: string
  is_active: number
  sort_order: number
  applies_to?: string | null
}

function toItem(row: LookupRow): LookupItem {
  return {
    id: row.id,
    name: row.name,
    isActive: row.is_active === 1,
    sortOrder: row.sort_order,
    appliesTo: (row.applies_to as LookupItem['appliesTo']) ?? null
  }
}

export function listLookups(ctx: ServiceContext): Lookups {
  const out = {} as Lookups
  for (const kind of LOOKUP_KINDS) {
    const rows = ctx.db
      .prepare(`SELECT * FROM ${TABLES[kind]} ORDER BY sort_order, name COLLATE NOCASE`)
      .all() as LookupRow[]
    out[kind] = rows.map(toItem)
  }
  return out
}

export function getLookup(ctx: ServiceContext, kind: LookupKind, id: number): LookupItem {
  const row = ctx.db.prepare(`SELECT * FROM ${TABLES[kind]} WHERE id = ?`).get(id) as LookupRow | undefined
  return toItem(requireRow(row, 'The selected option no longer exists'))
}

/** Ensures a referenced lookup exists and is active (inactive values are kept for history only). */
export function requireActiveLookup(ctx: ServiceContext, kind: LookupKind, id: number, label: string): LookupItem {
  const row = ctx.db.prepare(`SELECT * FROM ${TABLES[kind]} WHERE id = ?`).get(id) as LookupRow | undefined
  if (!row) throw new AppError('VALIDATION', `${label} does not exist`)
  if (row.is_active !== 1) throw new AppError('VALIDATION', `${label} "${row.name}" is inactive`)
  return toItem(row)
}

export function findLookupByName(ctx: ServiceContext, kind: LookupKind, name: string): LookupItem | null {
  const row = ctx.db
    .prepare(`SELECT * FROM ${TABLES[kind]} WHERE name = ? COLLATE NOCASE`)
    .get(name.trim()) as LookupRow | undefined
  return row ? toItem(row) : null
}

export function createLookup(ctx: ServiceContext, raw: z.input<typeof lookupCreateSchema>): LookupItem {
  const input = lookupCreateSchema.parse(raw)
  const table = TABLES[input.kind]
  const run = ctx.db.transaction(() => {
    if (findLookupByName(ctx, input.kind, input.name)) {
      throw new AppError('CONFLICT', `"${input.name}" already exists`)
    }
    const maxOrder = ctx.db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM ${table}`).get() as { m: number }
    const result =
      input.kind === 'transaction_categories'
        ? ctx.db
            .prepare(`INSERT INTO ${table} (name, applies_to, sort_order, created_at) VALUES (?, ?, ?, ?)`)
            .run(input.name, input.appliesTo ?? 'ANY', maxOrder.m + 1, nowIso(ctx))
        : ctx.db
            .prepare(`INSERT INTO ${table} (name, sort_order, created_at) VALUES (?, ?, ?)`)
            .run(input.name, maxOrder.m + 1, nowIso(ctx))
    const id = Number(result.lastInsertRowid)
    writeAudit(ctx, { action: 'LOOKUP_CREATED', entityType: table, entityId: id, summary: input.name })
    return getLookup(ctx, input.kind, id)
  })
  return run()
}

export function updateLookup(ctx: ServiceContext, raw: z.input<typeof lookupUpdateSchema>): LookupItem {
  const input = lookupUpdateSchema.parse(raw)
  const table = TABLES[input.kind]
  const run = ctx.db.transaction(() => {
    const before = getLookup(ctx, input.kind, input.id)
    if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
      const clash = findLookupByName(ctx, input.kind, input.name)
      if (clash && clash.id !== input.id) throw new AppError('CONFLICT', `"${input.name}" already exists`)
    }
    if (input.isActive === false) {
      const activeCount = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE is_active = 1 AND id <> ?`)
        .get(input.id) as { n: number }
      if (activeCount.n === 0) throw new AppError('VALIDATION', 'At least one option must remain active')
    }
    ctx.db
      .prepare(
        `UPDATE ${table} SET name = COALESCE(?, name), is_active = COALESCE(?, is_active),
         sort_order = COALESCE(?, sort_order) WHERE id = ?`
      )
      .run(
        input.name ?? null,
        input.isActive === undefined ? null : input.isActive ? 1 : 0,
        input.sortOrder ?? null,
        input.id
      )
    const after = getLookup(ctx, input.kind, input.id)
    writeAudit(ctx, { action: 'LOOKUP_UPDATED', entityType: table, entityId: input.id, before, after })
    return after
  })
  return run()
}
