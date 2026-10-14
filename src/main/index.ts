import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { join } from 'node:path'
import { DatabaseManager } from './db/manager'
import { FileLogger } from './logger'
import {
  APP_ENTRY_URL,
  hardenWebContents,
  installSessionGuards,
  isTrustedRendererUrl,
  SECURE_WEB_PREFERENCES
} from './security'
import { handleAppProtocol, registerPrivilegedScheme, releaseReportPage, storeReportPage } from './protocol'
import { createRouter } from './ipc/router'
import { buildRoutes } from './ipc/routes'
import { runAutoBackupIfDue } from './maintenance'
import { runIntegrityCheck } from './services/integrity'
import { seedDemoData } from './demo/seed'
import { IPC_CHANNELS } from '@shared/channels'

const isDemo = process.argv.includes('--demo')
const isCheckDb = process.argv.includes('--check-db')
const devServerUrl = !app.isPackaged ? (process.env.ELECTRON_RENDERER_URL ?? null) : null

// Separate data folders: development and demo never touch the production database.
if (process.env.CMM_USER_DATA_DIR) {
  app.setPath('userData', process.env.CMM_USER_DATA_DIR)
} else if (!app.isPackaged) {
  app.setPath('userData', `${app.getPath('userData')} (Development)`)
}

registerPrivilegedScheme()
app.enableSandbox()

const userData = app.getPath('userData')
const dataDir = join(userData, isDemo ? 'demo' : 'data')
const logger = new FileLogger(join(userData, 'logs'))
const manager = new DatabaseManager(
  {
    dataDir,
    dbPath: join(dataDir, isDemo ? 'customer-money-manager-demo.sqlite' : 'customer-money-manager.sqlite'),
    backupDir: join(userData, 'backups'),
    workDir: join(userData, 'tmp')
  },
  logger
)

let mainWindow: BrowserWindow | null = null

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#f4f4f5',
    title: isDemo ? 'Customer Money Manager — DEMO' : 'Customer Money Manager',
    autoHideMenuBar: true,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: join(__dirname, '../preload/index.js'),
      devTools: !app.isPackaged
    }
  })
  win.once('ready-to-show', () => win.show())
  if (devServerUrl) void win.loadURL(devServerUrl)
  else void win.loadURL(APP_ENTRY_URL)
  return win
}

async function printHtml(html: string, title: string): Promise<void> {
  const url = storeReportPage(html)
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title,
    parent: mainWindow ?? undefined,
    autoHideMenuBar: true,
    webPreferences: { ...SECURE_WEB_PREFERENCES, javascript: false, devTools: false }
  })
  win.on('closed', () => releaseReportPage(url))
  await win.loadURL(url)
  win.webContents.print({ printBackground: true }, (success, reason) => {
    if (!success && reason !== 'cancelled') logger.warn(`Print failed: ${reason}`)
  })
}

function registerIpc(): void {
  const routes = buildRoutes({
    manager,
    logger,
    appMeta: () => ({
      appVersion: app.getVersion(),
      demoMode: isDemo,
      platform: process.platform,
      isPackaged: app.isPackaged,
      dataFolder: dataDir
    }),
    defaultBackupDir: join(userData, 'backups'),
    defaultExportDir: () => app.getPath('documents'),
    dialogs: {
      async saveFile(options) {
        const result = mainWindow
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options)
        return result.canceled || !result.filePath ? null : result.filePath
      },
      async openFile(options) {
        const props: Electron.OpenDialogOptions = { ...options, properties: ['openFile'] }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, props) : await dialog.showOpenDialog(props)
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
      },
      async openDirectory(options) {
        const props: Electron.OpenDialogOptions = { ...options, properties: ['openDirectory', 'createDirectory'] }
        const result = mainWindow ? await dialog.showOpenDialog(mainWindow, props) : await dialog.showOpenDialog(props)
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
      }
    },
    revealPath: (path) => shell.showItemInFolder(path),
    printHtml
  })
  const router = createRouter(routes, {
    isTrustedSender: (url) => isTrustedRendererUrl(url, devServerUrl),
    onUnexpectedError: (channel, error) => logger.error(`IPC ${channel} failed`, error)
  })
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, payload) => router.dispatch(channel, payload, event.senderFrame?.url ?? ''))
  }
}

async function runCheckDbAndExit(): Promise<void> {
  try {
    if (!manager.databaseExists()) {
      process.stderr.write(`No database found at ${manager.paths.dbPath}\n`)
      app.exit(1)
      return
    }
    manager.open()
    const report = runIntegrityCheck(manager.ctx)
    process.stdout.write(`${JSON.stringify({ database: manager.paths.dbPath, ...report }, null, 2)}\n`)
    manager.close()
    app.exit(report.ok ? 0 : 1)
  } catch (error) {
    process.stderr.write(`Database check failed: ${(error as Error).message}\n`)
    app.exit(2)
  }
}

if (!isCheckDb && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents, devServerUrl))

  app.whenReady().then(async () => {
    if (isCheckDb) return runCheckDbAndExit()
    logger.info(`Starting Customer Money Manager ${app.getVersion()}${isDemo ? ' (demo)' : ''}`)
    installSessionGuards(session.defaultSession, devServerUrl)
    handleAppProtocol(join(__dirname, '../renderer'))
    if (app.isPackaged) Menu.setApplicationMenu(null)
    try {
      manager.open()
      if (isDemo) seedDemoData(manager.ctx)
    } catch (error) {
      logger.error('Database could not be opened', error)
      dialog.showErrorBox(
        'Customer Money Manager could not open its database',
        `${(error as Error).message}\n\nYour data has not been changed. Database location:\n${manager.paths.dbPath}\n\nIf the problem continues, restore from a backup or contact support.`
      )
      app.exit(1)
      return
    }
    registerIpc()
    mainWindow = createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    void runAutoBackupIfDue(manager, join(userData, 'backups'), logger)
  })

  app.on('window-all-closed', () => {
    manager.close()
    app.quit()
  })

  app.on('before-quit', () => {
    if (manager.isOpen) manager.close()
  })

  process.on('uncaughtException', (error) => logger.error('Uncaught exception', error))
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', reason))
}
