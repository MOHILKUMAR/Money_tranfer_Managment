import { useMemo, useState } from 'react'
import { Controller, useFieldArray, useForm, type UseFormRegister, type UseFormWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Calculator, Copy, Plus, Trash2 } from 'lucide-react'
import { parseMoney, parseQuantity } from '@shared/money'
import { computeUsageCharge } from '@shared/usage'
import type { UsageLineInput } from '@shared/schemas'
import type { UsageBatchResult } from '@shared/types'
import { useApi, useApiMutation, useFormat, useLookups, useToday } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Field, Input, Select } from '../ui/form'
import { ConfirmDialog } from '../ui/overlay'
import { Notice } from '../ui/layout'
import { CustomerPicker, MoneyInput, MoneyText } from '../domain'
import { dateString, toMinor, useRequestKey } from './shared'

export interface UsageLineValues {
  categoryId: string
  description: string
  method: 'QUANTITY' | 'FIXED'
  quantity: string
  unitId: string
  rate: string
  fixedAmount: string
  fixedReason: string
  fees: string
  discount: string
  discountReason: string
  notes: string
}

export const emptyLine = (categoryId = ''): UsageLineValues => ({
  categoryId,
  description: '',
  method: 'QUANTITY',
  quantity: '',
  unitId: '',
  rate: '',
  fixedAmount: '',
  fixedReason: '',
  fees: '',
  discount: '',
  discountReason: '',
  notes: ''
})

function lineSchema(minorDigits: number) {
  const money = (v: string, opts: { allowZero?: boolean } = {}) => parseMoney(v, { minorDigits, ...opts })
  return z
    .object({
      categoryId: z.string().min(1, 'Choose a category'),
      description: z.string().trim().min(1, 'Describe the item or service').max(300),
      method: z.enum(['QUANTITY', 'FIXED']),
      quantity: z.string(),
      unitId: z.string(),
      rate: z.string(),
      fixedAmount: z.string(),
      fixedReason: z.string().max(300),
      fees: z.string(),
      discount: z.string(),
      discountReason: z.string().max(300),
      notes: z.string().max(1000)
    })
    .superRefine((line, rawCtx) => {
      let hasIssue = false
      const ctx = { addIssue: (issue: { code: 'custom'; path: string[]; message: string }) => { hasIssue = true; rawCtx.addIssue(issue) } }
      if (line.method === 'QUANTITY') {
        const q = parseQuantity(line.quantity)
        if (!q.ok) ctx.addIssue({ code: 'custom', path: ['quantity'], message: q.error })
        const r = money(line.rate, { allowZero: true })
        if (!r.ok) ctx.addIssue({ code: 'custom', path: ['rate'], message: r.error === 'Enter an amount' ? 'Enter a rate' : r.error })
      } else {
        const f = money(line.fixedAmount)
        if (!f.ok) ctx.addIssue({ code: 'custom', path: ['fixedAmount'], message: f.error })
        if (!line.fixedReason.trim()) ctx.addIssue({ code: 'custom', path: ['fixedReason'], message: 'Give a reason for the fixed charge' })
      }
      for (const key of ['fees', 'discount'] as const) {
        if (line[key].trim()) {
          const m = money(line[key], { allowZero: true })
          if (!m.ok) ctx.addIssue({ code: 'custom', path: [key], message: m.error })
        }
      }
      const discount = line.discount.trim() ? money(line.discount, { allowZero: true }) : { ok: true as const, value: 0 }
      if (discount.ok && discount.value > 0 && !line.discountReason.trim()) {
        ctx.addIssue({ code: 'custom', path: ['discountReason'], message: 'A discount needs an authorisation note' })
      }
      const charge = lineCharge(line, minorDigits)
      if (charge.error && !hasIssue) ctx.addIssue({ code: 'custom', path: ['discount'], message: charge.error })
    })
}

export function lineCharge(line: UsageLineValues, minorDigits: number): { charge: number | null; base: number | null; error: string | null } {
  const m = (v: string) => (v.trim() ? parseMoney(v, { minorDigits, allowZero: true }) : ({ ok: true, value: 0 } as const))
  const fees = m(line.fees)
  const discount = m(line.discount)
  if (!fees.ok || !discount.ok) return { charge: null, base: null, error: null }
  let result
  if (line.method === 'QUANTITY') {
    const q = parseQuantity(line.quantity)
    const r = parseMoney(line.rate, { minorDigits, allowZero: true })
    if (!q.ok || !r.ok) return { charge: null, base: null, error: null }
    result = computeUsageCharge({ method: 'QUANTITY', quantityMilli: q.value, rateMinor: r.value, feesMinor: fees.value, discountMinor: discount.value })
  } else {
    const f = parseMoney(line.fixedAmount, { minorDigits })
    if (!f.ok) return { charge: null, base: null, error: null }
    result = computeUsageCharge({ method: 'FIXED', fixedAmountMinor: f.value, feesMinor: fees.value, discountMinor: discount.value })
  }
  return result.ok ? { charge: result.value.chargeMinor, base: result.value.baseAmountMinor, error: null } : { charge: null, base: null, error: result.error }
}

export function toLinePayload(line: UsageLineValues, minorDigits: number): UsageLineInput {
  const quantity = parseQuantity(line.quantity)
  return {
    categoryId: Number(line.categoryId),
    description: line.description.trim(),
    method: line.method,
    quantityMilli: line.method === 'QUANTITY' && quantity.ok ? quantity.value : null,
    unitId: line.unitId ? Number(line.unitId) : null,
    rateMinor: line.method === 'QUANTITY' ? toMinor(line.rate, minorDigits, { allowZero: true }) : null,
    fixedAmountMinor: line.method === 'FIXED' ? toMinor(line.fixedAmount, minorDigits) : null,
    fixedReason: line.method === 'FIXED' ? line.fixedReason.trim() : null,
    feesMinor: toMinor(line.fees, minorDigits, { allowZero: true }),
    discountMinor: toMinor(line.discount, minorDigits, { allowZero: true }),
    discountReason: line.discountReason.trim() || null,
    notes: line.notes.trim() || null
  }
}

/** Editor for one usage line; shared by the batch form and the correction dialog. */
export function UsageLineEditor({
  prefix,
  index,
  register,
  watch,
  errors,
  onRemove,
  onDuplicate
}: {
  prefix: string
  index: number
  // The editor is embedded in forms of different shapes under a dynamic field prefix.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: UseFormRegister<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  watch: UseFormWatch<any>
  errors?: Partial<Record<keyof UsageLineValues, { message?: string }>>
  onRemove?: () => void
  onDuplicate?: () => void
}) {
  const { data: lookups } = useLookups()
  const { currency } = useFormat()
  const line = watch(prefix) as UsageLineValues
  const { charge, base, error } = lineCharge(line, currency.minorDigits)
  const id = (k: string) => `${prefix.replace(/\./g, '-')}-${k}`
  const categories = lookups?.usage_categories.filter((c) => c.isActive) ?? []
  const units = lookups?.usage_units.filter((u) => u.isActive) ?? []
  return (
    <div className="rounded-lg border border-silver-200 bg-white p-3">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Line {index + 1}</span>
        <div className="flex items-center gap-3">
          <span className="text-sm">
            Charge: {charge !== null ? <MoneyText minor={charge} className="font-semibold" /> : <span className="text-ink-faint">—</span>}
          </span>
          {onDuplicate && (
            <Button size="icon-sm" variant="ghost" aria-label={`Duplicate line ${index + 1}`} onClick={onDuplicate}>
              <Copy />
            </Button>
          )}
          {onRemove && (
            <Button size="icon-sm" variant="ghost" aria-label={`Remove line ${index + 1}`} onClick={onRemove}>
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-12 gap-3">
        <Field label="Category" htmlFor={id('cat')} required error={errors?.categoryId?.message} className="col-span-3">
          <Select id={id('cat')} {...register(`${prefix}.categoryId`)}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Item / service" htmlFor={id('desc')} required error={errors?.description?.message} className="col-span-6">
          <Input id={id('desc')} aria-invalid={!!errors?.description} {...register(`${prefix}.description`)} />
        </Field>
        <Field label="Method" htmlFor={id('method')} className="col-span-3">
          <Select id={id('method')} {...register(`${prefix}.method`)}>
            <option value="QUANTITY">Quantity × rate</option>
            <option value="FIXED">Fixed amount</option>
          </Select>
        </Field>
        {line.method === 'QUANTITY' ? (
          <>
            <Field label="Quantity" htmlFor={id('qty')} required error={errors?.quantity?.message} className="col-span-2">
              <Input id={id('qty')} inputMode="decimal" className="text-right tabular" aria-invalid={!!errors?.quantity} {...register(`${prefix}.quantity`)} />
            </Field>
            <Field label="Unit" htmlFor={id('unit')} className="col-span-2">
              <Select id={id('unit')} {...register(`${prefix}.unitId`)}>
                <option value="">—</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Rate per unit" htmlFor={id('rate')} required error={errors?.rate?.message} className="col-span-2">
              <MoneyInput id={id('rate')} aria-invalid={!!errors?.rate} {...register(`${prefix}.rate`)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Fixed amount" htmlFor={id('fixed')} required error={errors?.fixedAmount?.message} className="col-span-2">
              <MoneyInput id={id('fixed')} aria-invalid={!!errors?.fixedAmount} {...register(`${prefix}.fixedAmount`)} />
            </Field>
            <Field label="Reason for fixed charge" htmlFor={id('fixedReason')} required error={errors?.fixedReason?.message} className="col-span-4">
              <Input id={id('fixedReason')} aria-invalid={!!errors?.fixedReason} {...register(`${prefix}.fixedReason`)} />
            </Field>
          </>
        )}
        <Field label="Additional fees" htmlFor={id('fees')} error={errors?.fees?.message} className="col-span-2">
          <MoneyInput id={id('fees')} {...register(`${prefix}.fees`)} />
        </Field>
        <Field label="Discount" htmlFor={id('discount')} error={errors?.discount?.message ?? error} className="col-span-2">
          <MoneyInput id={id('discount')} {...register(`${prefix}.discount`)} />
        </Field>
        <Field label="Discount authorised by / reason" htmlFor={id('discountReason')} error={errors?.discountReason?.message} className="col-span-6">
          <Input id={id('discountReason')} placeholder="Required when a discount is given" {...register(`${prefix}.discountReason`)} />
        </Field>
        <Field label="Notes" htmlFor={id('notes')} className="col-span-6">
          <Input id={id('notes')} {...register(`${prefix}.notes`)} />
        </Field>
      </div>
      {line.method === 'QUANTITY' && base !== null && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
          <Calculator className="size-3.5" aria-hidden /> {line.quantity} × rate = <MoneyText minor={base} /> (rounded half away from zero to the nearest minor unit)
        </p>
      )}
    </div>
  )
}

export function UsageBatchForm({ defaultCustomerId, onSaved }: { defaultCustomerId?: number | null; onSaved?: (r: UsageBatchResult) => void }) {
  const today = useToday()
  const { currency, money, date } = useFormat()
  const { data: lookups } = useLookups()
  const [requestKey, resetKey] = useRequestKey()
  const [pending, setPending] = useState<null | { customerId: number; usageDate: string; lines: UsageLineInput[]; idempotencyKey: string }>(null)
  const defaultCategory = lookups?.usage_categories.find((c) => c.isActive)?.id
  const schema = useMemo(
    () =>
      z.object({
        customerId: z.number({ message: 'Select a customer' }).int().positive('Select a customer'),
        usageDate: dateString,
        lines: z.array(lineSchema(currency.minorDigits)).min(1).max(100)
      }),
    [currency.minorDigits]
  )
  type Values = z.infer<typeof schema>
  const { register, handleSubmit, control, formState, reset, watch, getValues } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { customerId: defaultCustomerId ?? (undefined as unknown as number), usageDate: today, lines: [emptyLine(defaultCategory ? String(defaultCategory) : '')] }
  })
  const { fields, append, remove, insert } = useFieldArray({ control, name: 'lines' })
  const customerId = watch('customerId')
  const { data: customer } = useApi('customers:get', { id: customerId ?? 0 }, { enabled: !!customerId })
  const lines = watch('lines')
  const total = lines.reduce((sum, l) => sum + (lineCharge(l, currency.minorDigits).charge ?? 0), 0)
  const mutation = useApiMutation('usage:recordBatch', {
    successMessage: (r) => (r.duplicateRequest ? 'These usage lines were already saved' : `${r.entries.length} usage line(s) saved (${r.entries.map((e) => e.reference).join(', ')})`)
  })
  const submit = handleSubmit((v) =>
    setPending({ customerId: v.customerId, usageDate: v.usageDate, lines: v.lines.map((l) => toLinePayload(l, currency.minorDigits)), idempotencyKey: requestKey })
  )
  const confirm = async () => {
    if (!pending) return
    try {
      const result = await mutation.mutateAsync(pending)
      setPending(null)
      resetKey()
      reset({ customerId: defaultCustomerId ?? (undefined as unknown as number), usageDate: getValues('usageDate'), lines: [emptyLine(defaultCategory ? String(defaultCategory) : '')] })
      onSaved?.(result)
    } catch {
      setPending(null)
    }
  }
  const e = formState.errors
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label="Add daily usage">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Customer" htmlFor="us-customer" required error={e.customerId?.message} className="md:col-span-2">
          <Controller control={control} name="customerId" render={({ field }) => <CustomerPicker id="us-customer" includeInactive={false} value={field.value ?? null} onChange={(id) => field.onChange(id ?? undefined)} invalid={!!e.customerId} />} />
        </Field>
        <Field label="Usage date" htmlFor="us-date" required error={e.usageDate?.message}>
          <Input id="us-date" type="date" {...register('usageDate')} />
        </Field>
      </div>
      <div className="space-y-3">
        {fields.map((f, index) => (
          <UsageLineEditor
            key={f.id}
            prefix={`lines.${index}`}
            index={index}
            register={register}
            watch={watch}
            errors={e.lines?.[index] as never}
            onRemove={fields.length > 1 ? () => remove(index) : undefined}
            onDuplicate={() => insert(index + 1, { ...getValues(`lines.${index}`) })}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-charcoal bg-charcoal px-4 py-3 text-white">
        <Button variant="subtle" size="sm" onClick={() => append(emptyLine(defaultCategory ? String(defaultCategory) : ''))} disabled={fields.length >= 100}>
          <Plus /> Add line
        </Button>
        <div className="flex items-center gap-4">
          <span className="text-sm text-silver">
            {fields.length} line(s) · Total for {date(watch('usageDate'))}
          </span>
          <span className="text-lg font-semibold tabular">{money(total)}</span>
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Review usage
          </Button>
        </div>
      </div>
      {customer?.status === 'INACTIVE' && <Notice tone="warning">This customer is inactive. Reactivate the account before adding usage.</Notice>}
      <ConfirmDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)} title="Post usage charges?" confirmLabel="Post charges" loading={mutation.isPending} onConfirm={confirm}>
        <p>
          {pending?.lines.length} line(s) totalling <strong className="text-ink">{money(total)}</strong> will be charged to {customer?.name ?? 'the customer'} for {date(pending?.usageDate)}.
        </p>
        {customer && (
          <p className={cn('mt-2')}>
            Balance after posting: <MoneyText minor={customer.balanceMinor - total} tone="balance" className="font-semibold" />
          </p>
        )}
      </ConfirmDialog>
    </form>
  )
}
