import { MAX_AMOUNT_MINOR, multiplyQuantityRate, sumMinor } from './money'

export const USAGE_METHODS = ['QUANTITY', 'FIXED'] as const
export type UsageMethod = (typeof USAGE_METHODS)[number]

export interface UsageChargeInput {
  method: UsageMethod
  quantityMilli?: number | null
  rateMinor?: number | null
  fixedAmountMinor?: number | null
  feesMinor?: number | null
  discountMinor?: number | null
}

export interface UsageCharge {
  baseAmountMinor: number
  feesMinor: number
  discountMinor: number
  chargeMinor: number
}

export type UsageChargeResult = { ok: true; value: UsageCharge } | { ok: false; error: string }

/**
 * Computes a usage charge.
 *   QUANTITY: base = round_half_away(quantity × rate)
 *   FIXED:    base = entered amount
 *   charge   = base + fees − discount   (must be > 0; discount ≤ base + fees)
 */
export function computeUsageCharge(input: UsageChargeInput): UsageChargeResult {
  const fees = input.feesMinor ?? 0
  const discount = input.discountMinor ?? 0
  if (!Number.isSafeInteger(fees) || fees < 0) return { ok: false, error: 'Fees cannot be negative' }
  if (!Number.isSafeInteger(discount) || discount < 0) {
    return { ok: false, error: 'Discount cannot be negative' }
  }
  let base: number
  if (input.method === 'QUANTITY') {
    const quantity = input.quantityMilli
    const rate = input.rateMinor
    if (quantity === null || quantity === undefined || quantity <= 0) {
      return { ok: false, error: 'Quantity must be greater than zero' }
    }
    if (rate === null || rate === undefined || rate < 0) {
      return { ok: false, error: 'Rate cannot be negative' }
    }
    base = multiplyQuantityRate(quantity, rate)
  } else {
    const fixed = input.fixedAmountMinor
    if (fixed === null || fixed === undefined || !Number.isSafeInteger(fixed) || fixed <= 0) {
      return { ok: false, error: 'Fixed amount must be greater than zero' }
    }
    base = fixed
  }
  const gross = sumMinor([base, fees])
  if (discount > gross) return { ok: false, error: 'Discount cannot exceed the charge before discount' }
  const charge = gross - discount
  if (charge <= 0) return { ok: false, error: 'Final usage charge must be greater than zero' }
  if (charge > MAX_AMOUNT_MINOR) return { ok: false, error: 'Usage charge is too large' }
  return { ok: true, value: { baseAmountMinor: base, feesMinor: fees, discountMinor: discount, chargeMinor: charge } }
}
