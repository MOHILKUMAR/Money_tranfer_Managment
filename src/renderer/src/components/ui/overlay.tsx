import type { ReactNode } from 'react'
import { Dialog as D, AlertDialog as AD, Tooltip as T, Tabs as Tb, DropdownMenu as DM, Popover as P } from 'radix-ui'
import { Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const widths = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-charcoal/50 backdrop-blur-[1px]" />
        <D.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-silver-200 bg-white shadow-2xl focus:outline-none',
            widths[size]
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-silver-100 px-5 py-4">
            <div>
              <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-sm text-ink-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{title}</D.Description>
              )}
            </div>
            <D.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </D.Close>
          </div>
          <div className="scrollbar-thin overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-silver-100 bg-silver-100/40 px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel = 'Confirm',
  onConfirm,
  loading,
  tone = 'primary'
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  loading?: boolean
  tone?: 'primary' | 'dark' | 'danger'
}) {
  return (
    <AD.Root open={open} onOpenChange={onOpenChange}>
      <AD.Portal>
        <AD.Overlay className="fixed inset-0 z-40 bg-charcoal/50" />
        <AD.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-silver-200 bg-white p-5 shadow-2xl">
          <AD.Title className="text-base font-semibold text-ink">{title}</AD.Title>
          <AD.Description asChild>
            <div className="mt-2 text-sm text-ink-muted">{children}</div>
          </AD.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AD.Cancel asChild>
              <Button variant="outline" disabled={loading}>
                Cancel
              </Button>
            </AD.Cancel>
            <Button
              variant={tone === 'danger' ? 'danger' : tone}
              loading={loading}
              onClick={(e) => {
                e.preventDefault()
                onConfirm()
              }}
              autoFocus
            >
              {confirmLabel}
            </Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  )
}

export const TooltipProvider = T.Provider

export function Tip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <T.Root delayDuration={200}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md bg-charcoal px-3 py-2 text-xs leading-relaxed text-white shadow-lg">
          {content}
          <T.Arrow className="fill-charcoal" />
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}

export function InfoTip({ content, label = 'More information' }: { content: ReactNode; label?: string }) {
  return (
    <Tip content={content}>
      <button type="button" aria-label={label} className="inline-flex cursor-help text-ink-faint hover:text-ink">
        <Info className="size-3.5" aria-hidden />
      </button>
    </Tip>
  )
}

export function Tabs({ value, onValueChange, tabs, children, className }: { value: string; onValueChange: (v: string) => void; tabs: Array<{ value: string; label: ReactNode }>; children: ReactNode; className?: string }) {
  return (
    <Tb.Root value={value} onValueChange={onValueChange} className={className}>
      <Tb.List className="mb-4 inline-flex gap-1 rounded-lg border border-silver-200 bg-white p-1">
        {tabs.map((t) => (
          <Tb.Trigger
            key={t.value}
            value={t.value}
            className="cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink data-[state=active]:bg-charcoal data-[state=active]:text-white"
          >
            {t.label}
          </Tb.Trigger>
        ))}
      </Tb.List>
      {children}
    </Tb.Root>
  )
}
export const TabPanel = Tb.Content

export const Menu = DM.Root
export const MenuTrigger = DM.Trigger
export function MenuContent({ children, align = 'end' }: { children: ReactNode; align?: 'start' | 'end' | 'center' }) {
  return (
    <DM.Portal>
      <DM.Content align={align} sideOffset={6} className="z-50 min-w-52 rounded-md border border-silver-200 bg-white p-1 shadow-xl">
        {children}
      </DM.Content>
    </DM.Portal>
  )
}
export function MenuItem({ children, onSelect, shortcut }: { children: ReactNode; onSelect: () => void; shortcut?: string }) {
  return (
    <DM.Item
      onSelect={onSelect}
      className="flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-ink outline-none data-[highlighted]:bg-silver-100 [&_svg]:size-4 [&_svg]:text-ink-muted"
    >
      {children}
      {shortcut && <span className="ml-auto pl-4 text-xs text-ink-faint">{shortcut}</span>}
    </DM.Item>
  )
}
export const MenuSeparator = () => <DM.Separator className="my-1 h-px bg-silver-200" />

export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverAnchor = P.Anchor
export function PopoverContent({ children, className, align = 'start' }: { children: ReactNode; className?: string; align?: 'start' | 'end' | 'center' }) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn('z-50 rounded-md border border-silver-200 bg-white p-1 shadow-xl', className)}
      >
        {children}
      </P.Content>
    </P.Portal>
  )
}
