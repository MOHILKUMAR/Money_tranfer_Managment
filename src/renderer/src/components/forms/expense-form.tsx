import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Receipt } from 'lucide-react'
import type { MutationResult } from '@shared/types'
import { useApiMutation, useFormat, useLookups, useToday } from '@/lib/queries'
import { Button } from '../ui/button'
import { Field, Input, Select, Textarea } from '../ui/form'
import { ConfirmDialog } from '../ui/overlay'
import { MoneyInput } from '../domain'
import { dateString, moneyString, SummaryRow, toMinor, useRequestKey } from './shared'

export function ExpenseForm({ onSaved, compact }: { onSaved?: (r: MutationResult) => void; compact?: boolean }) {
  const today = useToday()
  const { currency, money, date } = useFormat()
  const { data: lookups } = useLookups()
  const [requestKey, resetKey] = useRequestKey()
  const [pending, setPending] = useState<null | Record<string, unknown>>(null)
  const schema = useMemo(
    () =>
      z.object({
        date: dateString,
        categoryId: z.string().min(1, 'Choose a category'),
        description: z.string().trim().min(1, 'Describe the expense').max(300),
        amount: moneyString(currency.minorDigits),
        paymentMethodId: z.string().min(1, 'Choose a payment method'),
        paymentReference: z.string().max(100),
        supplier: z.string().max(200),
        notes: z.string().max(2000)
      }),
    [currency.minorDigits]
  )
  type Values = z.infer<typeof schema>
  const { register, handleSubmit, formState, reset, watch } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { date: today, categoryId: '', description: '', amount: '', paymentMethodId: '', paymentReference: '', supplier: '', notes: '' }
  })
  const mutation = useApiMutation('expenses:create', { successMessage: (r) => (r.duplicateRequest ? `Already recorded as ${r.reference}` : `Expense ${r.reference} saved`) })
  const categories = lookups?.expense_categories.filter((c) => c.isActive) ?? []
  const methods = lookups?.payment_methods.filter((m) => m.isActive) ?? []
  const e = formState.errors
  const submit = handleSubmit((v) =>
    setPending({
      date: v.date,
      categoryId: Number(v.categoryId),
      description: v.description,
      amountMinor: toMinor(v.amount, currency.minorDigits),
      paymentMethodId: Number(v.paymentMethodId),
      paymentReference: v.paymentReference || null,
      supplier: v.supplier || null,
      notes: v.notes || null,
      idempotencyKey: requestKey
    })
  )
  const confirm = async () => {
    try {
      const result = await mutation.mutateAsync(pending as never)
      setPending(null)
      resetKey()
      reset({ date: watch('date'), categoryId: '', description: '', amount: '', paymentMethodId: watch('paymentMethodId'), paymentReference: '', supplier: '', notes: '' })
      onSaved?.(result)
    } catch {
      setPending(null)
    }
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Record business expense">
      <div className={compact ? 'grid gap-4' : 'grid gap-4 md:grid-cols-2'}>
        <Field label="Expense date" htmlFor="ex-date" required error={e.date?.message}>
          <Input id="ex-date" type="date" {...register('date')} />
        </Field>
        <Field label="Category" htmlFor="ex-cat" required error={e.categoryId?.message}>
          <Select id="ex-cat" aria-invalid={!!e.categoryId} {...register('categoryId')}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Description" htmlFor="ex-desc" required error={e.description?.message} className="md:col-span-2">
          <Input id="ex-desc" aria-invalid={!!e.description} {...register('description')} />
        </Field>
        <Field label="Amount" htmlFor="ex-amount" required error={e.amount?.message}>
          <MoneyInput id="ex-amount" aria-invalid={!!e.amount} {...register('amount')} />
        </Field>
        <Field label="Payment method" htmlFor="ex-method" required error={e.paymentMethodId?.message}>
          <Select id="ex-method" aria-invalid={!!e.paymentMethodId} {...register('paymentMethodId')}>
            <option value="">Choose…</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Supplier / recipient" htmlFor="ex-supplier">
          <Input id="ex-supplier" {...register('supplier')} />
        </Field>
        <Field label="Reference number" htmlFor="ex-ref">
          <Input id="ex-ref" {...register('paymentReference')} />
        </Field>
        <Field label="Notes" htmlFor="ex-notes" className="md:col-span-2">
          <Textarea id="ex-notes" rows={2} {...register('notes')} />
        </Field>
      </div>
      <p className="text-xs text-ink-muted">Business expenses never change customer balances.</p>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={mutation.isPending}>
          <Receipt /> Review expense
        </Button>
      </div>
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} title="Record business expense?" confirmLabel="Save expense" loading={mutation.isPending} onConfirm={confirm}>
        <dl className="divide-y divide-silver-100">
          <SummaryRow label="Amount">{pending ? money(pending.amountMinor as number) : '—'}</SummaryRow>
          <SummaryRow label="Date">{date(watch('date'))}</SummaryRow>
          <SummaryRow label="Category">{categories.find((c) => String(c.id) === watch('categoryId'))?.name}</SummaryRow>
          <SummaryRow label="Description">{watch('description')}</SummaryRow>
        </dl>
      </ConfirmDialog>
    </form>
  )
}
