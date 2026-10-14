import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const fieldBase =
  'w-full rounded-md border border-silver bg-white px-3 text-sm text-ink placeholder:text-ink-faint shadow-xs transition-colors focus:border-charcoal focus:outline-none focus:ring-2 focus:ring-charcoal/15 disabled:cursor-not-allowed disabled:bg-silver-100 aria-[invalid=true]:border-due aria-[invalid=true]:ring-due/15'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(fieldBase, 'h-9', className)} {...props} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(fieldBase, 'min-h-[72px] py-2', className)} {...props} />
))
Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(fieldBase, 'h-9 pr-8', className)} {...props}>
    {children}
  </select>
))
Select.displayName = 'Select'

export function Label({ htmlFor, children, required, className }: { htmlFor?: string; children: ReactNode; required?: boolean; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-muted', className)}>
      {children}
      {required && <span className="ml-0.5 text-racing" aria-hidden>*</span>}
    </label>
  )
}

export function FieldError({ message, id }: { message?: string | null; id?: string }) {
  if (!message) return null
  return (
    <p id={id} role="alert" className="mt-1 text-xs font-medium text-due">
      {message}
    </p>
  )
}

export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
  className
}: {
  label: string
  htmlFor: string
  required?: boolean
  error?: string | null
  hint?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {error ? <FieldError message={error} id={`${htmlFor}-error`} /> : hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
    </div>
  )
}

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }>(
  ({ label, className, id, ...props }, ref) => (
    <label htmlFor={id} className={cn('flex cursor-pointer items-start gap-2 text-sm text-ink', className)}>
      <input ref={ref} id={id} type="checkbox" className="mt-0.5 size-4 cursor-pointer accent-racing" {...props} />
      <span>{label}</span>
    </label>
  )
)
Checkbox.displayName = 'Checkbox'
