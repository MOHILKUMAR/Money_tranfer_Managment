import { describe, expect, it } from 'vitest'
import {
  formatMoney,
  minorToDecimalString,
  multiplyQuantityRate,
  parseMoney,
  parseQuantity,
  quantityToString,
  sumMinor
} from '../../src/shared/money'
import {
  availableCredit,
  balanceEffect,
  balanceEffectSql,
  classifyBalance,
  computeBalance,
  computeBreakdown,
  netCashFlow,
  outstandingDue,
  runningBalances
} from '../../src/shared/finance'
import { computeUsageCharge } from '../../src/shared/usage'
import { rangeForPreset, isValidIsoDate, parseFlexibleDate, eachMonth, trailingMonths } from '../../src/shared/dates'

describe('money parsing and formatting (integer minor units)', () => {
  it('parses decimal strings exactly into paise', () => {
    expect(parseMoney('1,250.50')).toEqual({ ok: true, value: 125050 })
    expect(parseMoney('₹ 1250.5')).toEqual({ ok: true, value: 125050 })
    expect(parseMoney('0.1')).toEqual({ ok: true, value: 10 })
    expect(parseMoney('0.29')).toEqual({ ok: true, value: 29 })
    expect(parseMoney('1000')).toEqual({ ok: true, value: 100000 })
  })

  it('rejects ambiguous or invalid input instead of rounding', () => {
    expect(parseMoney('1.005').ok).toBe(false)
    expect(parseMoney('abc').ok).toBe(false)
    expect(parseMoney('').ok).toBe(false)
    expect(parseMoney('-5').ok).toBe(false)
    expect(parseMoney('0').ok).toBe(false)
    expect(parseMoney('99999999999999999').ok).toBe(false)
  })

  it('allows negative values only when requested', () => {
    expect(parseMoney('-400', { allowNegative: true })).toEqual({ ok: true, value: -40000 })
  })

  it('converts minor units to decimal strings without floating point error', () => {
    expect(minorToDecimalString(125050)).toBe('1250.50')
    expect(minorToDecimalString(-40000)).toBe('-400.00')
    expect(minorToDecimalString(5)).toBe('0.05')
    expect(minorToDecimalString(-5)).toBe('-0.05')
    expect(minorToDecimalString(1234, 0)).toBe('1234')
  })

  it('formats INR with Indian digit grouping', () => {
    expect(formatMoney(1234567850)).toBe('₹1,23,45,678.50')
    expect(formatMoney(-40000)).toBe('-₹400.00')
  })

  it('avoids classic float errors: 0.1 + 0.2', () => {
    const a = parseMoney('0.10')
    const b = parseMoney('0.20')
    if (!a.ok || !b.ok) throw new Error('parse failed')
    expect(minorToDecimalString(sumMinor([a.value, b.value]))).toBe('0.30')
  })

  it('multiplies quantity × rate with round-half-away-from-zero', () => {
    expect(multiplyQuantityRate(10_000, 10_000)).toBe(100_000) // 10 × ₹100
    expect(multiplyQuantityRate(2_500, 19_999)).toBe(49_998) // 2.5 × 199.99 = 499.975 → 499.98
    expect(multiplyQuantityRate(1_500, 1)).toBe(2) // 1.5 paise → 2
    expect(multiplyQuantityRate(1_499, 1)).toBe(1)
  })

  it('parses quantities to milli-units', () => {
    expect(parseQuantity('2.5')).toEqual({ ok: true, value: 2500 })
    expect(parseQuantity('3')).toEqual({ ok: true, value: 3000 })
    expect(parseQuantity('0.0001').ok).toBe(false)
    expect(parseQuantity('0').ok).toBe(false)
    expect(quantityToString(2500)).toBe('2.5')
    expect(quantityToString(3000)).toBe('3')
  })

  it('sumMinor refuses unsafe integers', () => {
    expect(() => sumMinor([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError)
  })
})

describe('balance convention (credit-positive-v1)', () => {
  it('worked example: ₹10,000 received, ₹2,000 usage, ₹1,500 paid back = ₹6,500 credit', () => {
    const balance = computeBalance([
      { type: 'RECEIPT', amountMinor: 1_000_000 },
      { type: 'USAGE', amountMinor: 200_000 },
      { type: 'PAYOUT', amountMinor: 150_000 }
    ])
    expect(balance).toBe(650_000)
    expect(classifyBalance(balance)).toBe('CREDIT')
  })

  it('worked example: ₹1,000 credit and ₹1,400 usage = −₹400 due', () => {
    const balance = computeBalance([
      { type: 'OPENING_BALANCE', amountMinor: 100_000 },
      { type: 'USAGE', amountMinor: 140_000 }
    ])
    expect(balance).toBe(-40_000)
    expect(classifyBalance(balance)).toBe('DUE')
    expect(outstandingDue(balance)).toBe(40_000)
    expect(availableCredit(balance)).toBe(0)
  })

  it('zero balance is settled', () => {
    const balance = computeBalance([
      { type: 'RECEIPT', amountMinor: 50_000 },
      { type: 'USAGE', amountMinor: 50_000 }
    ])
    expect(balance).toBe(0)
    expect(classifyBalance(balance)).toBe('SETTLED')
  })

  it('applies credit and debit adjustments', () => {
    expect(
      computeBalance([
        { type: 'OPENING_BALANCE', amountMinor: -10_000 },
        { type: 'CREDIT_ADJUSTMENT', amountMinor: 25_000 },
        { type: 'DEBIT_ADJUSTMENT', amountMinor: 5_000 }
      ])
    ).toBe(10_000)
  })

  it('reversal rows (negated amount, same type) cancel the original', () => {
    expect(
      computeBalance([
        { type: 'RECEIPT', amountMinor: 70_000 },
        { type: 'RECEIPT', amountMinor: -70_000 }
      ])
    ).toBe(0)
  })

  it('breakdown matches the documented formula', () => {
    const b = computeBreakdown([
      { type: 'OPENING_BALANCE', amountMinor: 1_000 },
      { type: 'RECEIPT', amountMinor: 20_000 },
      { type: 'RECEIPT', amountMinor: 5_000 },
      { type: 'PAYOUT', amountMinor: 3_000 },
      { type: 'USAGE', amountMinor: 7_000 },
      { type: 'CREDIT_ADJUSTMENT', amountMinor: 500 },
      { type: 'DEBIT_ADJUSTMENT', amountMinor: 200 }
    ])
    expect(b).toEqual({
      openingMinor: 1_000,
      receivedMinor: 25_000,
      paidMinor: 3_000,
      usageMinor: 7_000,
      creditAdjustmentsMinor: 500,
      debitAdjustmentsMinor: 200,
      balanceMinor: 1_000 + 25_000 - 3_000 - 7_000 + 500 - 200
    })
  })

  it('computes running balances in order', () => {
    expect(
      runningBalances([
        { type: 'OPENING_BALANCE', amountMinor: 1_000 },
        { type: 'USAGE', amountMinor: 1_500 },
        { type: 'RECEIPT', amountMinor: 2_000 }
      ])
    ).toEqual([1_000, -500, 1_500])
  })

  it('net cash flow excludes usage and adjustments', () => {
    expect(netCashFlow({ receivedMinor: 10_000, paidMinor: 1_500, expensesMinor: 2_500 })).toBe(6_000)
  })

  it('generates SQL from the same sign table', () => {
    const sql = balanceEffectSql('t')
    expect(sql).toContain("WHEN 'RECEIPT' THEN t.amount_minor")
    expect(sql).toContain("WHEN 'PAYOUT' THEN -t.amount_minor")
    expect(sql).toContain("WHEN 'USAGE' THEN -t.amount_minor")
    expect(sql).toContain("WHEN 'DEBIT_ADJUSTMENT' THEN -t.amount_minor")
    expect(balanceEffect('USAGE', 100)).toBe(-100)
  })
})

describe('usage charge calculation', () => {
  it('quantity × rate with fees and discount', () => {
    expect(
      computeUsageCharge({ method: 'QUANTITY', quantityMilli: 10_000, rateMinor: 10_000, feesMinor: 500, discountMinor: 1_000 })
    ).toEqual({ ok: true, value: { baseAmountMinor: 100_000, feesMinor: 500, discountMinor: 1_000, chargeMinor: 99_500 } })
  })

  it('fixed amounts', () => {
    const result = computeUsageCharge({ method: 'FIXED', fixedAmountMinor: 25_000 })
    expect(result.ok && result.value.chargeMinor).toBe(25_000)
  })

  it('rejects discounts larger than the charge and zero charges', () => {
    expect(computeUsageCharge({ method: 'FIXED', fixedAmountMinor: 1_000, discountMinor: 1_001 }).ok).toBe(false)
    expect(computeUsageCharge({ method: 'FIXED', fixedAmountMinor: 1_000, discountMinor: 1_000 }).ok).toBe(false)
    expect(computeUsageCharge({ method: 'QUANTITY', quantityMilli: 1_000, rateMinor: 0 }).ok).toBe(false)
    expect(computeUsageCharge({ method: 'QUANTITY', quantityMilli: 0, rateMinor: 100 }).ok).toBe(false)
  })
})

describe('date helpers', () => {
  it('validates ISO dates strictly', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('15/10/2026')).toBe(false)
  })

  it('computes preset ranges', () => {
    expect(rangeForPreset('today', '2026-10-15')).toEqual({ from: '2026-10-15', to: '2026-10-15' })
    expect(rangeForPreset('yesterday', '2026-10-01')).toEqual({ from: '2026-09-30', to: '2026-09-30' })
    expect(rangeForPreset('last7', '2026-10-15')).toEqual({ from: '2026-10-09', to: '2026-10-15' })
    expect(rangeForPreset('last30', '2026-10-15')).toEqual({ from: '2026-09-16', to: '2026-10-15' })
    expect(rangeForPreset('thisMonth', '2026-10-15')).toEqual({ from: '2026-10-01', to: '2026-10-15' })
    expect(rangeForPreset('previousMonth', '2026-03-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('parses flexible date input', () => {
    expect(parseFlexibleDate('15/10/2026')).toBe('2026-10-15')
    expect(parseFlexibleDate('2026-10-15')).toBe('2026-10-15')
    expect(parseFlexibleDate('10/15/2026', 'MM/dd/yyyy')).toBe('2026-10-15')
    expect(parseFlexibleDate('31/02/2026')).toBeNull()
    expect(parseFlexibleDate('not a date')).toBeNull()
  })

  it('enumerates months', () => {
    expect(eachMonth('2026-11-20', '2027-02-01')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    expect(trailingMonths('2026-10-15', 3)).toEqual(['2026-08', '2026-09', '2026-10'])
  })
})
