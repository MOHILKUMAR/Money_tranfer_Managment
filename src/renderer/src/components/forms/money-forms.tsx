import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Scale } from 'lucide-react'
import { parseMoney } from '@shared/money'
import type { MutationResult } from '@shared/types'
import { useApi, useApiMutation, useFormat, useLookups, useSettings, useToday } from '@/lib/queries'
import { Button } from '../ui/button'
import { Checkbox, Field, Input, Select, Textarea } from '../ui/form'
import { ConfirmDialog } from '../ui/overlay'
import { Notice } from '../ui/layout'
import { CustomerPicker, MoneyInput, MoneyText } from '../domain'
import { dateString, moneyString, optionalId, SummaryRow, toMinor, useRequestKey } from './shared'

type Saved = (result: MutationResult) => void

/* ---------------------------------------------------------------- Receipt */

export function ReceiptForm({ defaultCustomerId, onSaved, compact }: { defaultCustomerId?: number | null; onSaved?: Saved; compact?: boolean }) {
  const today = useToday()
  const { currency, money, date } = useFormat()
  const { data: lookups } = useLookups()
  const [requestKey, resetKey] = useRequestKey()
  const [pending, setPending] = useState<null | Record<string, unknown>>(null)
  const schema = useMemo(
    () =>
      z.object({
        customerId: z.number({ message: 'Select a customer' }).int().positive('Select a customer'),
        date: dateString,
        amount: moneyString(currency.minorDigits),
        paymentMethodId: z.string().min(1, 'Choose a payment method'),
        paymentReference: z.string().max(100),
        categoryId: z.string(),
        description: z.string().max(300),
        notes: z.string().max(2000)
      }),
    [currency.minorDigits]
  )
  type Values = z.infer<typeof schema>
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { customerId: defaultCustomerId ?? (undefined as unknown as number), date: today, amount: '', paymentMethodId: '', paymentReference: '', categoryId: '', description: '', notes: '' }
  })
  const { register, handleSubmit, control, formState, reset, watch } = form
  const mutation = useApiMutation('ledger:recordReceipt', {
    successMessage: (r) => (r.duplicateRequest ? `Already recorded as ${r.reference}` : `Receipt ${r.reference} saved`)
  })
  const methods = lookups?.payment_methods.filter((m) => m.isActive) ?? []
  const categories = lookups?.transaction_categories.filter((c) => c.isActive && (c.appliesTo === 'RECEIPT' || c.appliesTo === 'ANY')) ?? []
  const { data: customer } = useApi('customers:get', { id: watch('customerId') ?? 0 }, { enabled: !!watch('customerId') })

  const submit = handleSubmit((values) => {
    setPending({
      customerId: values.customerId,
      date: values.date,
      amountMinor: toMinor(values.amount, currency.minorDigits),
      paymentMethodId: Number(values.paymentMethodId),
      paymentReference: values.paymentReference || null,
      categoryId: optionalId(values.categoryId),
      description: values.description || null,
      notes: values.notes || null,
      idempotencyKey: requestKey
    })
  })

  const confirm = async () => {
    if (!pending) return
    try {
      const result = await mutation.mutateAsync(pending as never)
      setPending(null)
      resetKey()
      reset({ customerId: defaultCustomerId ?? (undefined as unknown as number), date: today, amount: '', paymentMethodId: watch('paymentMethodId'), paymentReference: '', categoryId: '', description: '', notes: '' })
      onSaved?.(result)
    } catch {
      setPending(null)
    }
  }
  const e = formState.errors
  const amountPreview = parseMoney(watch('amount') || '', { minorDigits: currency.minorDigits })

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Record money received">
      <div className={compact ? 'grid gap-4' : 'grid gap-4 md:grid-cols-2'}>
        <Field label="Customer" htmlFor="rc-customer" required error={e.customerId?.message} className="md:col-span-2">
          <Controller control={control} name="customerId" render={({ field }) => <CustomerPicker id="rc-customer" value={field.value ?? null} onChange={(id) => field.onChange(id ?? undefined)} invalid={!!e.customerId} />} />
        </Field>
        <Field label="Amount received" htmlFor="rc-amount" required error={e.amount?.message}>
          <MoneyInput id="rc-amount" aria-invalid={!!e.amount} {...register('amount')} />
        </Field>
        <Field label="Transaction date" htmlFor="rc-date" required error={e.date?.message}>
          <Input id="rc-date" type="date" aria-invalid={!!e.date} {...register('date')} />
        </Field>
        <Field label="Payment method" htmlFor="rc-method" required error={e.paymentMethodId?.message}>
          <Select id="rc-method" aria-invalid={!!e.paymentMethodId} {...register('paymentMethodId')}>
            <option value="">Choose…</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference number" htmlFor="rc-ref" error={e.paymentReference?.message} hint="UTR, cheque no., receipt no.">
          <Input id="rc-ref" {...register('paymentReference')} />
        </Field>
        <Field label="Category" htmlFor="rc-cat">
          <Select id="rc-cat" {...register('categoryId')}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" htmlFor="rc-desc" error={e.description?.message}>
          <Input id="rc-desc" placeholder="Optional" {...register('description')} />
        </Field>
        <Field label="Notes" htmlFor="rc-notes" className="md:col-span-2">
          <Textarea id="rc-notes" rows={2} {...register('notes')} />
        </Field>
      </div>
      <Notice tone="info">This records a payment you received. It is a local record and has not been verified by a bank or payment provider.</Notice>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          <ArrowDownLeft /> Review receipt
        </Button>
      </div>
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} title="Record money received?" confirmLabel="Save receipt" loading={mutation.isPending} onConfirm={confirm}>
        <dl className="divide-y divide-silver-100">
          <SummaryRow label="Customer">{customer ? `${customer.name} (${customer.customerCode})` : '—'}</SummaryRow>
          <SummaryRow label="Amount">{amountPreview.ok ? money(amountPreview.value) : '—'}</SummaryRow>
          <SummaryRow label="Date">{date(watch('date'))}</SummaryRow>
          <SummaryRow label="Method">{methods.find((m) => String(m.id) === watch('paymentMethodId'))?.name ?? '—'}</SummaryRow>
          {customer && amountPreview.ok && (
            <SummaryRow label="Balance after">
              <MoneyText minor={customer.balanceMinor + amountPreview.value} tone="balance" />
            </SummaryRow>
          )}
        </dl>
      </ConfirmDialog>
    </form>
  )
}

/* ----------------------------------------------------------------- Payout */

export function PayoutForm({ defaultCustomerId, defaultRelatedTxnId, onSaved, compact }: { defaultCustomerId?: number | null; defaultRelatedTxnId?: number | null; onSaved?: Saved; compact?: boolean }) {
  const today = useToday()
  const { currency, money, date } = useFormat()
  const { data: lookups } = useLookups()
  const { data: settings } = useSettings()
  const [requestKey, resetKey] = useRequestKey()
  const [pending, setPending] = useState<null | Record<string, unknown>>(null)
  const schema = useMemo(
    () =>
      z
        .object({
          customerId: z.number({ message: 'Select a customer' }).int().positive('Select a customer'),
          date: dateString,
          amount: moneyString(currency.minorDigits),
          paymentMethodId: z.string().min(1, 'Choose a payment method'),
          paymentReference: z.string().max(100),
          categoryId: z.string(),
          reason: z.string().trim().min(1, 'Give a reason for the payment').max(500),
          relatedTxnId: z.string(),
          notes: z.string().max(2000),
          overrideConfirmed: z.boolean(),
          overrideReason: z.string().max(500)
        }),
    [currency.minorDigits]
  )
  type Values = z.infer<typeof schema>
  const { register, handleSubmit, control, formState, reset, watch, setError } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerId: defaultCustomerId ?? (undefined as unknown as number),
      date: today,
      amount: '',
      paymentMethodId: '',
      paymentReference: '',
      categoryId: '',
      reason: '',
      relatedTxnId: defaultRelatedTxnId ? String(defaultRelatedTxnId) : '',
      notes: '',
      overrideConfirmed: false,
      overrideReason: ''
    }
  })
  const customerId = watch('customerId')
  const amountParsed = parseMoney(watch('amount') || '', { minorDigits: currency.minorDigits })
  const amountMinor = amountParsed.ok ? amountParsed.value : 0
  const relatedTxnId = optionalId(watch('relatedTxnId'))
  const [debouncedAmount, setDebouncedAmount] = useState(amountMinor)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedAmount(amountMinor), 250)
    return () => clearTimeout(t)
  }, [amountMinor])
  const { data: preview } = useApi('ledger:previewPayout', { customerId: customerId ?? 0, amountMinor: debouncedAmount, relatedTxnId }, { enabled: !!customerId })
  const { data: receipts } = useApi('ledger:list', { customerId: customerId ?? 0, types: ['RECEIPT'], sortDir: 'desc', pageSize: 100 }, { enabled: !!customerId })
  const { data: customer } = useApi('customers:get', { id: customerId ?? 0 }, { enabled: !!customerId })
  const mutation = useApiMutation('ledger:recordPayout', {
    successMessage: (r) => (r.duplicateRequest ? `Already recorded as ${r.reference}` : `Payout ${r.reference} saved`)
  })
  const methods = lookups?.payment_methods.filter((m) => m.isActive) ?? []
  const categories = lookups?.transaction_categories.filter((c) => c.isActive && (c.appliesTo === 'PAYOUT' || c.appliesTo === 'ANY')) ?? []
  const exceeds = !!preview && amountMinor > 0 && amountMinor > preview.availableCreditMinor
  const blocked = exceeds && settings?.payoutOverdraftPolicy === 'BLOCK'

  const submit = handleSubmit((values) => {
    const amount = toMinor(values.amount, currency.minorDigits)
    if (blocked) {
      setError('amount', { message: 'Payout exceeds available credit and overdraft payouts are disabled in Settings' })
      return
    }
    if (exceeds) {
      if (!values.overrideConfirmed) {
        setError('overrideConfirmed', { message: 'Confirm that this overdraft payout is authorised' })
        return
      }
      if (values.overrideReason.trim().length < 3) {
        setError('overrideReason', { message: 'Explain who authorised the override and why' })
        return
      }
    }
    if (preview?.relatedReceiptError) {
      setError('relatedTxnId', { message: preview.relatedReceiptError })
      return
    }
    setPending({
      customerId: values.customerId,
      date: values.date,
      amountMinor: amount,
      paymentMethodId: Number(values.paymentMethodId),
      paymentReference: values.paymentReference || null,
      categoryId: optionalId(values.categoryId),
      reason: values.reason,
      relatedTxnId: optionalId(values.relatedTxnId),
      notes: values.notes || null,
      override: exceeds ? { confirmed: true, reason: values.overrideReason.trim() } : null,
      idempotencyKey: requestKey
    })
  })

  const confirm = async () => {
    if (!pending) return
    try {
      const result = await mutation.mutateAsync(pending as never)
      setPending(null)
      resetKey()
      reset({ customerId: defaultCustomerId ?? (undefined as unknown as number), date: today, amount: '', paymentMethodId: watch('paymentMethodId'), paymentReference: '', categoryId: '', reason: '', relatedTxnId: '', notes: '', overrideConfirmed: false, overrideReason: '' })
      onSaved?.(result)
    } catch {
      setPending(null)
    }
  }
  const e = formState.errors
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Record money paid to customer">
      <div className={compact ? 'grid gap-4' : 'grid gap-4 md:grid-cols-2'}>
        <Field label="Customer" htmlFor="po-customer" required error={e.customerId?.message} className="md:col-span-2">
          <Controller control={control} name="customerId" render={({ field }) => <CustomerPicker id="po-customer" value={field.value ?? null} onChange={(id) => field.onChange(id ?? undefined)} invalid={!!e.customerId} />} />
        </Field>
        <Field label="Amount paid" htmlFor="po-amount" required error={e.amount?.message}>
          <MoneyInput id="po-amount" aria-invalid={!!e.amount} {...register('amount')} />
        </Field>
        <Field label="Payment date" htmlFor="po-date" required error={e.date?.message}>
          <Input id="po-date" type="date" {...register('date')} />
        </Field>
        <Field label="Payment method" htmlFor="po-method" required error={e.paymentMethodId?.message}>
          <Select id="po-method" aria-invalid={!!e.paymentMethodId} {...register('paymentMethodId')}>
            <option value="">Choose…</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference number" htmlFor="po-ref">
          <Input id="po-ref" {...register('paymentReference')} />
        </Field>
        <Field label="Reason for payment" htmlFor="po-reason" required error={e.reason?.message} className="md:col-span-2">
          <Input id="po-reason" placeholder="e.g. Refund of unused advance" aria-invalid={!!e.reason} {...register('reason')} />
        </Field>
        <Field label="Category" htmlFor="po-cat">
          <Select id="po-cat" {...register('categoryId')}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Related receipt (refund of)" htmlFor="po-related" error={e.relatedTxnId?.message ?? preview?.relatedReceiptError} hint="Linking prevents refunding a receipt twice">
          <Select id="po-related" {...register('relatedTxnId')} disabled={!customerId}>
            <option value="">Not linked</option>
            {receipts?.rows
              .filter((r) => !r.isReversal && !r.reversedByTxnId)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.reference} · {date(r.txnDate)} · {money(r.amountMinor)}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Notes" htmlFor="po-notes" className="md:col-span-2">
          <Textarea id="po-notes" rows={2} {...register('notes')} />
        </Field>
      </div>

      {preview && customerId && (
        <div className="grid grid-cols-3 gap-3 rounded-md border border-silver-200 bg-silver-100/50 p-3 text-sm">
          <div>
            <p className="text-xs text-ink-muted">Current balance</p>
            <MoneyText minor={preview.currentBalanceMinor} tone="balance" className="font-semibold" />
          </div>
          <div>
            <p className="text-xs text-ink-muted">Available credit</p>
            <MoneyText minor={preview.availableCreditMinor} className="font-semibold" />
          </div>
          <div>
            <p className="text-xs text-ink-muted">Balance after payout</p>
            <MoneyText minor={preview.balanceAfterMinor} tone="balance" className="font-semibold" />
          </div>
          {preview.relatedReceipt && (
            <p className="col-span-3 text-xs text-ink-muted">
              Receipt {preview.relatedReceipt.reference}: {money(preview.relatedReceipt.amountMinor)} received, {money(preview.relatedReceipt.alreadyRefundedMinor)} already refunded,{' '}
              {money(preview.relatedReceipt.refundableMinor)} refundable.
            </p>
          )}
        </div>
      )}

      {exceeds && (
        <Notice tone={blocked ? 'danger' : 'warning'} title={blocked ? 'Payout not allowed' : 'Payout exceeds available credit'}>
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              This payout is {money(preview!.shortfallMinor)} more than {customer?.name ?? 'the customer'}'s available credit and would leave a balance of {money(preview!.balanceAfterMinor)}.
              {blocked ? ' Overdraft payouts are disabled in Settings.' : ' It can only be saved with an authorised override.'}
            </span>
          </p>
          {!blocked && (
            <div className="mt-3 space-y-2 text-ink">
              <Checkbox id="po-override" label="I confirm this overdraft payout has been authorised" {...register('overrideConfirmed')} />
              {e.overrideConfirmed && <p className="text-xs font-medium text-due">{e.overrideConfirmed.message}</p>}
              <Field label="Override reason / authorised by" htmlFor="po-override-reason" error={e.overrideReason?.message}>
                <Input id="po-override-reason" {...register('overrideReason')} />
              </Field>
            </div>
          )}
        </Notice>
      )}

      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={mutation.isPending} disabled={blocked}>
          <ArrowUpRight /> Review payout
        </Button>
      </div>
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} title="Record payment to customer?" confirmLabel="Save payout" loading={mutation.isPending} onConfirm={confirm}>
        <dl className="divide-y divide-silver-100">
          <SummaryRow label="Customer">{customer ? `${customer.name} (${customer.customerCode})` : '—'}</SummaryRow>
          <SummaryRow label="Amount">{money(amountMinor)}</SummaryRow>
          <SummaryRow label="Date">{date(watch('date'))}</SummaryRow>
          <SummaryRow label="Reason">{watch('reason')}</SummaryRow>
          {preview && (
            <SummaryRow label="Balance after">
              <MoneyText minor={preview.balanceAfterMinor} tone="balance" />
            </SummaryRow>
          )}
          {exceeds && <SummaryRow label="Override">{watch('overrideReason')}</SummaryRow>}
        </dl>
      </ConfirmDialog>
    </form>
  )
}

/* ------------------------------------------------------------- Adjustment */

export function AdjustmentForm({ defaultCustomerId, onSaved }: { defaultCustomerId?: number | null; onSaved?: Saved }) {
  const today = useToday()
  const { currency, money } = useFormat()
  const { data: lookups } = useLookups()
  const [requestKey, resetKey] = useRequestKey()
  const [pending, setPending] = useState<null | Record<string, unknown>>(null)
  const schema = useMemo(
    () =>
      z.object({
        customerId: z.number({ message: 'Select a customer' }).int().positive('Select a customer'),
        direction: z.enum(['CREDIT', 'DEBIT']),
        date: dateString,
        amount: moneyString(currency.minorDigits),
        categoryId: z.string(),
        reason: z.string().trim().min(3, 'Explain the reason for the adjustment').max(500),
        notes: z.string().max(2000)
      }),
    [currency.minorDigits]
  )
  type Values = z.infer<typeof schema>
  const { register, handleSubmit, control, formState, reset, watch } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { customerId: defaultCustomerId ?? (undefined as unknown as number), direction: 'CREDIT', date: today, amount: '', categoryId: '', reason: '', notes: '' }
  })
  const mutation = useApiMutation('ledger:recordAdjustment', { successMessage: (r) => `Adjustment ${r.reference} saved` })
  const categories = lookups?.transaction_categories.filter((c) => c.isActive && (c.appliesTo === 'ADJUSTMENT' || c.appliesTo === 'ANY')) ?? []
  const e = formState.errors
  const submit = handleSubmit((v) =>
    setPending({
      customerId: v.customerId,
      direction: v.direction,
      date: v.date,
      amountMinor: toMinor(v.amount, currency.minorDigits),
      categoryId: optionalId(v.categoryId),
      reason: v.reason,
      notes: v.notes || null,
      idempotencyKey: requestKey
    })
  )
  const confirm = async () => {
    try {
      const result = await mutation.mutateAsync(pending as never)
      setPending(null)
      resetKey()
      reset({ customerId: defaultCustomerId ?? (undefined as unknown as number), direction: 'CREDIT', date: today, amount: '', categoryId: '', reason: '', notes: '' })
      onSaved?.(result)
    } catch {
      setPending(null)
    }
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Record adjustment">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Customer" htmlFor="adj-customer" required error={e.customerId?.message} className="md:col-span-2">
          <Controller control={control} name="customerId" render={({ field }) => <CustomerPicker id="adj-customer" value={field.value ?? null} onChange={(id) => field.onChange(id ?? undefined)} invalid={!!e.customerId} />} />
        </Field>
        <Field label="Adjustment type" htmlFor="adj-direction" required>
          <Select id="adj-direction" {...register('direction')}>
            <option value="CREDIT">Credit adjustment (increases customer credit)</option>
            <option value="DEBIT">Debit adjustment (reduces credit / increases amount due)</option>
          </Select>
        </Field>
        <Field label="Amount" htmlFor="adj-amount" required error={e.amount?.message}>
          <MoneyInput id="adj-amount" aria-invalid={!!e.amount} {...register('amount')} />
        </Field>
        <Field label="Date" htmlFor="adj-date" required error={e.date?.message}>
          <Input id="adj-date" type="date" {...register('date')} />
        </Field>
        <Field label="Category" htmlFor="adj-cat">
          <Select id="adj-cat" {...register('categoryId')}>
            <option value="">None</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason / approval" htmlFor="adj-reason" required error={e.reason?.message} className="md:col-span-2">
          <Input id="adj-reason" aria-invalid={!!e.reason} {...register('reason')} />
        </Field>
        <Field label="Notes" htmlFor="adj-notes" className="md:col-span-2">
          <Textarea id="adj-notes" rows={2} {...register('notes')} />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="dark" loading={mutation.isPending}>
          <Scale /> Review adjustment
        </Button>
      </div>
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} title="Record adjustment?" confirmLabel="Save adjustment" loading={mutation.isPending} onConfirm={confirm}>
        {watch('direction') === 'CREDIT' ? 'Credit' : 'Debit'} adjustment of {money(pending ? (pending.amountMinor as number) : 0)}. Adjustments change the customer balance but are not cash movements.
      </ConfirmDialog>
    </form>
  )
}
