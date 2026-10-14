/**
 * Synthetic demo data. Only ever written to the separate demo database that is
 * opened with the `--demo` flag; the UI shows a "DEMO DATA" banner. Never used
 * in the normal production database.
 */
import { randomUUID } from 'node:crypto'
import { addDays, format } from 'date-fns'
import type { ServiceContext } from '../services/context'
import { createCustomer } from '../services/customers'
import { listLookups } from '../services/lookups'
import { recordPayout, recordReceipt } from '../services/ledger'
import { recordUsageBatch } from '../services/usage'
import { recordExpense } from '../services/expenses'
import { writeSetting } from '../services/settings'

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

export function seedDemoData(ctx: ServiceContext): void {
  const existing = (ctx.db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n
  if (existing > 0) return
  const random = rng(42)
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]
  const lookups = listLookups(ctx)
  const id = (kind: keyof typeof lookups, name: string) => lookups[kind].find((l) => l.name === name)!.id
  const today = ctx.now()
  const day = (offset: number) => format(addDays(today, -offset), 'yyyy-MM-dd')
  writeSetting(ctx, 'businessName', 'Demo Business (synthetic data)')

  const names = [
    'Demo — ABC Traders',
    'Demo — Sunrise Stores',
    'Demo — Patel Logistics',
    'Demo — Green Valley Farms',
    'Demo — Metro Print House',
    'Demo — Lakshmi Textiles',
    'Demo — Blue Ocean Cafe',
    'Demo — Northwind Supplies'
  ]
  const customers = names.map((name, i) =>
    createCustomer(ctx, {
      name,
      phone: `90000 0000${i}`,
      registrationDate: day(90),
      status: 'ACTIVE',
      notes: 'Synthetic demo customer',
      openingBalance: i % 3 === 0 ? { amountMinor: (i + 1) * 150_000 * (i === 6 ? -1 : 1), date: day(90), explanation: 'Demo opening balance' } : null,
      idempotencyKey: randomUUID(),
      confirmPossibleDuplicate: true
    }).id
  )
  const methods = ['Cash', 'UPI', 'Bank transfer', 'Card terminal'].map((n) => id('payment_methods', n))
  const usageCats = ['Service', 'Resource usage', 'Consumables'].map((n) => id('usage_categories', n))
  const units = ['hours', 'units', 'days'].map((n) => id('usage_units', n))

  for (const customerId of customers) {
    for (let k = 0; k < 4; k += 1) {
      recordReceipt(ctx, {
        customerId,
        date: day(80 - k * 20 - Math.floor(random() * 10)),
        amountMinor: Math.round(2_000 + random() * 18_000) * 100,
        paymentMethodId: pick(methods),
        description: 'Demo advance payment',
        idempotencyKey: randomUUID()
      })
    }
  }
  for (let offset = 60; offset >= 0; offset -= 1) {
    const count = Math.floor(random() * 4)
    for (let c = 0; c < count; c += 1) {
      const customerId = pick(customers)
      const quantityBased = random() > 0.3
      recordUsageBatch(ctx, {
        customerId,
        usageDate: day(offset),
        idempotencyKey: randomUUID(),
        lines: [
          quantityBased
            ? {
                categoryId: pick(usageCats),
                description: 'Demo service usage',
                method: 'QUANTITY',
                quantityMilli: (1 + Math.floor(random() * 8)) * 1000,
                unitId: pick(units),
                rateMinor: (50 + Math.floor(random() * 250)) * 100
              }
            : {
                categoryId: pick(usageCats),
                description: 'Demo fixed charge',
                method: 'FIXED',
                fixedAmountMinor: (200 + Math.floor(random() * 800)) * 100,
                fixedReason: 'Demo flat fee'
              }
        ]
      })
    }
    if (offset % 7 === 0) {
      recordExpense(ctx, {
        date: day(offset),
        categoryId: id('expense_categories', pick(['Utilities', 'Supplies', 'Transport', 'Maintenance'])),
        description: 'Demo operating expense',
        amountMinor: (500 + Math.floor(random() * 4500)) * 100,
        paymentMethodId: pick(methods),
        idempotencyKey: randomUUID()
      })
    }
    if (offset % 30 === 0) {
      recordExpense(ctx, {
        date: day(offset),
        categoryId: id('expense_categories', 'Rent'),
        description: 'Demo monthly rent',
        amountMinor: 2_500_000,
        paymentMethodId: id('payment_methods', 'Bank transfer'),
        idempotencyKey: randomUUID()
      })
    }
  }
  recordPayout(ctx, {
    customerId: customers[1],
    date: day(5),
    amountMinor: 150_000,
    paymentMethodId: id('payment_methods', 'UPI'),
    reason: 'Demo refund of unused advance',
    override: { confirmed: true, reason: 'Demo data' },
    idempotencyKey: randomUUID()
  })
}
