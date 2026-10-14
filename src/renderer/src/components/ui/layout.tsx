import type { HTMLAttributes, ReactNode } from 'react'
import { Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-silver-200 bg-surface shadow-xs', className)} {...props} />
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-silver-100 px-4 py-3', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />
}

export function PageHeader({ title, description, actions, icon: Icon }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="flex size-10 items-center justify-center rounded-lg bg-charcoal text-white">
            <Icon className="size-5" aria-hidden />
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
          {description && <p className="text-sm text-ink-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

const badgeTones = {
  neutral: 'bg-silver-100 text-ink-muted border-silver-200',
  dark: 'bg-charcoal text-white border-charcoal',
  credit: 'bg-credit-50 text-credit border-credit/20',
  due: 'bg-due-50 text-due border-due/20',
  warning: 'bg-warning-50 text-warning border-warning/20',
  red: 'bg-racing-50 text-racing border-racing/20'
}

export function Badge({ tone = 'neutral', className, children }: { tone?: keyof typeof badgeTones; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold', badgeTones[tone], className)}>
      {children}
    </span>
  )
}

export function Spinner({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex items-center justify-center gap-2 py-10 text-sm text-ink-muted', className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-silver-100', className)} />
}

export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: LucideIcon; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-silver-100 text-ink-muted">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong'
  return (
    <div role="alert" className="m-4 rounded-md border border-due/30 bg-due-50 p-4 text-sm text-due">
      <p className="font-semibold">Could not load this data</p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <button type="button" className="mt-2 text-sm font-semibold underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children: ReactNode; className?: string }) {
  const tones = {
    info: 'border-silver bg-silver-100 text-ink',
    warning: 'border-warning/30 bg-warning-50 text-warning',
    danger: 'border-due/30 bg-due-50 text-due',
    success: 'border-credit/30 bg-credit-50 text-credit'
  }
  return (
    <div className={cn('rounded-md border px-3 py-2.5 text-sm', tones[tone], className)}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={title ? 'mt-0.5' : ''}>{children}</div>
    </div>
  )
}
