import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export function Table({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('scrollbar-thin w-full overflow-auto', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="sticky top-0 z-[1] bg-silver-100/95 backdrop-blur">{children}</thead>
}

export function Th({ className, align, ...props }: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      className={cn(
        'whitespace-nowrap border-b border-silver-200 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className
      )}
      {...props}
    />
  )
}

export function SortTh({ label, active, dir, onClick, align }: { label: string; active: boolean; dir: 'asc' | 'desc'; onClick: () => void; align?: 'left' | 'right' }) {
  return (
    <Th align={align} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={onClick} className={cn('inline-flex cursor-pointer items-center gap-1 uppercase hover:text-ink', active && 'text-ink')}>
        {label}
        {active && (dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
      </button>
    </Th>
  )
}

export function Tr({ className, onClick, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn('border-b border-silver-100 last:border-0', onClick && 'cursor-pointer hover:bg-silver-100/60', className)}
      onClick={onClick}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter') onClick(e as never)
            }
          : undefined
      }
      {...props}
    />
  )
}

export function Td({ className, align, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return <td className={cn('px-3 py-2 align-middle text-ink', align === 'right' && 'text-right tabular whitespace-nowrap', align === 'center' && 'text-center', className)} {...props} />
}

export function Pagination({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1
  const end = Math.min(total, page * pageSize)
  return (
    <div className="flex items-center justify-between gap-3 border-t border-silver-100 px-3 py-2 text-xs text-ink-muted">
      <span>
        {start}–{end} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft />
        </Button>
        <span className="px-1">
          Page {page} of {pages}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onPageChange(page + 1)}>
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
