import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { escapeCsvField, formatCsvCell, neutraliseFormula, parseCsv, stripFormulaGuard, toCsv, UTF8_BOM, CsvParseError } from '../../src/shared/csv'
import { addCustomer, createTestEnv, key, lookupId, type TestEnv } from './helpers'
import { commitImport, hashContent, suggestMapping, validateImport, type ParsedImportFile } from '../../src/main/services/csv-import'
import { buildReport, reportToCsv } from '../../src/main/services/reports'
import { getCustomer, listCustomers } from '../../src/main/services/customers'
import { listLedger, recordPayout, recordReceipt, reverseTransaction } from '../../src/main/services/ledger'
import { recordUsageBatch, listUsage } from '../../src/main/services/usage'
import { customerBalance } from '../../src/main/services/ledger-core'
import { getCurrency } from '../../src/main/services/settings'
import { AppError } from '../../src/shared/errors'

function file(kind: ParsedImportFile['kind'], csv: string, fileName = 'test.csv'): ParsedImportFile {
  const parsed = parseCsv(csv)
  return { kind, fileName, sha256: hashContent(csv), headers: parsed.headers, rows: parsed.rows }
}

describe('CSV primitives', () => {
  it('escapes commas, quotes and line breaks', () => {
    expect(escapeCsvField('plain')).toBe('plain')
    expect(escapeCsvField('Smith, John')).toBe('"Smith, John"')
    expect(escapeCsvField('He said "hi"')).toBe('"He said ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralises spreadsheet formulas in text cells only', () => {
    for (const evil of ['=SUM(A1:A2)', '+1+1', '-2+3', '@cmd', '\t=1', '=HYPERLINK("http://x")', " =1"]) {
      expect(neutraliseFormula(evil).startsWith("'")).toBe(true)
    }
    expect(formatCsvCell('=1+1', 'text')).toBe("'=1+1")
    expect(formatCsvCell('-400.00', 'money')).toBe('-400.00')
    expect(formatCsvCell('-400.00', 'text')).toBe("'-400.00")
    expect(formatCsvCell('=cmd|calc', 'money')).toBe("'=cmd|calc")
    expect(stripFormulaGuard("'=SUM(A1)")).toBe('=SUM(A1)')
    expect(stripFormulaGuard("O'Brien")).toBe("O'Brien")
  })

  it('round-trips unicode, commas, quotes and newlines', () => {
    const rows = [
      { name: 'Café "Ünïcødé", Ltd', note: 'line1\nline2', amount: '1250.50' },
      { name: 'राम ट्रेडर्स', note: '', amount: '0.05' },
      { name: '株式会社', note: '=danger', amount: '-3.00' }
    ]
    const csv = toCsv(
      [
        { header: 'Name', value: (r: (typeof rows)[number]) => r.name },
        { header: 'Note', value: (r: (typeof rows)[number]) => r.note },
        { header: 'Amount', kind: 'money', value: (r: (typeof rows)[number]) => r.amount }
      ],
      rows
    )
    expect(csv.startsWith(UTF8_BOM)).toBe(true)
    const parsed = parseCsv(csv)
    expect(parsed.headers).toEqual(['Name', 'Note', 'Amount'])
    expect(parsed.rows.map((r) => r[0])).toEqual(rows.map((r) => r.name))
    expect(parsed.rows[0][1]).toBe('line1\nline2')
    expect(parsed.rows[2][1]).toBe("'=danger")
    expect(parsed.rows.map((r) => r[2])).toEqual(['1250.50', '0.05', '-3.00'])
  })

  it('handles CRLF, empty fields and trailing newlines; rejects broken quoting', () => {
    expect(parseCsv('a,b,c\r\n1,,3\r\n,,\r\n').rows).toEqual([
      ['1', '', '3'],
      ['', '', '']
    ])
    expect(() => parseCsv('a,b\n"unterminated,1')).toThrow(CsvParseError)
    expect(() => parseCsv('')).toThrow(CsvParseError)
  })

  it('suggests a mapping from header names', () => {
    const m = suggestMapping('TRANSACTIONS', ['Reference', 'Date', 'Customer Code', 'Type', 'Amount (INR)', 'Payment Method', 'Notes'])
    expect(m).toMatchObject({ reference: 0, date: 1, customer_code: 2, type: 3, amount: 4, payment_method: 5, notes: 6, category: null })
  })
})

describe('CSV import', () => {
  let env: TestEnv
  beforeEach(() => {
    env = createTestEnv()
  })
  afterEach(() => env.cleanup())
  const opts = { dateFormat: 'dd/MM/yyyy' as const }

  it('imports valid customers with opening balances and reports the summary', () => {
    const csv = 'Name,Phone,Email,Registration Date,Opening Balance,Notes\n' +
      '"Sharma, Anil",98765 43210,anil@example.com,01/10/2026,1500.50,"Prefers ""UPI"""\n' +
      'राम ट्रेडर्स,,,2026-10-02,-250,\n' +
      'Plain Co,,,,,\n'
    const f = file('CUSTOMERS', csv)
    const mapping = suggestMapping('CUSTOMERS', f.headers)
    const validation = validateImport(env.ctx, f, mapping, opts)
    expect(validation).toMatchObject({ totalRows: 3, validRows: 3, errorRows: 0 })
    expect(() => commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: false, skipInvalidRows: false, importPossibleDuplicates: false })).toThrow(/Confirm/)
    const result = commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false })
    expect(result.importedRows).toBe(3)
    const customers = listCustomers(env.ctx, { sortBy: 'code' }).rows
    expect(customers.map((c) => [c.name, c.balanceMinor])).toEqual([
      ['Sharma, Anil', 150050],
      ['राम ट्रेडर्स', -25000],
      ['Plain Co', 0]
    ])
    expect(getCustomer(env.ctx, customers[0].id).notes).toBe('Prefers "UPI"')
    const history = env.db.prepare('SELECT * FROM csv_import_history').all() as Array<{ status: string; imported_rows: number }>
    expect(history).toEqual([expect.objectContaining({ status: 'COMPLETED', imported_rows: 3 })])
  })

  it('reports invalid dates, amounts, emails and empty required fields without saving anything', () => {
    const csv = 'Name,Email,Registration Date,Opening Balance\n' + ',a@b.co,01/10/2026,\nBad Date,,31/02/2026,\nBad Amount,,,12.345\nBad Email,not-an-email,,\nGood,,,\n'
    const f = file('CUSTOMERS', csv)
    const mapping = suggestMapping('CUSTOMERS', f.headers)
    const v = validateImport(env.ctx, f, mapping, opts)
    expect(v.errorRows).toBe(4)
    expect(v.validRows).toBe(1)
    const messages = v.rows.flatMap((r) => r.messages).join(' | ')
    expect(messages).toMatch(/Name is required/)
    expect(messages).toMatch(/not a valid date/)
    expect(messages).toMatch(/at most 2 decimal places/)
    expect(messages).toMatch(/valid email/)
    expect(() => commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false })).toThrow(AppError)
    expect(listCustomers(env.ctx).total).toBe(0)
    const result = commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: true, importPossibleDuplicates: false })
    expect(result).toMatchObject({ importedRows: 1, failedRows: 4 })
    expect(result.failures.map((x) => x.rowNumber)).toEqual([2, 3, 4, 5])
  })

  it('detects duplicate customer codes and possible duplicates without merging', () => {
    addCustomer(env, 'Existing Person', undefined, { phone: '9000000001' })
    const csv = 'Customer Code,Name,Phone\nCUST-000001,Existing Person,\nCUST-000001,Someone Else,\nNEW-1,Existing Person,\nNEW-2,Phone Match,+91 90000 00001\nNEW-2,Dup Code,\n'
    const f = file('CUSTOMERS', csv)
    const mapping = suggestMapping('CUSTOMERS', f.headers)
    const v = validateImport(env.ctx, f, mapping, opts)
    expect(v.rows.map((r) => r.status)).toEqual(['DUPLICATE', 'ERROR', 'POSSIBLE_DUPLICATE', 'POSSIBLE_DUPLICATE', 'ERROR'])
    const r = commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: true, importPossibleDuplicates: false })
    expect(r).toMatchObject({ importedRows: 0, skippedDuplicateRows: 1, skippedPossibleDuplicateRows: 2, failedRows: 2 })
    const r2 = commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: true, importPossibleDuplicates: true })
    expect(r2.importedRows).toBe(2)
    expect(listCustomers(env.ctx).total).toBe(3)
  })

  it('imports historical transactions, rejects negative and malformed values, and skips duplicate references', () => {
    const a = addCustomer(env, 'Alpha')
    const csv =
      'Reference,Date,Customer Code,Type,Amount,Payment Method,Description\n' +
      'OLD-1,01/09/2026,CUST-000001,RECEIPT,"1,000.00",Cash,Advance\n' +
      'OLD-2,02/09/2026,CUST-000001,USAGE,250.25,,Service\n' +
      'OLD-3,03/09/2026,CUST-000001,PAYOUT,100,UPI,Refund\n' +
      'OLD-4,04/09/2026,CUST-000001,RECEIPT,-5,Cash,Negative\n' +
      'OLD-5,05/09/2026,CUST-404,RECEIPT,5,Cash,Unknown customer\n' +
      'OLD-6,06/09/2026,CUST-000001,RECEIPT,5,Bitcoin,Unknown method\n' +
      'OLD-7,99/99/2026,CUST-000001,RECEIPT,5,Cash,Bad date\n' +
      'OLD-8,07/09/2026,CUST-000001,TELEPORT,5,Cash,Bad type\n' +
      'OLD-1,01/09/2026,CUST-000001,RECEIPT,1000,Cash,Repeat in file\n'
    const f = file('TRANSACTIONS', csv)
    const mapping = suggestMapping('TRANSACTIONS', f.headers)
    const v = validateImport(env.ctx, f, mapping, opts)
    expect(v.rows.map((r) => r.status)).toEqual(['VALID', 'VALID', 'VALID', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'ERROR', 'DUPLICATE'])
    expect(v.financialTotalMinor).toBe(100000 - 25025 - 10000)
    const r = commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: true, importPossibleDuplicates: false })
    expect(r).toMatchObject({ importedRows: 3, skippedDuplicateRows: 1, failedRows: 5 })
    expect(customerBalance(env.ctx, a)).toBe(100000 - 25025 - 10000)
    expect(listUsage(env.ctx, { customerId: a }).rows[0]).toMatchObject({ chargeMinor: 25025, method: 'FIXED' })
    const ledger = listLedger(env.ctx, { customerId: a })
    expect(ledger.rows.map((x) => x.externalRef)).toEqual(['OLD-1', 'OLD-2', 'OLD-3'])
    expect(ledger.rows.every((x) => x.source === 'IMPORT')).toBe(true)
    // Importing the same file again: everything that was imported is now a duplicate.
    const again = validateImport(env.ctx, f, mapping, opts)
    expect(again.validRows).toBe(0)
    expect(again.duplicateRows).toBe(4)
    expect(again.sameFileImportedAt).not.toBeNull()
  })

  it('flags a reused reference with different details as an error (never overwrites)', () => {
    addCustomer(env, 'Alpha')
    const first = file('TRANSACTIONS', 'Reference,Date,Customer Code,Type,Amount,Payment Method\nX-1,01/09/2026,CUST-000001,RECEIPT,10,Cash\n')
    const mapping = suggestMapping('TRANSACTIONS', first.headers)
    commitImport(env.ctx, first, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false })
    const changed = file('TRANSACTIONS', 'Reference,Date,Customer Code,Type,Amount,Payment Method\nX-1,01/09/2026,CUST-000001,RECEIPT,99,Cash\n')
    const v = validateImport(env.ctx, changed, mapping, opts)
    expect(v.rows[0].status).toBe('ERROR')
    expect(v.rows[0].messages[0]).toMatch(/different details/)
  })

  it('validates usage rows: quantity × rate must match the charge, discounts need a reason', () => {
    addCustomer(env, 'Usage Co')
    const csv =
      'Date,Customer Code,Category,Description,Quantity,Unit,Rate,Fees,Discount,Discount Reason,Charge\n' +
      '15/10/2026,CUST-000001,Service,Service A,10,units,100,,,,1000.00\n' +
      '15/10/2026,CUST-000001,Service,Service B,3,hours,200,,,,601\n' +
      '15/10/2026,CUST-000001,Service,Additional,,,,,,,250\n' +
      '15/10/2026,CUST-000001,Service,Discounted,,,,,50,,250\n' +
      '15/10/2026,CUST-000001,Nope,Bad category,,,,,,,10\n'
    const f = file('USAGE', csv)
    const mapping = suggestMapping('USAGE', f.headers)
    const v = validateImport(env.ctx, f, mapping, opts)
    expect(v.rows.map((r) => r.status)).toEqual(['VALID', 'ERROR', 'VALID', 'ERROR', 'ERROR'])
    const r = commitImport(env.ctx, f, mapping, { ...opts, confirmFinancial: true, skipInvalidRows: true, importPossibleDuplicates: false })
    expect(r.importedRows).toBe(2)
    expect(listUsage(env.ctx).totalMinor).toBe(125000)
  })

  it('export → re-import round trip preserves exact monetary values and balances', () => {
    const a = addCustomer(env, 'Round, "Trip" Ltd', { amountMinor: 12_345 })
    const b = addCustomer(env, 'ಕನ್ನಡ Stores')
    const cash = lookupId(env.lookups, 'payment_methods', 'Cash')
    recordReceipt(env.ctx, { customerId: a, date: '2026-10-02', amountMinor: 100_001, paymentMethodId: cash, description: '=1+1 formula-looking', idempotencyKey: key() })
    recordReceipt(env.ctx, { customerId: b, date: '2026-10-03', amountMinor: 7, paymentMethodId: cash, idempotencyKey: key() })
    recordUsageBatch(env.ctx, {
      customerId: a,
      usageDate: '2026-10-04',
      idempotencyKey: key(),
      lines: [{ categoryId: lookupId(env.lookups, 'usage_categories', 'Service'), description: 'Hours', method: 'QUANTITY', quantityMilli: 2_500, rateMinor: 19_999 }]
    })
    recordPayout(env.ctx, { customerId: a, date: '2026-10-05', amountMinor: 333, paymentMethodId: cash, reason: 'Refund', idempotencyKey: key() })
    const reversed = recordReceipt(env.ctx, { customerId: b, date: '2026-10-06', amountMinor: 5_000, paymentMethodId: cash, idempotencyKey: key() })
    reverseTransaction(env.ctx, { txnId: reversed.id, reason: 'Entered twice', idempotencyKey: key() })
    const balances = [customerBalance(env.ctx, a), customerBalance(env.ctx, b)]
    expect(balances).toEqual([12_345 + 100_001 - 49_998 - 333, 7])

    const currency = getCurrency(env.ctx)
    const customersCsv = reportToCsv(buildReport(env.ctx, { kind: 'customer_directory' }), currency)
    const txnCsv = reportToCsv(buildReport(env.ctx, { kind: 'transactions', from: '2026-01-01', to: '2026-12-31' }), currency)
    expect(txnCsv).toContain('1000.01')
    expect(txnCsv).toContain("'=1+1 formula-looking")

    const target = createTestEnv()
    try {
      // Customer directory has opening balances inside the transactions export, so import without them.
      const cf = file('CUSTOMERS', customersCsv)
      const cm = { ...suggestMapping('CUSTOMERS', cf.headers), opening_balance: null }
      expect(commitImport(target.ctx, cf, cm, { ...opts, confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false }).importedRows).toBe(2)
      const tf = file('TRANSACTIONS', txnCsv)
      const tm = suggestMapping('TRANSACTIONS', tf.headers)
      const v = validateImport(target.ctx, tf, tm, { dateFormat: 'yyyy-MM-dd' })
      expect(v.errorRows).toBe(0)
      expect(v.skippedRows).toBe(2) // the reversed receipt and its reversal
      const r = commitImport(target.ctx, tf, tm, { dateFormat: 'yyyy-MM-dd', confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false })
      expect(r.importedRows).toBe(5)
      const imported = listCustomers(target.ctx, { sortBy: 'code' }).rows
      expect(imported.map((c) => [c.name, c.balanceMinor])).toEqual([
        ['Round, "Trip" Ltd', balances[0]],
        ['ಕನ್ನಡ Stores', balances[1]]
      ])
      const desc = listLedger(target.ctx, { types: ['RECEIPT'] }).rows[0].description
      expect(desc).toBe('=1+1 formula-looking')
    } finally {
      target.cleanup()
    }
  })

  it('usage export → re-import keeps quantity-based charges exact and skips reversed entries', () => {
    const a = addCustomer(env, 'Usage Export')
    const svc = lookupId(env.lookups, 'usage_categories', 'Service')
    recordUsageBatch(env.ctx, {
      customerId: a,
      usageDate: '2026-10-10',
      idempotencyKey: key(),
      lines: [
        { categoryId: svc, description: 'Qty', method: 'QUANTITY', quantityMilli: 1_500, rateMinor: 333, feesMinor: 100, discountMinor: 50, discountReason: 'Loyalty' },
        { categoryId: svc, description: 'Fixed', method: 'FIXED', fixedAmountMinor: 9_999, fixedReason: 'Flat' }
      ]
    })
    const csv = reportToCsv(buildReport(env.ctx, { kind: 'usage', from: '2026-10-01', to: '2026-10-31' }), getCurrency(env.ctx))
    const target = createTestEnv()
    try {
      addCustomer(target, 'Usage Export')
      const f = file('USAGE', csv)
      const m = suggestMapping('USAGE', f.headers)
      const v = validateImport(target.ctx, f, m, { dateFormat: 'yyyy-MM-dd' })
      expect(v.validRows).toBe(2)
      commitImport(target.ctx, f, m, { dateFormat: 'yyyy-MM-dd', confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false })
      expect(listUsage(target.ctx).totalMinor).toBe(listUsage(env.ctx).totalMinor)
    } finally {
      target.cleanup()
    }
  })
})
