import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseManager, LoggerLike } from './db/manager'
import { backupFileName, writeBackup } from './services/backup'
import { readSettings, writeSetting } from './services/settings'
import { writeAudit } from './services/context'

const AUTO_PREFIX = 'auto-backup'

/**
 * Optional automatic backup on startup (at most once per ~20 hours) into the
 * configured backup folder, keeping the newest N automatic backups.
 */
export async function runAutoBackupIfDue(manager: DatabaseManager, defaultBackupDir: string, logger: LoggerLike): Promise<void> {
  const ctx = manager.ctx
  const settings = readSettings(ctx)
  if (!settings.autoBackupEnabled) return
  const last = settings.lastAutoBackupAt ? new Date(settings.lastAutoBackupAt).getTime() : 0
  const now = ctx.now()
  if (now.getTime() - last < 20 * 60 * 60 * 1000) return
  const folder = settings.backupFolder ?? defaultBackupDir
  try {
    mkdirSync(folder, { recursive: true })
    const name = backupFileName(now, false, AUTO_PREFIX)
    await writeBackup(manager.db, join(folder, name))
    ctx.db.transaction(() => {
      writeSetting(ctx, 'lastAutoBackupAt', now.toISOString())
      writeSetting(ctx, 'lastBackupAt', now.toISOString())
      writeSetting(ctx, 'lastBackupFile', name)
      writeAudit(ctx, { action: 'AUTO_BACKUP_CREATED', entityType: 'database', entityId: null, summary: name })
    })()
    const autos = readdirSync(folder)
      .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith('.sqlite'))
      .map((f) => ({ f, t: statSync(join(folder, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of autos.slice(settings.autoBackupKeep)) rmSync(join(folder, old.f), { force: true })
    logger.info('Automatic backup completed')
  } catch (error) {
    logger.error('Automatic backup failed', error)
  }
}
