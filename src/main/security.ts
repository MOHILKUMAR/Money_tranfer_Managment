/**
 * Electron hardening. Kept free of runtime Electron imports so the rules can
 * be unit-tested; the Electron objects are passed in.
 */
import type { Session, WebContents, WebPreferences } from 'electron'
import { join, normalize, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const REPORT_HOST = 'reports'
export const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

/** Renderer settings for every window: isolated, sandboxed, no Node.js. */
export const SECURE_WEB_PREFERENCES: Readonly<WebPreferences> = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  spellcheck: false,
  safeDialogs: true
})

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** True only for the application's own renderer page (packaged app:// or the dev server). */
export function isTrustedRendererUrl(url: string | undefined | null, devServerUrl?: string | null): boolean {
  if (!url) return false
  const parsed = parse(url)
  if (!parsed) return false
  if (parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST) return true
  if (devServerUrl) {
    const dev = parse(devServerUrl)
    if (dev && parsed.protocol === dev.protocol && parsed.host === dev.host && ['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      return true
    }
  }
  return false
}

/**
 * Network allow-list for every request made by any renderer. The packaged app
 * makes no network requests at all; in development only the local Vite server
 * is reachable. Everything else is cancelled, so local data cannot be sent out.
 */
export function isAllowedRequestUrl(url: string, devServerUrl?: string | null): boolean {
  const parsed = parse(url)
  if (!parsed) return false
  if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST || parsed.host === REPORT_HOST
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
  if (parsed.protocol === 'devtools:' || parsed.protocol === 'chrome-devtools:') return !!devServerUrl
  if (devServerUrl) {
    const dev = parse(devServerUrl)
    if (!dev) return false
    const sameHost = parsed.host === dev.host && ['localhost', '127.0.0.1'].includes(parsed.hostname)
    if (sameHost && ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return true
  }
  return false
}

/** Navigation inside a window is limited to the app's own page. */
export function isAllowedNavigation(url: string, devServerUrl?: string | null): boolean {
  return isTrustedRendererUrl(url, devServerUrl)
}

export function hardenWebContents(contents: WebContents, devServerUrl?: string | null): void {
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url, devServerUrl)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url, devServerUrl) && !url.startsWith(`${APP_SCHEME}://${REPORT_HOST}/`)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

export function installSessionGuards(session: Session, devServerUrl?: string | null): void {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowedRequestUrl(details.url, devServerUrl) })
  })
  session.on('will-download', (event) => event.preventDefault())
}

/** Resolves a request path inside `root`, refusing anything that escapes it. */
export function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const full = normalize(join(root, relative))
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  return full.startsWith(rootWithSep) ? full : null
}
