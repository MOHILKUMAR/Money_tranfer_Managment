import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, DatabaseBackup, FolderOpen, HardDrive, Lock, RotateCcw, ShieldCheck, Stethoscope } from 'lucide-react'
import { toast } from 'sonner'
import type { BackupInspection, IntegrityReport, RestoreResult } from '@shared/types'
import { call, errorMessage } from '@/lib/api'
import { useApi, useApiMutation, useAppInfo, useFormat, useSettings } from '@/lib/queries'
import { formatBytes, formatDateTime } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader } from '@/components/ui/layout'
import { Checkbox, Field, Input } from '@/components/ui/form'
import { Dialog } from '@/components/ui/overlay'
import { Table, THead, Th, Tr, Td } from '@/components/ui/table'

export function Backup() {
  const queryClient = useQueryClient()
  const { data: info } = useAppInfo()
  const { data: settings } = useSettings()
  const { data: status } = useApi('backup:status')
  const { date } = useFormat()
  const [encrypt, setEncrypt] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [passphrase2, setPassphrase2] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [integrity, setIntegrity] = useState<IntegrityReport | null>(null)
  const [restore, setRestore] = useState<BackupInspection | null>(null)
  const [restorePass, setRestorePass] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null)
  const updateSettings = useApiMutation('settings:update', { successMessage: () => 'Backup settings saved' })

  const passError = encrypt && (passphrase.length < 8 ? 'Use at least 8 characters' : passphrase !== passphrase2 ? 'Passphrases do not match' : null)

  const backup = async (destination: 'CHOOSE' | 'FOLDER') => {
    if (passError) {
      toast.error(passError)
      return
    }
    setBusy(destination)
    try {
      const r = await call('backup:create', { destination, encrypt, passphrase: encrypt ? passphrase : null })
      if (r.saved) {
        toast.success(`Backup saved and verified: ${r.fileName} (${formatBytes(r.sizeBytes)}, integrity ${r.integrity})`)
        setPassphrase('')
        setPassphrase2('')
        await queryClient.invalidateQueries()
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const chooseFolder = async () => {
    try {
      await call('backup:chooseFolder')
      await queryClient.invalidateQueries()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }
  const check = async () => {
    setBusy('check')
    try {
      setIntegrity(await call('app:integrityCheck'))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const pickRestore = async () => {
    setBusy('pick')
    try {
      const r = await call('backup:pickRestore')
      if (r) {
        setRestore(r)
        setRestorePass('')
        setConfirmText('')
        setRestoreResult(null)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const unlock = async () => {
    if (!restore) return
    setBusy('unlock')
    try {
      setRestore(await call('backup:inspectRestore', { token: restore.token, passphrase: restorePass }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const doRestore = async () => {
    if (!restore) return
    setBusy('restore')
    try {
      const r = await call('backup:confirmRestore', { token: restore.token, passphrase: restorePass || null, confirmText: 'RESTORE' })
      setRestoreResult(r)
      queryClient.clear()
      await queryClient.invalidateQueries()
      toast.success('Restore completed and verified')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader title="Backup / Restore" icon={DatabaseBackup} description="User-controlled local backups. Nothing is uploaded anywhere." />

      <Card>
        <CardHeader title="Where your data is stored" />
        <CardBody className="grid gap-4 text-sm md:grid-cols-2">
          <div className="space-y-2">
            <p className="flex items-center gap-2 font-medium">
              <HardDrive className="size-4" aria-hidden /> Database file
            </p>
            <p className="break-all rounded bg-silver-100 px-2 py-1 font-mono text-xs">{info?.databasePath}</p>
            <Button size="sm" variant="outline" onClick={() => call('app:revealDataFolder')}>
              <FolderOpen /> Show in folder
            </Button>
          </div>
          <div className="space-y-2 text-ink-muted">
            <p>
              <strong className="text-ink">Encryption:</strong> the live database is a standard SQLite file and is <strong className="text-ink">not encrypted</strong> by this app. It is protected by your Windows user account permissions. Use
              BitLocker device encryption for at-rest protection, and choose encrypted backups below for copies stored elsewhere.
            </p>
            <p>Keep at least one backup on a separate storage device (USB drive or external disk). No paid cloud storage is required.</p>
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Create a backup" description="A consistent snapshot is taken while the app is open, then re-opened and integrity-checked before it is reported as saved" />
          <CardBody className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-ink-muted">Last backup</p>
                <p className="font-semibold">{status?.lastBackupAt ? formatDateTime(status.lastBackupAt) : 'Never'}</p>
                {status?.lastBackupFile && <p className="truncate text-xs text-ink-muted">{status.lastBackupFile}</p>}
              </div>
              <div>
                <p className="text-xs text-ink-muted">Backup folder</p>
                <p className="break-all text-xs">{status?.backupFolder}</p>
                <Button size="sm" variant="link" onClick={chooseFolder}>
                  Change folder…
                </Button>
              </div>
            </div>
            <Checkbox id="bk-encrypt" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} label="Encrypt this backup with a passphrase (AES-256-GCM)" />
            {encrypt && (
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Passphrase" htmlFor="bk-pass" error={passphrase && passError === 'Use at least 8 characters' ? passError : null}>
                  <Input id="bk-pass" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                </Field>
                <Field label="Repeat passphrase" htmlFor="bk-pass2" error={passphrase2 && passError === 'Passphrases do not match' ? passError : null}>
                  <Input id="bk-pass2" type="password" autoComplete="new-password" value={passphrase2} onChange={(e) => setPassphrase2(e.target.value)} />
                </Field>
                <Notice tone="warning" className="md:col-span-2">
                  The passphrase is never stored. If it is lost, the encrypted backup cannot be restored.
                </Notice>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={busy === 'FOLDER'} onClick={() => backup('FOLDER')}>
                {encrypt ? <Lock /> : <DatabaseBackup />} Back up to folder
              </Button>
              <Button variant="outline" loading={busy === 'CHOOSE'} onClick={() => backup('CHOOSE')}>
                Save backup as…
              </Button>
            </div>
            <Checkbox
              id="bk-auto"
              checked={settings?.autoBackupEnabled ?? false}
              onChange={(e) => updateSettings.mutate({ autoBackupEnabled: e.target.checked })}
              label={`Automatically back up to the backup folder when the app starts (at most daily, keeps the newest ${settings?.autoBackupKeep ?? 14})`}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Restore from a backup" description="Replaces ALL current data with the backup. Records are never mixed." />
          <CardBody className="space-y-3 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-ink-muted">
              <li>Choose a backup file (.sqlite or encrypted .cmmbak).</li>
              <li>The file is validated (integrity, format, version) without touching your data.</li>
              <li>A safety backup of your current data is created automatically.</li>
              <li>The database is replaced and verified. If anything fails, your current data is put back.</li>
            </ol>
            <Button variant="dark" loading={busy === 'pick'} onClick={pickRestore}>
              <RotateCcw /> Choose backup to restore…
            </Button>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Database integrity"
          description="SQLite integrity check plus ledger reconciliation (usage postings, reversals, refunds, balance rule cross-check)"
          actions={
            <Button size="sm" variant="outline" loading={busy === 'check'} onClick={check}>
              <Stethoscope /> Run check
            </Button>
          }
        />
        {integrity && (
          <CardBody>
            <Notice tone={integrity.ok ? 'success' : 'danger'} title={integrity.ok ? 'All checks passed' : 'Problems found'}>
              <p>
                SQLite: {integrity.sqliteIntegrity} · foreign key violations: {integrity.foreignKeyViolations} · {integrity.counts.customers} customers, {integrity.counts.transactions} ledger entries,{' '}
                {integrity.counts.usageEntries} usage entries, {integrity.counts.expenses} expenses, {integrity.counts.auditEntries} audit entries · checked {formatDateTime(integrity.checkedAt)}
              </p>
              {integrity.problems.length > 0 && (
                <ul className="mt-2 list-disc pl-5">
                  {integrity.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </Notice>
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent backups in the backup folder" />
        <Table>
          <THead>
            <tr>
              <Th>File</Th>
              <Th align="right">Size</Th>
              <Th>Modified</Th>
              <Th>Type</Th>
            </tr>
          </THead>
          <tbody>
            {(status?.recentBackups ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-ink-muted">
                  No backups found in this folder yet.
                </td>
              </tr>
            )}
            {status?.recentBackups.map((b) => (
              <Tr key={b.fileName}>
                <Td className="font-mono text-xs">{b.fileName}</Td>
                <Td align="right">{formatBytes(b.sizeBytes)}</Td>
                <Td>{formatDateTime(b.modifiedAt)}</Td>
                <Td>{b.fileName.endsWith('.cmmbak') ? <Badge tone="dark">Encrypted</Badge> : b.fileName.startsWith('pre-') ? <Badge tone="warning">Safety</Badge> : <Badge>SQLite</Badge>}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Dialog open={!!restore} onOpenChange={(o) => !o && busy !== 'restore' && setRestore(null)} title="Restore backup" description={restore?.fileName} size="md">
        {restore && !restoreResult && (
          <div className="space-y-4 text-sm">
            {restore.needsPassphrase ? (
              <div className="space-y-3">
                <p>This backup is encrypted. Enter its passphrase to validate it.</p>
                <Field label="Passphrase" htmlFor="rs-pass">
                  <Input id="rs-pass" type="password" autoFocus value={restorePass} onChange={(e) => setRestorePass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && unlock()} />
                </Field>
                <Button variant="dark" loading={busy === 'unlock'} onClick={unlock} disabled={!restorePass}>
                  Unlock and validate
                </Button>
              </div>
            ) : restore.valid ? (
              <>
                <Notice tone="success" title="Backup is valid">
                  Integrity OK · schema version {restore.schemaVersion} · {formatBytes(restore.sizeBytes)}
                  {restore.encrypted ? ' · encrypted' : ''}
                </Notice>
                {restore.counts && (
                  <p>
                    Contains {restore.counts.customers} customers, {restore.counts.transactions} ledger entries, {restore.counts.usageEntries} usage entries and {restore.counts.expenses} expenses
                    {restore.lastTransactionDate ? `; latest transaction dated ${date(restore.lastTransactionDate)}` : ''}.
                  </p>
                )}
                <Notice tone="danger" title="This replaces all current data">
                  <p className="flex gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                    Everything recorded since this backup was made will be removed from the live database. A safety backup of the current data is saved first so it can be recovered.
                  </p>
                </Notice>
                <Field label='Type "RESTORE" to confirm' htmlFor="rs-confirm">
                  <Input id="rs-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
                </Field>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setRestore(null)} disabled={busy === 'restore'}>
                    Cancel
                  </Button>
                  <Button variant="danger" disabled={confirmText !== 'RESTORE'} loading={busy === 'restore'} onClick={doRestore}>
                    <RotateCcw /> Restore now
                  </Button>
                </div>
              </>
            ) : (
              <Notice tone="danger" title="This file cannot be restored">
                <ul className="list-disc pl-5">
                  {restore.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p className="mt-2">Your current data has not been changed.</p>
              </Notice>
            )}
          </div>
        )}
        {restoreResult && (
          <div className="space-y-3 text-sm">
            <Notice tone="success" title="Restore completed">
              <p className="flex items-center gap-2">
                <CheckCircle2 className="size-4" aria-hidden /> Database integrity: {restoreResult.integrity}
              </p>
              <p className="mt-1">
                Restored {restoreResult.counts.customers} customers, {restoreResult.counts.transactions} ledger entries, {restoreResult.counts.usageEntries} usage entries and {restoreResult.counts.expenses} expenses.
              </p>
            </Notice>
            <p className="flex items-center gap-2 text-ink-muted">
              <ShieldCheck className="size-4" aria-hidden /> Your previous data was saved as <span className="font-mono text-xs">{restoreResult.safetyBackupFile}</span> in the backups folder.
            </p>
            <div className="flex justify-end">
              <Button variant="dark" onClick={() => setRestore(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  )
}
