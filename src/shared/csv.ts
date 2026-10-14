/**
 * RFC 4180 CSV parsing and serialisation with spreadsheet formula-injection
 * protection for user-controlled text.
 */

export type CsvCellKind = 'text' | 'number' | 'money' | 'date'

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r', '\n', '|', '%'])

/**
 * Neutralises text that a spreadsheet could interpret as a formula by
 * prefixing a single quote. Only applied to free text — numeric and money
 * columns are emitted as plain numbers so "-400.00" stays a number.
 */
export function neutraliseFormula(value: string): string {
  if (value.length === 0) return value
  const first = value.trimStart().charAt(0)
  if (FORMULA_TRIGGERS.has(value.charAt(0)) || FORMULA_TRIGGERS.has(first)) {
    return `'${value}`
  }
  return value
}

export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function formatCsvCell(value: unknown, kind: CsvCellKind = 'text'): string {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (kind === 'text') {
    text = neutraliseFormula(text)
  } else if (kind === 'number' || kind === 'money') {
    // Only allow plain numeric output for numeric columns.
    if (!/^-?\d+(\.\d+)?$/.test(text)) text = neutraliseFormula(text)
  }
  return escapeCsvField(text)
}

export interface CsvColumn<Row> {
  header: string
  kind?: CsvCellKind
  value: (row: Row) => unknown
}

export const UTF8_BOM = '﻿'

/** Builds a UTF-8 CSV document (with BOM so spreadsheet apps detect UTF-8). */
export function toCsv<Row>(columns: CsvColumn<Row>[], rows: Iterable<Row>, options: { bom?: boolean } = {}): string {
  const lines: string[] = [columns.map((c) => escapeCsvField(neutraliseFormula(c.header))).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => formatCsvCell(c.value(row), c.kind ?? 'text')).join(','))
  }
  return `${options.bom === false ? '' : UTF8_BOM}${lines.join('\r\n')}\r\n`
}

export interface ParsedCsv {
  headers: string[]
  rows: string[][]
}

export class CsvParseError extends Error {}

/** Parses CSV text (RFC 4180: quoted fields, escaped quotes, embedded newlines). */
export function parseCsv(input: string, options: { maxRows?: number } = {}): ParsedCsv {
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input
  const maxRows = options.maxRows ?? 100_000
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  let i = 0
  let fieldStarted = false

  const pushField = () => {
    record.push(field)
    field = ''
    fieldStarted = false
  }
  const pushRecord = () => {
    pushField()
    if (!(record.length === 1 && record[0] === '')) records.push(record)
    record = []
    if (records.length > maxRows + 1) throw new CsvParseError(`File has more than ${maxRows} rows`)
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true
      fieldStarted = true
      i += 1
      continue
    }
    if (ch === ',') {
      pushField()
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      pushRecord()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    field += ch
    fieldStarted = true
    i += 1
  }
  if (inQuotes) throw new CsvParseError('Unterminated quoted field at end of file')
  if (field !== '' || record.length > 0) pushRecord()

  if (records.length === 0) throw new CsvParseError('The file is empty')
  const headers = records[0].map((h) => h.trim())
  if (headers.every((h) => h === '')) throw new CsvParseError('The header row is empty')
  return { headers, rows: records.slice(1) }
}

/** Reverses neutraliseFormula for values produced by this application. */
export function stripFormulaGuard(value: string): string {
  if (value.length > 1 && value.startsWith("'") && FORMULA_TRIGGERS.has(value.charAt(1))) {
    return value.slice(1)
  }
  return value
}

export function normaliseHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
