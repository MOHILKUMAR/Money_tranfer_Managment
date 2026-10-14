/**
 * Money handling in integer minor units (e.g. paise for INR).
 *
 * All authoritative amounts are JavaScript integers holding minor units.
 * Parsing never goes through floating point: decimal strings are split into
 * integer and fractional digits. Quantity × rate uses BigInt with an explicit,
 * documented rounding rule (round half away from zero).
 */

/** Largest amount accepted for a single entry: 10,000,000,000.00 in major units. */
export const MAX_AMOUNT_MINOR = 1_000_000_000_000

/** Quantities are stored with three implied decimals (milli-units). */
export const QUANTITY_SCALE = 1000
export const MAX_QUANTITY_MILLI = 1_000_000_000_000

export interface CurrencyConfig {
  code: string
  locale: string
  minorDigits: number
}

export const DEFAULT_CURRENCY: CurrencyConfig = { code: 'INR', locale: 'en-IN', minorDigits: 2 }

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

const MONEY_PATTERN = /^([+-])?(\d+)(?:\.(\d*))?$/

/**
 * Parses a user-entered money string ("1,250.50", "₹ 1250.5", "-400") into
 * integer minor units. Rejects more fractional digits than the currency allows
 * instead of silently rounding.
 */
export function parseMoney(
  input: string,
  options: { minorDigits?: number; allowNegative?: boolean; allowZero?: boolean } = {}
): ParseResult<number> {
  const minorDigits = options.minorDigits ?? 2
  const cleaned = String(input ?? '')
    .trim()
    .replace(/[\s,_]/g, '')
    .replace(/^[^\d+.-]+/, '')
  if (cleaned === '') return { ok: false, error: 'Enter an amount' }
  const match = MONEY_PATTERN.exec(cleaned)
  if (!match) return { ok: false, error: 'Enter a valid amount, for example 1250.50' }
  const [, sign, whole, fraction = ''] = match
  if (fraction.length > minorDigits) {
    return {
      ok: false,
      error:
        minorDigits === 0
          ? 'This currency does not use decimal places'
          : `Use at most ${minorDigits} decimal places`
    }
  }
  if (whole.length > 15) return { ok: false, error: 'Amount is too large' }
  const scale = 10 ** minorDigits
  const minorAbs = Number(whole) * scale + Number(fraction.padEnd(minorDigits, '0') || '0')
  if (!Number.isSafeInteger(minorAbs) || minorAbs > MAX_AMOUNT_MINOR) {
    return { ok: false, error: 'Amount is too large' }
  }
  const negative = sign === '-' && minorAbs !== 0
  if (negative && !options.allowNegative) return { ok: false, error: 'Amount cannot be negative' }
  if (minorAbs === 0 && !options.allowZero) return { ok: false, error: 'Amount must be greater than zero' }
  return { ok: true, value: negative ? -minorAbs : minorAbs }
}

/** Converts minor units to a plain decimal string ("1250.50", "-400.00"). Exact. */
export function minorToDecimalString(minor: number, minorDigits = 2): string {
  assertSafeInteger(minor)
  const negative = minor < 0
  const abs = Math.abs(minor)
  if (minorDigits === 0) return `${negative ? '-' : ''}${abs}`
  const scale = 10 ** minorDigits
  const whole = Math.trunc(abs / scale)
  const fraction = String(abs % scale).padStart(minorDigits, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

const formatterCache = new Map<string, Intl.NumberFormat>()

function getFormatter(currency: CurrencyConfig, withSymbol: boolean): Intl.NumberFormat {
  const key = `${currency.locale}|${currency.code}|${currency.minorDigits}|${withSymbol}`
  let formatter = formatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(currency.locale, {
      style: withSymbol ? 'currency' : 'decimal',
      currency: currency.code,
      minimumFractionDigits: currency.minorDigits,
      maximumFractionDigits: currency.minorDigits
    })
    formatterCache.set(key, formatter)
  }
  return formatter
}

/**
 * Formats minor units for display ("₹1,250.50"). The decimal string is passed
 * to Intl so no floating-point conversion happens.
 */
export function formatMoney(
  minor: number,
  currency: CurrencyConfig = DEFAULT_CURRENCY,
  options: { withSymbol?: boolean } = {}
): string {
  const decimal = minorToDecimalString(minor, currency.minorDigits)
  // Intl.NumberFormat accepts exact decimal strings (ES2023).
  return getFormatter(currency, options.withSymbol ?? true).format(decimal as unknown as number)
}

export function assertSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Monetary value ${value} is not a safe integer`)
  }
}

/** Sums minor-unit integers, failing loudly rather than losing precision. */
export function sumMinor(values: Iterable<number>): number {
  let total = 0
  for (const value of values) {
    assertSafeInteger(value)
    total += value
    assertSafeInteger(total)
  }
  return total
}

const QUANTITY_PATTERN = /^(\d+)(?:\.(\d{0,3}))?$/

/** Parses a quantity like "2.5" into milli-units (2500). Max three decimals. */
export function parseQuantity(input: string): ParseResult<number> {
  const cleaned = String(input ?? '').trim().replace(/[\s,]/g, '')
  if (cleaned === '') return { ok: false, error: 'Enter a quantity' }
  const match = QUANTITY_PATTERN.exec(cleaned)
  if (!match) return { ok: false, error: 'Enter a valid quantity (up to 3 decimals)' }
  const [, whole, fraction = ''] = match
  if (whole.length > 12) return { ok: false, error: 'Quantity is too large' }
  const milli = Number(whole) * QUANTITY_SCALE + Number(fraction.padEnd(3, '0') || '0')
  if (milli <= 0) return { ok: false, error: 'Quantity must be greater than zero' }
  if (milli > MAX_QUANTITY_MILLI) return { ok: false, error: 'Quantity is too large' }
  return { ok: true, value: milli }
}

export function quantityToString(milli: number): string {
  const whole = Math.trunc(milli / QUANTITY_SCALE)
  const fraction = String(milli % QUANTITY_SCALE).padStart(3, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/**
 * Multiplies a quantity (milli-units) by a rate (minor units per unit) and
 * rounds half away from zero to whole minor units.
 *   2.5 hours × ₹199.99 → 2500 × 19999 / 1000 = 49997.5 → 49998 paise
 */
export function multiplyQuantityRate(quantityMilli: number, rateMinor: number): number {
  assertSafeInteger(quantityMilli)
  assertSafeInteger(rateMinor)
  const product = BigInt(quantityMilli) * BigInt(rateMinor)
  const scale = BigInt(QUANTITY_SCALE)
  const negative = product < 0n
  const abs = negative ? -product : product
  let quotient = abs / scale
  const remainder = abs % scale
  if (remainder * 2n >= scale) quotient += 1n
  const result = Number(negative ? -quotient : quotient)
  assertSafeInteger(result)
  return result
}
