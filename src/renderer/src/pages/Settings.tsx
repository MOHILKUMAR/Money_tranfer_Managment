import { useEffect, useState } from 'react'
import { Lock, Plus, Settings as SettingsIcon, ShieldCheck } from 'lucide-react'
import { CATEGORY_APPLIES_TO, type CategoryAppliesTo, type LookupKind } from '@shared/schemas'
import { DATE_FORMAT_OPTIONS, formatIsoDate, type DateFormatOption } from '@shared/dates'
import { formatMoney } from '@shared/money'
import { useApi, useApiMutation, useAppInfo, useLookups, useSettings } from '@/lib/queries'
import { formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader, Spinner } from '@/components/ui/layout'
import { Field, Input, Select } from '@/components/ui/form'
import { TabPanel, Tabs } from '@/components/ui/overlay'
import { Pagination, Table, THead, Th, Tr, Td } from '@/components/ui/table'

const CURRENCIES = [
  { code: 'INR', locale: 'en-IN', minorDigits: 2, label: 'Indian rupee (₹)' },
  { code: 'USD', locale: 'en-US', minorDigits: 2, label: 'US dollar ($)' },
  { code: 'EUR', locale: 'en-IE', minorDigits: 2, label: 'Euro (€)' },
  { code: 'GBP', locale: 'en-GB', minorDigits: 2, label: 'Pound sterling (£)' },
  { code: 'AED', locale: 'en-AE', minorDigits: 2, label: 'UAE dirham' },
  { code: 'JPY', locale: 'ja-JP', minorDigits: 0, label: 'Japanese yen (¥)' }
]

function General() {
  const { data: settings } = useSettings()
  const update = useApiMutation('settings:update', { successMessage: () => 'Settings saved' })
  const [businessName, setBusinessName] = useState('')
  const [operatorName, setOperatorName] = useState('')
  useEffect(() => {
    if (settings) {
      setBusinessName(settings.businessName)
      setOperatorName(settings.operatorName)
    }
  }, [settings])
  if (!settings) return <Spinner />
  const currentCurrency = CURRENCIES.find((c) => c.code === settings.currency.code)
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Business & operator" />
        <CardBody className="space-y-4">
          <Field label="Business name" htmlFor="st-business" hint="Printed on reports">
            <div className="flex gap-2">
              <Input id="st-business" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
              <Button variant="dark" onClick={() => update.mutate({ businessName })} loading={update.isPending}>
                Save
              </Button>
            </div>
          </Field>
          <Field label="Operator name" htmlFor="st-operator" hint="Recorded as “entered by” on new records and in the audit log">
            <div className="flex gap-2">
              <Input id="st-operator" value={operatorName} onChange={(e) => setOperatorName(e.target.value)} />
              <Button variant="dark" onClick={() => update.mutate({ operatorName })} loading={update.isPending}>
                Save
              </Button>
            </div>
          </Field>
          <Notice tone="info">
            Single-user mode: the operator name is a label, not a login. Anyone who can use this Windows account can use the app, so it does not provide per-user accountability. Use separate Windows accounts if
            several people share the computer.
          </Notice>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Currency & dates" />
        <CardBody className="space-y-4">
          <Field label="Currency" htmlFor="st-currency" hint={settings.currencyLocked ? 'Locked because transactions exist — changing it would alter the meaning of saved amounts.' : 'Amounts are stored in minor units of this currency'}>
            <div className="flex items-center gap-2">
              <Select
                id="st-currency"
                value={settings.currency.code}
                disabled={settings.currencyLocked}
                onChange={(e) => {
                  const c = CURRENCIES.find((x) => x.code === e.target.value)
                  if (c) update.mutate({ currency: { code: c.code, locale: c.locale, minorDigits: c.minorDigits } })
                }}
              >
                {!currentCurrency && <option value={settings.currency.code}>{settings.currency.code}</option>}
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </Select>
              {settings.currencyLocked && <Lock className="size-4 text-ink-muted" aria-label="Locked" />}
            </div>
          </Field>
          <p className="text-sm text-ink-muted">Example: {formatMoney(125050, settings.currency)}</p>
          <Field label="Date display format" htmlFor="st-datefmt">
            <Select id="st-datefmt" value={settings.dateFormat} onChange={(e) => update.mutate({ dateFormat: e.target.value as DateFormatOption })}>
              {DATE_FORMAT_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {formatIsoDate('2026-10-15', f)} ({f})
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Financial rules" />
        <CardBody className="space-y-4 text-sm">
          <Field label="Payouts that exceed available credit" htmlFor="st-overdraft">
            <Select id="st-overdraft" value={settings.payoutOverdraftPolicy} onChange={(e) => update.mutate({ payoutOverdraftPolicy: e.target.value as 'BLOCK' | 'REQUIRE_OVERRIDE' })}>
              <option value="REQUIRE_OVERRIDE">Allow only with an authorised override and reason</option>
              <option value="BLOCK">Never allow (block the payout)</option>
            </Select>
          </Field>
          <div className="rounded-md border border-silver-200 bg-silver-100/50 p-3">
            <p className="font-semibold">
              Balance convention <Badge tone="dark">{settings.balanceConvention}</Badge>
            </p>
            <p className="mt-1 font-mono text-xs leading-relaxed text-ink-muted">
              Balance = Opening + Received − Paid to customer − Usage charges + Credit adjustments − Debit adjustments
            </p>
            <p className="mt-1 text-xs text-ink-muted">Positive = customer credit · zero = settled · negative = customer owes the business.</p>
          </div>
        </CardBody>
      </Card>
      <PrivacyCard />
    </div>
  )
}

function PrivacyCard() {
  const { data: info } = useAppInfo()
  return (
    <Card>
      <CardHeader title="Privacy & local data" />
      <CardBody className="space-y-2 text-sm text-ink-muted">
        <p className="flex items-center gap-2 text-ink">
          <ShieldCheck className="size-4" aria-hidden /> Works fully offline. No telemetry. Nothing is uploaded.
        </p>
        <p>Database: <span className="break-all font-mono text-xs text-ink">{info?.databasePath}</span></p>
        <p>The application blocks all network requests from its windows. Backups and exports are written only where you choose.</p>
        <p>
          App version {info?.appVersion} · schema {info?.schemaVersion} · {info?.isPackaged ? 'installed build' : 'development build'}
          {info?.demoMode ? ' · demo database' : ''}
        </p>
      </CardBody>
    </Card>
  )
}

const LOOKUP_LABELS: Record<LookupKind, string> = {
  payment_methods: 'Payment methods',
  transaction_categories: 'Receipt / payout / adjustment categories',
  usage_categories: 'Usage categories',
  usage_units: 'Usage units',
  expense_categories: 'Expense categories'
}

function LookupEditor({ kind }: { kind: LookupKind }) {
  const { data: lookups } = useLookups()
  const create = useApiMutation('lookups:create', { successMessage: (l) => `Added "${l.name}"` })
  const update = useApiMutation('lookups:update', { successMessage: (l) => `Updated "${l.name}"` })
  const [name, setName] = useState('')
  const [appliesTo, setAppliesTo] = useState<CategoryAppliesTo>('ANY')
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null)
  const items = lookups?.[kind] ?? []
  return (
    <Card>
      <CardHeader title={LOOKUP_LABELS[kind]} description="Inactive options stay on historical records but can't be chosen for new entries" />
      <CardBody className="space-y-3">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            create.mutate({ kind, name: name.trim(), appliesTo: kind === 'transaction_categories' ? appliesTo : null }, { onSuccess: () => setName('') })
          }}
        >
          <Input aria-label={`New ${LOOKUP_LABELS[kind]}`} placeholder="New option name" className="w-64" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          {kind === 'transaction_categories' && (
            <Select aria-label="Applies to" className="w-40" value={appliesTo} onChange={(e) => setAppliesTo(e.target.value as CategoryAppliesTo)}>
              {CATEGORY_APPLIES_TO.map((a) => (
                <option key={a} value={a}>
                  {a.toLowerCase()}
                </option>
              ))}
            </Select>
          )}
          <Button type="submit" variant="dark" loading={create.isPending} disabled={!name.trim()}>
            <Plus /> Add
          </Button>
        </form>
        <ul className="divide-y divide-silver-100 rounded-md border border-silver-200">
          {items.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              {editing?.id === item.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    update.mutate({ kind, id: item.id, name: editing.name }, { onSuccess: () => setEditing(null) })
                  }}
                >
                  <Input aria-label="Rename" value={editing.name} onChange={(e) => setEditing({ id: item.id, name: e.target.value })} autoFocus maxLength={60} />
                  <Button type="submit" size="sm" variant="dark">
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className={item.isActive ? '' : 'text-ink-faint line-through'}>
                    {item.name}
                    {item.appliesTo && kind === 'transaction_categories' && <Badge className="ml-2">{item.appliesTo.toLowerCase()}</Badge>}
                  </span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ id: item.id, name: item.name })}>
                      Rename
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => update.mutate({ kind, id: item.id, isActive: !item.isActive })}>
                      {item.isActive ? 'Deactivate' : 'Activate'}
                    </Button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function AuditLog() {
  const [page, setPage] = useState(1)
  const { data } = useApi('audit:list', { page, pageSize: 50 }, { placeholderData: (p) => p })
  return (
    <Card>
      <CardHeader title="Audit log" description="Append-only record of changes, corrections, imports, backups and restores" />
      <Table className="max-h-[600px]">
        <THead>
          <tr>
            <Th>When</Th>
            <Th>Action</Th>
            <Th>Entity</Th>
            <Th>Summary</Th>
            <Th>Reason</Th>
            <Th>By</Th>
          </tr>
        </THead>
        <tbody>
          {data?.rows.map((a) => (
            <Tr key={a.id}>
              <Td className="whitespace-nowrap text-xs">{formatDateTime(a.occurredAt)}</Td>
              <Td className="text-xs font-medium">{a.action.replace(/_/g, ' ').toLowerCase()}</Td>
              <Td className="text-xs text-ink-muted">
                {a.entityType}
                {a.entityId ? ` #${a.entityId}` : ''}
              </Td>
              <Td className="max-w-md text-xs">{a.summary}</Td>
              <Td className="max-w-xs text-xs">{a.reason}</Td>
              <Td className="text-xs">{a.actor ?? '—'}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {data && <Pagination page={page} pageSize={50} total={data.total} onPageChange={setPage} />}
    </Card>
  )
}

export function Settings() {
  const [tab, setTab] = useState('general')
  return (
    <div>
      <PageHeader title="Settings" icon={SettingsIcon} description="Currency, date format, rules, configurable lists and the audit log" />
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'general', label: 'General' },
          { value: 'lists', label: 'Methods & categories' },
          { value: 'audit', label: 'Audit log' }
        ]}
      >
        <TabPanel value="general">
          <General />
        </TabPanel>
        <TabPanel value="lists">
          <div className="grid gap-4 xl:grid-cols-2">
            {(Object.keys(LOOKUP_LABELS) as LookupKind[]).map((k) => (
              <LookupEditor key={k} kind={k} />
            ))}
          </div>
        </TabPanel>
        <TabPanel value="audit">
          <AuditLog />
        </TabPanel>
      </Tabs>
    </div>
  )
}
