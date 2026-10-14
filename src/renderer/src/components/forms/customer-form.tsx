import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { AlertTriangle, UserPlus } from 'lucide-react'
import type { CustomerCreateResult, CustomerDetail, PossibleDuplicate } from '@shared/types'
import { ApiError, call, errorMessage } from '@/lib/api'
import { useApiMutation, useFormat, useToday } from '@/lib/queries'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Field, Input, Select, Textarea } from '../ui/form'
import { Notice } from '../ui/layout'
import { MoneyInput } from '../domain'
import { dateString, moneyString, toMinor, useRequestKey } from './shared'

const PHONE = /^[0-9+()\-.\s]*$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function CustomerForm({ existing, onSaved, onCancel }: { existing?: CustomerDetail; onSaved?: (id: number, result?: CustomerCreateResult) => void; onCancel?: () => void }) {
  const today = useToday()
  const { currency } = useFormat()
  const queryClient = useQueryClient()
  const [requestKey, resetKey] = useRequestKey()
  const [duplicates, setDuplicates] = useState<PossibleDuplicate[] | null>(null)
  const [saving, setSaving] = useState(false)
  const isEdit = !!existing
  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, 'Name is required').max(200),
          phone: z.string().max(30).refine((v) => PHONE.test(v), 'Phone may contain digits, spaces, + ( ) - .'),
          email: z.string().max(200).refine((v) => !v || EMAIL.test(v), 'Enter a valid email address'),
          address: z.string().max(500),
          registrationDate: dateString,
          status: z.enum(['ACTIVE', 'INACTIVE']),
          notes: z.string().max(2000),
          openingDirection: z.enum(['NONE', 'CREDIT', 'DUE']),
          openingAmount: z.string(),
          openingDate: z.string(),
          openingExplanation: z.string().max(500),
          reason: z.string().max(500)
        })
        .superRefine((v, ctx) => {
          if (v.openingDirection !== 'NONE') {
            const r = moneyString(currency.minorDigits).safeParse(v.openingAmount)
            if (!r.success) ctx.addIssue({ code: 'custom', path: ['openingAmount'], message: r.error.issues[0].message })
            if (!dateString.safeParse(v.openingDate).success) ctx.addIssue({ code: 'custom', path: ['openingDate'], message: 'Enter a valid date' })
            if (!v.openingExplanation.trim()) ctx.addIssue({ code: 'custom', path: ['openingExplanation'], message: 'Explain where the opening balance comes from' })
          }
        }),
    [currency.minorDigits]
  )
  type Values = z.infer<typeof schema>
  const { register, handleSubmit, formState, watch } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: existing?.name ?? '',
      phone: existing?.phone ?? '',
      email: existing?.email ?? '',
      address: existing?.address ?? '',
      registrationDate: existing?.registrationDate ?? today,
      status: existing?.status ?? 'ACTIVE',
      notes: existing?.notes ?? '',
      openingDirection: 'NONE',
      openingAmount: '',
      openingDate: today,
      openingExplanation: 'Balance carried forward',
      reason: ''
    }
  })
  const update = useApiMutation('customers:update', { successMessage: () => 'Customer details updated' })

  const create = async (v: Values, confirmDuplicate: boolean) => {
    setSaving(true)
    try {
      const amount = v.openingDirection === 'NONE' ? 0 : toMinor(v.openingAmount, currency.minorDigits)
      const result = await call('customers:create', {
        name: v.name,
        phone: v.phone || null,
        email: v.email || null,
        address: v.address || null,
        registrationDate: v.registrationDate,
        status: v.status,
        notes: v.notes || null,
        openingBalance: v.openingDirection === 'NONE' ? null : { amountMinor: v.openingDirection === 'DUE' ? -amount : amount, date: v.openingDate, explanation: v.openingExplanation },
        idempotencyKey: requestKey,
        confirmPossibleDuplicate: confirmDuplicate
      })
      await queryClient.invalidateQueries()
      toast.success(`Customer ${result.customerCode} registered${result.openingTxnReference ? ` with opening balance ${result.openingTxnReference}` : ''}`)
      resetKey()
      setDuplicates(null)
      onSaved?.(result.id, result)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'POSSIBLE_DUPLICATE') {
        setDuplicates((error.details as { matches: PossibleDuplicate[] }).matches)
      } else {
        toast.error(errorMessage(error))
      }
    } finally {
      setSaving(false)
    }
  }

  const submit = handleSubmit(async (v) => {
    if (isEdit) {
      await update.mutateAsync({
        id: existing.id,
        name: v.name,
        phone: v.phone || null,
        email: v.email || null,
        address: v.address || null,
        registrationDate: v.registrationDate,
        notes: v.notes || null,
        reason: v.reason || null
      })
      onSaved?.(existing.id)
    } else {
      await create(v, false)
    }
  })
  const e = formState.errors
  const direction = watch('openingDirection')
  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-label={isEdit ? 'Edit customer' : 'Register customer'}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Full name or business name" htmlFor="cu-name" required error={e.name?.message} className="md:col-span-2">
          <Input id="cu-name" autoFocus aria-invalid={!!e.name} {...register('name')} />
        </Field>
        <Field label="Phone" htmlFor="cu-phone" error={e.phone?.message}>
          <Input id="cu-phone" inputMode="tel" {...register('phone')} />
        </Field>
        <Field label="Email" htmlFor="cu-email" error={e.email?.message}>
          <Input id="cu-email" type="email" {...register('email')} />
        </Field>
        <Field label="Address" htmlFor="cu-address" className="md:col-span-2" hint="Optional — only collect what you need">
          <Input id="cu-address" {...register('address')} />
        </Field>
        <Field label="Registration date" htmlFor="cu-reg" required error={e.registrationDate?.message}>
          <Input id="cu-reg" type="date" {...register('registrationDate')} />
        </Field>
        {!isEdit && (
          <Field label="Account status" htmlFor="cu-status">
            <Select id="cu-status" {...register('status')}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
          </Field>
        )}
        <Field label="Notes" htmlFor="cu-notes" className="md:col-span-2">
          <Textarea id="cu-notes" rows={2} {...register('notes')} />
        </Field>
      </div>

      {!isEdit && (
        <fieldset className="rounded-lg border border-silver-200 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Opening balance (optional)</legend>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Opening position" htmlFor="cu-open-dir">
              <Select id="cu-open-dir" {...register('openingDirection')}>
                <option value="NONE">No opening balance</option>
                <option value="CREDIT">Customer has credit with us</option>
                <option value="DUE">Customer owes us (amount due)</option>
              </Select>
            </Field>
            {direction !== 'NONE' && (
              <>
                <Field label="Amount" htmlFor="cu-open-amount" required error={e.openingAmount?.message}>
                  <MoneyInput id="cu-open-amount" aria-invalid={!!e.openingAmount} {...register('openingAmount')} />
                </Field>
                <Field label="Opening balance date" htmlFor="cu-open-date" required error={e.openingDate?.message}>
                  <Input id="cu-open-date" type="date" {...register('openingDate')} />
                </Field>
                <Field label="Explanation" htmlFor="cu-open-expl" required error={e.openingExplanation?.message}>
                  <Input id="cu-open-expl" {...register('openingExplanation')} />
                </Field>
              </>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-muted">The opening balance is recorded as its own ledger entry so the account can always be reconstructed.</p>
        </fieldset>
      )}

      {isEdit && (
        <Field label="Reason for change" htmlFor="cu-reason" hint="Recorded in the audit log">
          <Input id="cu-reason" {...register('reason')} />
        </Field>
      )}

      {duplicates && (
        <Notice tone="warning" title="Possible duplicate customer">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Existing customers match this name or phone number. Records are never merged automatically.</span>
          </p>
          <ul className="mt-2 list-disc pl-6 text-ink">
            {duplicates.map((d) => (
              <li key={d.id}>
                {d.customerCode} — {d.name}
                {d.phone ? ` (${d.phone})` : ''} · matched on {d.matchedOn.join(' & ')}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="dark" loading={saving} onClick={handleSubmit((v) => create(v, true))}>
              This is a different customer — create anyway
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDuplicates(null)}>
              Go back
            </Button>
          </div>
        </Notice>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" loading={saving || update.isPending} disabled={!!duplicates}>
          <UserPlus /> {isEdit ? 'Save changes' : 'Register customer'}
        </Button>
      </div>
    </form>
  )
}
