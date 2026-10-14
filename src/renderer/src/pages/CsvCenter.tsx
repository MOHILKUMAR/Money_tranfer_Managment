import { useState } from 'react'
import { CheckCircle2, Download, Eye, FileSpreadsheet, FileUp, Printer, Save, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import type { ImportKind, ReportKind, ReportParams } from '@shared/schemas'
import type { ImportCommitResult, ImportSessionInfo, ImportValidationResult, ReportData } from '@shared/types'
import { formatIsoDate } from '@shared/dates'
import { call, errorMessage } from '@/lib/api'
import { useApi, useFormat } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader } from '@/components/ui/layout'
import { Checkbox, Field, Select } from '@/components/ui/form'
import { Dialog, TabPanel, Tabs } from '@/components/ui/overlay'
import { Table, THead, Th, Tr, Td } from '@/components/ui/table'
import { CustomerPicker, DateRangeControl, useDateRange } from '@/components/domain'

const REPORTS: Array<{ kind: ReportKind; label: string; description: string; needs: 'range' | 'customer' | 'asOf' | 'none' }> = [
  { kind: 'customer_directory', label: 'Customer directory', description: 'All customers with contact details and current totals', needs: 'none' },
  { kind: 'customer_statement', label: 'Customer statement / ledger', description: 'One customer’s ledger with running balance', needs: 'customer' },
  { kind: 'customer_balances', label: 'Customer balance statement', description: 'Every customer’s balance as of a date', needs: 'asOf' },
  { kind: 'transactions', label: 'All transactions', description: 'Complete ledger (re-importable format)', needs: 'range' },
  { kind: 'receipts', label: 'Payments received', description: 'Receipts from customers', needs: 'range' },
  { kind: 'payouts', label: 'Payments paid to customers', description: 'Refunds and payouts', needs: 'range' },
  { kind: 'usage', label: 'Daily usage report', description: 'Usage entries with quantities, rates and charges', needs: 'range' },
  { kind: 'expenses', label: 'Business expense report', description: 'Operating expenses', needs: 'range' },
  { kind: 'daily_cashbook', label: 'Daily cashbook', description: 'Chronological cash in and cash out', needs: 'range' },
  { kind: 'daily_summary', label: 'Daily financial summary', description: 'Totals per day', needs: 'range' },
  { kind: 'monthly_summary', label: 'Monthly financial summary', description: 'Totals per month', needs: 'range' },
  { kind: 'customer_payment_summary', label: 'Customer payment summary', description: 'Receipts per customer', needs: 'range' },
  { kind: 'customer_payout_summary', label: 'Customer payout summary', description: 'Payouts per customer', needs: 'range' },
  { kind: 'dashboard_summary', label: 'Dashboard summary', description: 'KPI figures for the period with definitions', needs: 'range' }
]

function ReportsPanel() {
  const [kind, setKind] = useState<ReportKind>('transactions')
  const [range, setRange] = useDateRange('thisMonth')
  const [customerId, setCustomerId] = useState<number | null>(null)
  const [asOf, setAsOf] = useState('')
  const [preview, setPreview] = useState<(ReportData & { totalRows: number }) | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const def = REPORTS.find((r) => r.kind === kind)!
  const params = (): ReportParams => ({
    kind,
    from: def.needs === 'range' || def.needs === 'customer' ? range.from : null,
    to: def.needs === 'range' || def.needs === 'customer' ? range.to : null,
    customerId: def.needs === 'customer' ? customerId : null,
    asOf: def.needs === 'asOf' ? asOf || range.to : null
  })
  const run = async (action: 'csv' | 'html' | 'print' | 'preview') => {
    if (def.needs === 'customer' && !customerId) {
      toast.error('Select a customer for the statement')
      return
    }
    setBusy(action)
    try {
      if (action === 'csv') {
        const r = await call('reports:exportCsv', params())
        if (r.saved) toast.success(`Saved ${r.fileName} (${r.rowCount} rows)`)
      } else if (action === 'html') {
        const r = await call('reports:saveHtml', params())
        if (r.saved) toast.success(`Saved ${r.fileName}`)
      } else if (action === 'print') {
        await call('reports:print', params())
      } else {
        setPreview(await call('reports:preview', params()))
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[420px_1fr]">
      <Card>
        <CardHeader title="Report" description="Exports use UTF-8, exact decimal amounts and ISO dates" />
        <CardBody>
          <ul className="space-y-1" role="radiogroup" aria-label="Report type">
            {REPORTS.map((r) => (
              <li key={r.kind}>
                <label className={`flex cursor-pointer gap-3 rounded-md border px-3 py-2 ${kind === r.kind ? 'border-charcoal bg-silver-100' : 'border-transparent hover:bg-silver-100/60'}`}>
                  <input type="radio" name="report" className="mt-1 accent-racing" checked={kind === r.kind} onChange={() => (setKind(r.kind), setPreview(null))} />
                  <span>
                    <span className="block text-sm font-medium">{r.label}</span>
                    <span className="block text-xs text-ink-muted">{r.description}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title={def.label} description="Filters apply to CSV, HTML and printed output; reports show their generation date and date basis" />
          <CardBody className="space-y-3">
            {(def.needs === 'range' || def.needs === 'customer') && <DateRangeControl value={range} onChange={setRange} />}
            {def.needs === 'customer' && (
              <Field label="Customer" htmlFor="report-customer" required className="max-w-md">
                <CustomerPicker id="report-customer" value={customerId} onChange={(id) => setCustomerId(id)} />
              </Field>
            )}
            {def.needs === 'asOf' && (
              <Field label="Balances as of" htmlFor="report-asof" className="max-w-xs" hint="Leave blank for today">
                <input id="report-asof" type="date" className="h-9 w-full rounded-md border border-silver px-3 text-sm" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
              </Field>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="primary" loading={busy === 'csv'} onClick={() => run('csv')}>
                <Download /> Export CSV
              </Button>
              <Button variant="outline" loading={busy === 'print'} onClick={() => run('print')}>
                <Printer /> Print
              </Button>
              <Button variant="outline" loading={busy === 'html'} onClick={() => run('html')}>
                <Save /> Save HTML
              </Button>
              <Button variant="ghost" loading={busy === 'preview'} onClick={() => run('preview')}>
                <Eye /> Preview
              </Button>
            </div>
          </CardBody>
        </Card>
        {preview && <ReportPreview report={preview} />}
      </div>
    </div>
  )
}

function ReportPreview({ report }: { report: ReportData & { totalRows: number } }) {
  const { money, date } = useFormat()
  const render = (kind: string, v: string | number | null | undefined) => {
    if (v === null || v === undefined || v === '') return ''
    if (kind === 'money' && typeof v === 'number') return money(v)
    if (kind === 'date' && typeof v === 'string') return date(v)
    return String(v)
  }
  return (
    <Card>
      <CardHeader title={`${report.title}${report.subtitle ? ` · ${report.subtitle}` : ''}`} description={`Generated ${formatDateTime(report.generatedAt)} · ${report.dateBasis} · ${report.totalRows} row(s)${report.totalRows > report.rows.length ? ` (preview shows first ${report.rows.length})` : ''}`} />
      {report.summary.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-silver-100 px-4 py-2 text-xs">
          {report.summary.map((s) => (
            <span key={s.label}>
              <span className="text-ink-muted">{s.label}:</span> <span className="font-semibold">{s.value}</span>
            </span>
          ))}
        </div>
      )}
      <Table className="max-h-[480px]">
        <THead>
          <tr>
            {report.columns.map((c) => (
              <Th key={c.key} align={c.align === 'right' ? 'right' : 'left'}>
                {c.label}
              </Th>
            ))}
          </tr>
        </THead>
        <tbody>
          {report.rows.length === 0 && (
            <tr>
              <td colSpan={report.columns.length} className="px-3 py-8 text-center text-sm text-ink-muted">
                No records match the selected filters.
              </td>
            </tr>
          )}
          {report.rows.map((row, i) => (
            <Tr key={i}>
              {report.columns.map((c) => (
                <Td key={c.key} align={c.align === 'right' ? 'right' : 'left'} className="max-w-64 truncate">
                  {render(c.kind, row[c.key])}
                </Td>
              ))}
            </Tr>
          ))}
          {report.totals && (
            <tr className="border-t-2 border-charcoal bg-silver-100 font-semibold">
              {report.columns.map((c) => (
                <Td key={c.key} align={c.align === 'right' ? 'right' : 'left'}>
                  {render(c.kind, report.totals?.[c.key])}
                </Td>
              ))}
            </tr>
          )}
        </tbody>
      </Table>
    </Card>
  )
}

const STATUS_TONE = { VALID: 'credit', DUPLICATE: 'neutral', POSSIBLE_DUPLICATE: 'warning', SKIPPED: 'neutral', ERROR: 'due' } as const

function ImportWizard() {
  const queryClient = useQueryClient()
  const { money } = useFormat()
  const [kind, setKind] = useState<ImportKind>('CUSTOMERS')
  const [session, setSession] = useState<ImportSessionInfo | null>(null)
  const [mapping, setMapping] = useState<Record<string, number | null>>({})
  const [dateFormat, setDateFormat] = useState<'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd'>('dd/MM/yyyy')
  const [validation, setValidation] = useState<ImportValidationResult | null>(null)
  const [confirmFinancial, setConfirmFinancial] = useState(false)
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [importPossible, setImportPossible] = useState(false)
  const [result, setResult] = useState<ImportCommitResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('')
  const reset = () => {
    setSession(null)
    setValidation(null)
    setResult(null)
    setConfirmFinancial(false)
    setSkipInvalid(false)
    setImportPossible(false)
  }
  const choose = async () => {
    setBusy('open')
    try {
      const info = await call('imports:open', { kind })
      if (info) {
        reset()
        setSession(info)
        setMapping(info.suggestedMapping)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const validate = async () => {
    if (!session) return
    setBusy('validate')
    try {
      setValidation(await call('imports:validate', { sessionId: session.sessionId, mapping, dateFormat }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const commit = async () => {
    if (!session) return
    setBusy('commit')
    try {
      const r = await call('imports:commit', { sessionId: session.sessionId, mapping, dateFormat, confirmFinancial, skipInvalidRows: skipInvalid, importPossibleDuplicates: importPossible })
      setResult(r)
      await queryClient.invalidateQueries()
      toast.success(`Imported ${r.importedRows} row(s)`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const cancel = async () => {
    if (session) await call('imports:cancel', { sessionId: session.sessionId }).catch(() => undefined)
    reset()
    toast.message('Import cancelled — no data was changed')
  }
  const financial = kind !== 'CUSTOMERS' || (mapping.opening_balance ?? null) !== null
  const canCommit = validation && validation.validRows + (importPossible ? validation.possibleDuplicateRows : 0) > 0 && (validation.errorRows === 0 || skipInvalid) && (!financial || confirmFinancial)

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="1 · Choose what to import" description="Imported data is validated in full before anything is saved. Existing records are never overwritten." />
        <CardBody className="flex flex-wrap items-end gap-3">
          <Field label="Import type" htmlFor="imp-kind">
            <Select id="imp-kind" className="w-64" value={kind} onChange={(e) => (setKind(e.target.value as ImportKind), reset())} disabled={!!session}>
              <option value="CUSTOMERS">Customer records</option>
              <option value="TRANSACTIONS">Historical transactions</option>
              <option value="USAGE">Daily usage entries</option>
            </Select>
          </Field>
          <Field label="Date format in file" htmlFor="imp-datefmt">
            <Select id="imp-datefmt" className="w-44" value={dateFormat} onChange={(e) => (setDateFormat(e.target.value as typeof dateFormat), setValidation(null))}>
              <option value="dd/MM/yyyy">DD/MM/YYYY</option>
              <option value="MM/dd/yyyy">MM/DD/YYYY</option>
              <option value="yyyy-MM-dd">YYYY-MM-DD</option>
            </Select>
          </Field>
          {!session ? (
            <Button variant="primary" loading={busy === 'open'} onClick={choose}>
              <FileUp /> Choose CSV file…
            </Button>
          ) : (
            <Button variant="outline" onClick={cancel}>
              <XCircle /> Cancel import
            </Button>
          )}
        </CardBody>
        {kind !== 'CUSTOMERS' && !session && (
          <CardBody className="pt-0">
            <Notice tone="info">Customers referenced by code must already exist. Import customers first. Imported payouts are historical records and bypass the overdraft check.</Notice>
          </CardBody>
        )}
      </Card>

      {session && !result && (
        <Card>
          <CardHeader title={`2 · Map columns — ${session.fileName}`} description={`${session.rowCount} data row(s), ${session.headers.length} column(s)`} />
          <CardBody>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {session.fields.map((f) => (
                <Field key={f.key} label={f.label} htmlFor={`map-${f.key}`} required={f.required} hint={f.description}>
                  <Select
                    id={`map-${f.key}`}
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => {
                      setMapping({ ...mapping, [f.key]: e.target.value === '' ? null : Number(e.target.value) })
                      setValidation(null)
                    }}
                  >
                    <option value="">— Not in file —</option>
                    {session.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="dark" loading={busy === 'validate'} onClick={validate}>
                <CheckCircle2 /> Validate &amp; preview
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {validation && !result && (
        <Card>
          <CardHeader title="3 · Review validation" description="Nothing has been saved yet" />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="credit">{validation.validRows} valid</Badge>
              <Badge tone="neutral">{validation.duplicateRows} duplicate</Badge>
              <Badge tone="warning">{validation.possibleDuplicateRows} possible duplicate</Badge>
              <Badge tone="neutral">{validation.skippedRows} skipped</Badge>
              <Badge tone="due">{validation.errorRows} error</Badge>
              {kind !== 'CUSTOMERS' && <span className="text-ink-muted">Net balance effect of valid rows: {money(validation.financialTotalMinor)}</span>}
            </div>
            {validation.sameFileImportedAt && <Notice tone="warning">This exact file was already imported on {formatDateTime(validation.sameFileImportedAt)}. Duplicates are detected by reference, but review carefully.</Notice>}
            {validation.errorRows > 0 && <Notice tone="danger">Rows with errors are never imported. Fix the file and choose it again, or explicitly skip the invalid rows below.</Notice>}
            <div className="flex items-center gap-2">
              <Select aria-label="Filter rows" className="w-52" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="">All rows</option>
                <option value="ERROR">Errors</option>
                <option value="POSSIBLE_DUPLICATE">Possible duplicates</option>
                <option value="DUPLICATE">Duplicates</option>
                <option value="SKIPPED">Skipped</option>
                <option value="VALID">Valid</option>
              </Select>
            </div>
            <Table className="max-h-[420px] rounded border border-silver-200">
              <THead>
                <tr>
                  <Th>Row</Th>
                  <Th>Status</Th>
                  <Th>Data</Th>
                  <Th>Messages</Th>
                </tr>
              </THead>
              <tbody>
                {validation.rows
                  .filter((r) => !statusFilter || r.status === statusFilter)
                  .slice(0, 1500)
                  .map((r) => (
                    <Tr key={r.rowNumber}>
                      <Td className="tabular">{r.rowNumber}</Td>
                      <Td>
                        <Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ').toLowerCase()}</Badge>
                      </Td>
                      <Td className="max-w-md text-xs text-ink-muted">
                        {Object.entries(r.preview)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(' · ')}
                      </Td>
                      <Td className="text-xs">{r.messages.join('; ')}</Td>
                    </Tr>
                  ))}
              </tbody>
            </Table>
            <div className="space-y-2 rounded-md border border-silver-200 p-3">
              {validation.errorRows > 0 && <Checkbox id="imp-skip" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} label={`Skip the ${validation.errorRows} row(s) with errors and import only valid rows`} />}
              {validation.possibleDuplicateRows > 0 && (
                <Checkbox id="imp-possible" checked={importPossible} onChange={(e) => setImportPossible(e.target.checked)} label={`Also import ${validation.possibleDuplicateRows} possible duplicate row(s) as separate records`} />
              )}
              {financial && (
                <Checkbox
                  id="imp-financial"
                  checked={confirmFinancial}
                  onChange={(e) => setConfirmFinancial(e.target.checked)}
                  label="I confirm these financial records (balances, receipts, payouts, charges) are correct and should be added to the ledger"
                />
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={cancel}>
                Cancel — import nothing
              </Button>
              <Button variant="primary" loading={busy === 'commit'} disabled={!canCommit} onClick={commit}>
                Import {validation.validRows + (importPossible ? validation.possibleDuplicateRows : 0)} row(s)
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {result && (
        <Card>
          <CardHeader title="4 · Import summary" description={`Import #${result.importId}`} />
          <CardBody className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {[
                ['Imported', result.importedRows],
                ['Skipped duplicates', result.skippedDuplicateRows],
                ['Skipped possible duplicates', result.skippedPossibleDuplicateRows],
                ['Skipped (reversed / blank)', result.skippedRows],
                ['Failed (not imported)', result.failedRows]
              ].map(([k, v]) => (
                <div key={k} className="rounded-md border border-silver-200 p-3">
                  <p className="text-xs text-ink-muted">{k}</p>
                  <p className="text-xl font-semibold">{v}</p>
                </div>
              ))}
            </div>
            {result.failures.length > 0 && (
              <ul className="max-h-48 overflow-auto text-xs text-due">
                {result.failures.map((f) => (
                  <li key={f.rowNumber}>
                    Row {f.rowNumber}: {f.messages.join('; ')}
                  </li>
                ))}
              </ul>
            )}
            <Button variant="dark" onClick={reset}>
              Start another import
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function ImportHistory() {
  const { data = [] } = useApi('imports:history')
  const { dateFormat } = useFormat()
  return (
    <Card>
      <CardHeader title="Import history" description="Every completed or failed import is recorded" />
      <Table>
        <THead>
          <tr>
            <Th>#</Th>
            <Th>When</Th>
            <Th>Type</Th>
            <Th>File</Th>
            <Th align="right">Rows</Th>
            <Th align="right">Imported</Th>
            <Th align="right">Duplicates</Th>
            <Th align="right">Failed</Th>
            <Th>Status</Th>
          </tr>
        </THead>
        <tbody>
          {data.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-sm text-ink-muted">
                No imports yet.
              </td>
            </tr>
          )}
          {data.map((h) => (
            <Tr key={h.id}>
              <Td>{h.id}</Td>
              <Td className="whitespace-nowrap">{formatDateTime(h.createdAt)}</Td>
              <Td>{h.kind.toLowerCase()}</Td>
              <Td className="max-w-64 truncate">{h.fileName}</Td>
              <Td align="right">{h.totalRows}</Td>
              <Td align="right">{h.importedRows}</Td>
              <Td align="right">{h.skippedDuplicateRows}</Td>
              <Td align="right">{h.failedRows}</Td>
              <Td>
                <Badge tone={h.status === 'COMPLETED' ? 'credit' : 'due'}>{h.status.toLowerCase()}</Badge>
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      <p className="px-4 py-2 text-xs text-ink-faint">Dates shown in local time · display format {formatIsoDate('2026-01-31', dateFormat)}</p>
    </Card>
  )
}

export function CsvCenter() {
  const [tab, setTab] = useState('reports')
  const [help, setHelp] = useState(false)
  return (
    <div>
      <PageHeader
        title="CSV Import / Export & Reports"
        icon={FileSpreadsheet}
        description="Export any report as CSV, print it or save it as HTML; import customers, transactions and usage from CSV"
        actions={
          <Button variant="ghost" onClick={() => setHelp(true)}>
            CSV format help
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'reports', label: 'Reports & export' },
          { value: 'import', label: 'Import CSV' },
          { value: 'history', label: 'Import history' }
        ]}
      >
        <TabPanel value="reports">
          <ReportsPanel />
        </TabPanel>
        <TabPanel value="import">
          <ImportWizard />
        </TabPanel>
        <TabPanel value="history">
          <ImportHistory />
        </TabPanel>
      </Tabs>
      <Dialog open={help} onOpenChange={setHelp} title="CSV format" size="lg">
        <div className="space-y-2 text-sm">
          <p>Exports are UTF-8 CSV files (with a byte-order mark so spreadsheet programs detect the encoding). Amounts are plain decimals such as <code>1250.50</code>, dates are <code>YYYY-MM-DD</code>.</p>
          <p>
            Text that begins with <code>=</code>, <code>+</code>, <code>-</code>, <code>@</code> or a tab is prefixed with an apostrophe so spreadsheet programs do not run it as a formula. The apostrophe is removed again on import.
          </p>
          <p>
            Imports detect columns by name (for example <em>Customer Code</em>, <em>Date</em>, <em>Type</em>, <em>Amount</em>, <em>Payment Method</em>). The “All transactions” and “Daily usage report” exports can be imported back. Reversed entries are skipped because the original and its reversal cancel out.
          </p>
          <p>Transaction types: RECEIPT, PAYOUT, USAGE, CREDIT_ADJUSTMENT, DEBIT_ADJUSTMENT, OPENING_BALANCE. Payment methods and categories must match names configured in Settings.</p>
        </div>
      </Dialog>
    </div>
  )
}
