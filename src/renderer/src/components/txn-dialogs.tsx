import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Undo2, Pencil } from 'lucide-react'
import { TRANSACTION_TYPE_LABELS } from '@shared/finance'
import { quantityToString, minorToDecimalString } from '@shared/money'
import type { ExpenseRow, LedgerRow, UsageEntry } from '@shared/types'
import { useApi, useApiMutation, useFormat } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'
import { Button } from './ui/button'
import { Dialog } from './ui/overlay'
import { Field, Input, Textarea } from './ui/form'
import { Badge, ErrorState, Notice, Spinner } from './ui/layout'
import { Table, THead, Th, Tr, Td } from './ui/table'
import { MoneyText, TxnTypeBadge } from './domain'
import { dateString, useRequestKey } from './forms/shared'
import { emptyLine, toLinePayload, UsageLineEditor, type UsageLineValues } from './forms/usage-form'

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children || <span className="text-ink-faint">—</span>}</dd>
    </div>
  )
}

const reverseSchema = z.object({ reason: z.string().trim().min(3, 'Explain why this entry is being reversed').max(500), date: dateString })

export function ReverseForm({ originalDate, label, onSubmit, loading, onCancel }: { originalDate: string; label: string; loading: boolean; onSubmit: (v: { reason: string; date: string }) => void; onCancel: () => void }) {
  const { register, handleSubmit, formState } = useForm<z.infer<typeof reverseSchema>>({ resolver: zodResolver(reverseSchema), defaultValues: { reason: '', date: originalDate } })
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-3 rounded-lg border border-due/30 bg-due-50/50 p-3">
      <p className="text-sm text-ink">
        A reversal posts an offsetting entry. The original stays in the ledger and the audit log records who reversed it and why. This cannot be undone.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Reason" htmlFor="rev-reason" required error={formState.errors.reason?.message} className="md:col-span-2">
          <Input id="rev-reason" autoFocus {...register('reason')} />
        </Field>
        <Field label="Reversal date" htmlFor="rev-date" required error={formState.errors.date?.message} hint="Defaults to the original date">
          <Input id="rev-date" type="date" {...register('date')} />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" loading={loading}>
          <Undo2 /> {label}
        </Button>
      </div>
    </form>
  )
}

export function TransactionDetailDialog({ txnId, onClose }: { txnId: number | null; onClose: () => void }) {
  const { money, date } = useFormat()
  const { data, isLoading, error, refetch } = useApi('ledger:get', { id: txnId ?? 0 }, { enabled: !!txnId })
  const [mode, setMode] = useState<'view' | 'reverse' | 'notes'>('view')
  const [requestKey, resetKey] = useRequestKey()
  const reverse = useApiMutation('ledger:reverse', { successMessage: (r) => `Reversal ${r.reference} posted` })
  const notes = useApiMutation('ledger:updateNotes', { successMessage: () => 'Notes updated' })
  const notesForm = useForm({ values: { description: data?.description ?? '', notes: data?.notes ?? '', reason: '' } })
  const close = () => {
    setMode('view')
    onClose()
  }
  return (
    <Dialog open={!!txnId} onOpenChange={(o) => !o && close()} title={data ? `${data.reference} · ${TRANSACTION_TYPE_LABELS[data.type]}` : 'Transaction'} size="lg">
      {isLoading && <Spinner />}
      {error && <ErrorState error={error} onRetry={() => refetch()} />}
      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <TxnTypeBadge type={data.type} reversal={data.isReversal} />
            {data.reversedByReference && <Badge tone="due">Reversed by {data.reversedByReference}</Badge>}
            {data.source !== 'MANUAL' && <Badge>{data.source.toLowerCase()}</Badge>}
            {data.overrideReason && <Badge tone="warning">Overdraft override</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Detail label="Customer">
              {data.customerName} <span className="text-ink-muted">({data.customerCode})</span>
            </Detail>
            <Detail label="Date">{date(data.txnDate)}</Detail>
            <Detail label="Amount">
              <MoneyText minor={data.amountMinor} className="font-semibold" />
            </Detail>
            <Detail label="Balance effect">
              <MoneyText minor={data.balanceEffectMinor} tone="balance" />
            </Detail>
            <Detail label="Running balance">
              <MoneyText minor={data.runningBalanceMinor} tone="balance" />
            </Detail>
            <Detail label="Payment method">{data.paymentMethod}</Detail>
            <Detail label="Payment reference">{data.paymentReference}</Detail>
            <Detail label="Category">{data.category}</Detail>
            <Detail label="Description">{data.description}</Detail>
            <Detail label="Reason">{data.reason}</Detail>
            <Detail label="Override reason">{data.overrideReason}</Detail>
            <Detail label="Notes">{data.notes}</Detail>
            <Detail label="Reverses">{data.reversesReference}</Detail>
            <Detail label="Related receipt">{data.relatedReference}</Detail>
            <Detail label="Original reference">{data.externalRef}</Detail>
            <Detail label="Recorded">
              {formatDateTime(data.createdAt)}
              {data.createdBy ? ` by ${data.createdBy}` : ''}
            </Detail>
          </dl>

          {data.usageEntry && (
            <div className="rounded-md border border-silver-200 p-3 text-sm">
              <p className="mb-2 font-semibold">Usage detail</p>
              <p>
                {data.usageEntry.category}: {data.usageEntry.description} ·{' '}
                {data.usageEntry.method === 'QUANTITY'
                  ? `${quantityToString(data.usageEntry.quantityMilli ?? 0)} ${data.usageEntry.unit ?? ''} × ${money(data.usageEntry.rateMinor ?? 0)}`
                  : `Fixed: ${data.usageEntry.fixedReason ?? ''}`}{' '}
                · fees {money(data.usageEntry.feesMinor)} · discount {money(data.usageEntry.discountMinor)}
                {data.usageEntry.discountReason ? ` (${data.usageEntry.discountReason})` : ''}
              </p>
            </div>
          )}

          {data.linkedPayouts.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-semibold">Payouts linked to this receipt</p>
              <ul className="text-sm text-ink-muted">
                {data.linkedPayouts.map((p) => (
                  <li key={p.id}>
                    {p.reference} · {date(p.txnDate)} · {money(p.amountMinor)} {p.reversed && <Badge tone="due">Reversed</Badge>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {data.audit.length > 0 && (
            <div>
              <p className="mb-1 text-sm font-semibold">Audit trail</p>
              <ul className="space-y-1 text-xs text-ink-muted">
                {data.audit.map((a) => (
                  <li key={a.id}>
                    {formatDateTime(a.occurredAt)} · <span className="font-medium text-ink">{a.action.replace(/_/g, ' ').toLowerCase()}</span>
                    {a.actor ? ` by ${a.actor}` : ''}
                    {a.summary ? ` — ${a.summary}` : ''}
                    {a.reason ? ` (reason: ${a.reason})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mode === 'view' && (
            <div className="flex justify-end gap-2 border-t border-silver-100 pt-3">
              <Button variant="outline" onClick={() => setMode('notes')}>
                <Pencil /> Edit description / notes
              </Button>
              <Button variant="danger" disabled={!data.canReverse} title={data.reverseBlockedReason ?? undefined} onClick={() => setMode('reverse')}>
                <Undo2 /> Reverse entry
              </Button>
            </div>
          )}
          {!data.canReverse && data.reverseBlockedReason && mode === 'view' && <p className="text-right text-xs text-ink-muted">{data.reverseBlockedReason}</p>}
          {mode === 'reverse' && (
            <ReverseForm
              originalDate={data.txnDate}
              label="Post reversal"
              loading={reverse.isPending}
              onCancel={() => setMode('view')}
              onSubmit={async (v) => {
                try {
                  await reverse.mutateAsync({ txnId: data.id, reason: v.reason, date: v.date, idempotencyKey: requestKey })
                  resetKey()
                  setMode('view')
                } catch {
                  /* toast shown */
                }
              }}
            />
          )}
          {mode === 'notes' && (
            <form
              className="space-y-3 rounded-lg border border-silver-200 p-3"
              onSubmit={notesForm.handleSubmit(async (v) => {
                try {
                  await notes.mutateAsync({ txnId: data.id, description: v.description, notes: v.notes || null, reason: v.reason || null })
                  setMode('view')
                } catch {
                  /* toast shown */
                }
              })}
            >
              <p className="text-xs text-ink-muted">Only descriptive text can be edited. Amounts, dates and customers are locked; use a reversal to correct them.</p>
              <Field label="Description" htmlFor="tn-desc" required>
                <Input id="tn-desc" {...notesForm.register('description', { required: true })} />
              </Field>
              <Field label="Notes" htmlFor="tn-notes">
                <Textarea id="tn-notes" rows={2} {...notesForm.register('notes')} />
              </Field>
              <Field label="Reason for edit" htmlFor="tn-reason">
                <Input id="tn-reason" {...notesForm.register('reason')} />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setMode('view')}>
                  Cancel
                </Button>
                <Button type="submit" variant="dark" loading={notes.isPending}>
                  Save
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </Dialog>
  )
}

function lineFromEntry(entry: UsageEntry, minorDigits: number): UsageLineValues {
  return {
    ...emptyLine(String(entry.categoryId)),
    description: entry.description,
    method: entry.method,
    quantity: entry.quantityMilli !== null ? quantityToString(entry.quantityMilli) : '',
    unitId: entry.unitId ? String(entry.unitId) : '',
    rate: entry.rateMinor !== null ? minorToDecimalString(entry.rateMinor, minorDigits) : '',
    fixedAmount: entry.method === 'FIXED' ? minorToDecimalString(entry.baseAmountMinor, minorDigits) : '',
    fixedReason: entry.fixedReason ?? '',
    fees: entry.feesMinor ? minorToDecimalString(entry.feesMinor, minorDigits) : '',
    discount: entry.discountMinor ? minorToDecimalString(entry.discountMinor, minorDigits) : '',
    discountReason: entry.discountReason ?? '',
    notes: entry.notes ?? ''
  }
}

/** Usage correction: reverse the posted charge and optionally post a corrected replacement. */
export function UsageCorrectionDialog({ entry, onClose }: { entry: UsageEntry | null; onClose: () => void }) {
  const { currency, money, date } = useFormat()
  const [requestKey, resetKey] = useRequestKey()
  const [replace, setReplace] = useState(true)
  const mutation = useApiMutation('usage:correct', {
    successMessage: (r) => (r.replacement ? `Corrected: ${r.reversalReference} reversed, ${r.replacement.reference} posted` : `Usage reversed by ${r.reversalReference}`)
  })
  const form = useForm<{ reason: string; usageDate: string; line: UsageLineValues }>({
    values: entry ? { reason: '', usageDate: entry.usageDate, line: lineFromEntry(entry, currency.minorDigits) } : undefined
  })
  if (!entry) return null
  const submit = form.handleSubmit(async (v) => {
    if (v.reason.trim().length < 3) {
      form.setError('reason', { message: 'Explain the reason for the correction' })
      return
    }
    try {
      await mutation.mutateAsync({
        entryId: entry.id,
        reason: v.reason.trim(),
        replacement: replace ? { usageDate: v.usageDate, line: toLinePayload(v.line, currency.minorDigits) } : null,
        idempotencyKey: requestKey
      })
      resetKey()
      onClose()
    } catch {
      /* toast shown */
    }
  })
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()} title={`Correct usage ${entry.txnReference}`} description={`${entry.customerName} · ${date(entry.usageDate)} · ${money(entry.chargeMinor)}`} size="xl">
      <form onSubmit={submit} noValidate className="space-y-4">
        <Notice tone="info">The original charge is never edited. It is reversed with an offsetting ledger entry, and the corrected charge is posted as a new entry linked to the original.</Notice>
        <Field label="Reason for correction" htmlFor="uc-reason" required error={form.formState.errors.reason?.message}>
          <Input id="uc-reason" autoFocus {...form.register('reason')} />
        </Field>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" className="accent-racing" checked={replace} onChange={() => setReplace(true)} /> Reverse and post a corrected charge
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" className="accent-racing" checked={!replace} onChange={() => setReplace(false)} /> Reverse only (charge was not incurred)
          </label>
        </div>
        {replace && (
          <>
            <Field label="Usage date" htmlFor="uc-date" className="max-w-xs">
              <Input id="uc-date" type="date" {...form.register('usageDate')} />
            </Field>
            <UsageLineEditor prefix="line" index={0} register={form.register} watch={form.watch} />
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={mutation.isPending}>
            {replace ? 'Reverse and post correction' : 'Reverse charge'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function ExpenseDetailDialog({ expense, onClose }: { expense: ExpenseRow | null; onClose: () => void }) {
  const { money, date } = useFormat()
  const [reversing, setReversing] = useState(false)
  const [requestKey, resetKey] = useRequestKey()
  const mutation = useApiMutation('expenses:reverse', { successMessage: (r) => `Expense reversal ${r.reference} posted` })
  if (!expense) return null
  return (
    <Dialog open={!!expense} onOpenChange={(o) => !o && (setReversing(false), onClose())} title={`${expense.reference} · Business expense`} size="md">
      <dl className="grid grid-cols-2 gap-4">
        <Detail label="Date">{date(expense.expenseDate)}</Detail>
        <Detail label="Amount">
          <MoneyText minor={expense.amountMinor} className="font-semibold" />
        </Detail>
        <Detail label="Category">{expense.category}</Detail>
        <Detail label="Payment method">{expense.paymentMethod}</Detail>
        <Detail label="Description">{expense.description}</Detail>
        <Detail label="Supplier">{expense.supplier}</Detail>
        <Detail label="Reference">{expense.paymentReference}</Detail>
        <Detail label="Notes">{expense.notes}</Detail>
        <Detail label="Reverses">{expense.reversesReference}</Detail>
        <Detail label="Reversed by">{expense.reversedByReference}</Detail>
        <Detail label="Reason">{expense.reason}</Detail>
        <Detail label="Recorded">
          {formatDateTime(expense.createdAt)}
          {expense.createdBy ? ` by ${expense.createdBy}` : ''}
        </Detail>
      </dl>
      <div className="mt-4">
        {!reversing ? (
          <div className="flex justify-end">
            <Button variant="danger" disabled={expense.isReversal || !!expense.reversedByReference} onClick={() => setReversing(true)}>
              <Undo2 /> Reverse expense
            </Button>
          </div>
        ) : (
          <ReverseForm
            originalDate={expense.expenseDate}
            label={`Reverse ${money(expense.amountMinor)}`}
            loading={mutation.isPending}
            onCancel={() => setReversing(false)}
            onSubmit={async (v) => {
              try {
                await mutation.mutateAsync({ expenseId: expense.id, reason: v.reason, date: v.date, idempotencyKey: requestKey })
                resetKey()
                setReversing(false)
                onClose()
              } catch {
                /* toast shown */
              }
            }}
          />
        )}
      </div>
    </Dialog>
  )
}

/** Ledger table with inflow/outflow/usage/adjustment columns and running balance. */
export function LedgerTable({ rows, showCustomer, onOpen, emptyText = 'No transactions match these filters.' }: { rows: LedgerRow[]; showCustomer?: boolean; onOpen: (id: number) => void; emptyText?: string }) {
  const { date } = useFormat()
  return (
    <Table className="max-h-[560px]">
      <THead>
        <tr>
          <Th>Date</Th>
          <Th>Reference</Th>
          {showCustomer && <Th>Customer</Th>}
          <Th>Type</Th>
          <Th>Description</Th>
          <Th align="right">Received</Th>
          <Th align="right">Paid</Th>
          <Th align="right">Usage</Th>
          <Th align="right">Adjustment</Th>
          <Th align="right">Running balance</Th>
          <Th>Method</Th>
        </tr>
      </THead>
      <tbody>
        {rows.length === 0 && (
          <tr>
            <td colSpan={showCustomer ? 11 : 10} className="px-3 py-10 text-center text-sm text-ink-muted">
              {emptyText}
            </td>
          </tr>
        )}
        {rows.map((r) => (
          <Tr key={r.id} onClick={() => onOpen(r.id)} className={r.isReversal || r.reversedByTxnId ? 'text-ink-muted' : ''}>
            <Td className="whitespace-nowrap">{date(r.txnDate)}</Td>
            <Td className="whitespace-nowrap font-mono text-xs">
              {r.reference}
              {r.reversedByReference && <span className="ml-1 text-due">(reversed)</span>}
            </Td>
            {showCustomer && (
              <Td className="min-w-44">
                <span className="font-medium">{r.customerName}</span>
                <span className="block text-xs text-ink-muted">{r.customerCode}</span>
              </Td>
            )}
            <Td className="whitespace-nowrap">
              <TxnTypeBadge type={r.type} reversal={r.isReversal} />
            </Td>
            <Td className="min-w-48 max-w-72">
              <span className="line-clamp-2">{r.description}</span>
              {r.notes && <span className="block truncate text-xs text-ink-muted">{r.notes}</span>}
            </Td>
            <Td align="right">{r.type === 'RECEIPT' ? <MoneyText minor={r.amountMinor} /> : ''}</Td>
            <Td align="right">{r.type === 'PAYOUT' ? <MoneyText minor={r.amountMinor} /> : ''}</Td>
            <Td align="right">{r.type === 'USAGE' ? <MoneyText minor={r.amountMinor} /> : ''}</Td>
            <Td align="right">{['CREDIT_ADJUSTMENT', 'DEBIT_ADJUSTMENT', 'OPENING_BALANCE'].includes(r.type) ? <MoneyText minor={r.balanceEffectMinor} /> : ''}</Td>
            <Td align="right" className="font-semibold">
              <MoneyText minor={r.runningBalanceMinor} tone="balance" />
            </Td>
            <Td className="whitespace-nowrap text-xs text-ink-muted">{r.paymentMethod ?? ''}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}
