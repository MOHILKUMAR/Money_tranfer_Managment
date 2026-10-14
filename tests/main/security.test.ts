import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import {
  isAllowedNavigation,
  isAllowedRequestUrl,
  isTrustedRendererUrl,
  resolveInside,
  SECURE_WEB_PREFERENCES
} from '../../src/main/security'
import { createRouter, route } from '../../src/main/ipc/router'
import { buildRoutes } from '../../src/main/ipc/routes'
import { IPC_CHANNELS } from '../../src/shared/channels'
import { buildContentSecurityPolicy } from '../../src/shared/csp'
import { redact } from '../../src/main/logger'
import { buildReport, reportToHtml } from '../../src/main/services/reports'
import { createCustomer, listCustomers } from '../../src/main/services/customers'
import { listLedger } from '../../src/main/services/ledger'
import { DatabaseManager } from '../../src/main/db/manager'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { key } from './helpers'

const DEV = 'http://localhost:5173/'

describe('renderer isolation settings', () => {
  it('uses context isolation, sandbox and no Node integration', () => {
    expect(SECURE_WEB_PREFERENCES).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
    expect(Object.isFrozen(SECURE_WEB_PREFERENCES)).toBe(true)
  })

  it('main process enables the sandbox globally and only loads app:// or the dev server', () => {
    const main = readFileSync(resolve('src/main/index.ts'), 'utf8')
    expect(main).toContain('app.enableSandbox()')
    expect(main).toContain('...SECURE_WEB_PREFERENCES')
    expect(main).not.toMatch(/nodeIntegration:\s*true/)
    expect(main).not.toMatch(/contextIsolation:\s*false/)
    expect(main).not.toMatch(/\beval\(/)
  })

  it('production CSP forbids inline/remote scripts and remote connections', () => {
    const csp = buildContentSecurityPolicy('production')
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/)
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("object-src 'none'")
  })
})

describe('preload bridge', () => {
  it('exposes only named channel functions and never Node.js or filesystem APIs', () => {
    const src = readFileSync(resolve('src/preload/index.ts'), 'utf8')
    expect(src).toContain("contextBridge.exposeInMainWorld('cmm'")
    expect(src).not.toMatch(/from 'node:|require\(|from 'fs'|ipcRenderer\.send\b|ipcRenderer\.on\b/)
    expect(src).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\)/)
    const built = (() => {
      try {
        return readFileSync(resolve('out/preload/index.js'), 'utf8')
      } catch {
        return null
      }
    })()
    if (built) {
      const requires = [...built.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
      expect(requires).toEqual(['electron'])
    }
  })

  it('every channel is unique and namespaced', () => {
    expect(new Set(IPC_CHANNELS).size).toBe(IPC_CHANNELS.length)
    for (const c of IPC_CHANNELS) expect(c).toMatch(/^[a-z]+:[a-zA-Z]+$/)
  })
})

describe('navigation, network and file guards', () => {
  it('trusts only the packaged app origin and the local dev server', () => {
    expect(isTrustedRendererUrl('app://bundle/index.html')).toBe(true)
    expect(isTrustedRendererUrl('app://bundle/index.html#/customers')).toBe(true)
    expect(isTrustedRendererUrl('app://reports/abc')).toBe(false)
    expect(isTrustedRendererUrl('https://evil.example/index.html')).toBe(false)
    expect(isTrustedRendererUrl('file:///C:/Windows/system32')).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5173/', DEV)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/', null)).toBe(false)
    expect(isTrustedRendererUrl('http://evil.localhost.example:5173/', DEV)).toBe(false)
    expect(isTrustedRendererUrl('', DEV)).toBe(false)
  })

  it('blocks all outbound network requests in production', () => {
    for (const url of ['https://example.com/', 'http://127.0.0.1:8080/', 'wss://socket.example', 'ftp://x', 'https://api.anthropic.com']) {
      expect(isAllowedRequestUrl(url)).toBe(false)
    }
    expect(isAllowedRequestUrl('app://bundle/assets/index.js')).toBe(true)
    expect(isAllowedRequestUrl('app://reports/123')).toBe(true)
    expect(isAllowedRequestUrl('app://other/x')).toBe(false)
    expect(isAllowedRequestUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isAllowedRequestUrl('http://localhost:5173/src/main.tsx', DEV)).toBe(true)
    expect(isAllowedRequestUrl('https://cdn.example.com/lib.js', DEV)).toBe(false)
  })

  it('external navigation is refused', () => {
    expect(isAllowedNavigation('https://phishing.example/login')).toBe(false)
    expect(isAllowedNavigation('app://bundle/index.html')).toBe(true)
  })

  it('protocol handler cannot escape the renderer folder', () => {
    const root = resolve('out/renderer')
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'))
    expect(resolveInside(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'))
    // Never resolves outside the root: either clamped inside it or refused.
    for (const evil of ['/../package.json', '/assets/../../main/index.js', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/secret', '/..%5c..%5cpackage.json', '/a%00b', '/%E0%A4%A']) {
      const resolved = resolveInside(root, evil)
      expect(resolved === null || resolved.startsWith(root + sep)).toBe(true)
    }
    for (const evil of ['..%2f..%2fpackage.json', '..\\..\\secret', '/a%00b', '/%E0%A4%A']) {
      expect(resolveInside(root, evil)).toBeNull()
    }
  })
})

describe('IPC router validation', () => {
  const routes = {
    'customers:get': route(z.strictObject({ id: z.number().int().positive() }), (input) => ({ echoed: input.id })),
    'app:info': route(z.strictObject({}).optional(), () => {
      throw new Error('boom with secret path C:\\Users\\someone')
    })
  }
  const errors: unknown[] = []
  const router = createRouter(routes, { isTrustedSender: (u) => isTrustedRendererUrl(u), onUnexpectedError: (_c, e) => errors.push(e) })
  const trusted = 'app://bundle/index.html'

  it('rejects unknown channels and untrusted senders', async () => {
    expect(await router.dispatch('fs:readFile', { path: 'C:/secret' }, trusted)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await router.dispatch('customers:get', { id: 1 }, 'https://evil.example')).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('validates payload shapes, types and unknown keys', async () => {
    expect(await router.dispatch('customers:get', { id: 1 }, trusted)).toEqual({ ok: true, data: { echoed: 1 } })
    for (const bad of [{ id: '1' }, { id: -1 }, { id: 1.5 }, { id: 1, extra: true }, 'string', [1], { id: { $gt: 0 } }]) {
      expect(await router.dispatch('customers:get', bad, trusted)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    }
  })

  it('hides unexpected error details from the renderer', async () => {
    const res = await router.dispatch('app:info', undefined, trusted)
    expect(res).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
    expect(JSON.stringify(res)).not.toContain('secret path')
    expect(errors).toHaveLength(1)
  })
})

describe('real IPC routes with injected dialogs', () => {
  let dir: string
  let manager: DatabaseManager
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmm-ipc-'))
    manager = new DatabaseManager({ dataDir: join(dir, 'data'), dbPath: join(dir, 'data', 'db.sqlite'), backupDir: join(dir, 'backups'), workDir: join(dir, 'tmp') })
    manager.open()
  })
  afterEach(() => {
    manager.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeRouter(saveTo: string | null, openFrom: string | null = null) {
    const routes = buildRoutes({
      manager,
      logger: { info() {}, warn() {}, error() {} },
      appMeta: () => ({ appVersion: 'test', demoMode: false, platform: 'test', isPackaged: false, dataFolder: join(dir, 'data') }),
      defaultBackupDir: join(dir, 'backups'),
      defaultExportDir: () => dir,
      dialogs: { saveFile: async () => saveTo, openFile: async () => openFrom, openDirectory: async () => null },
      revealPath: () => {},
      printHtml: async () => {}
    })
    return createRouter(routes, { isTrustedSender: (u) => isTrustedRendererUrl(u) })
  }

  it('registers a handler for every declared channel', () => {
    const routes = buildRoutes({
      manager,
      logger: { info() {}, warn() {}, error() {} },
      appMeta: () => ({ appVersion: 't', demoMode: false, platform: 't', isPackaged: false, dataFolder: dir }),
      defaultBackupDir: dir,
      defaultExportDir: () => dir,
      dialogs: { saveFile: async () => null, openFile: async () => null, openDirectory: async () => null },
      revealPath: () => {},
      printHtml: async () => {}
    })
    expect(Object.keys(routes).sort()).toEqual([...IPC_CHANNELS].sort())
  })

  it('renderer cannot pass file paths: export paths come only from the native dialog', async () => {
    const router = makeRouter(join(dir, 'export.csv'))
    const withPath = await router.dispatch('reports:exportCsv', { kind: 'customer_directory', path: 'C:/Windows/evil.csv' }, 'app://bundle/index.html')
    expect(withPath).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    const ok = await router.dispatch('reports:exportCsv', { kind: 'customer_directory' }, 'app://bundle/index.html')
    expect(ok).toMatchObject({ ok: true, data: { saved: true, fileName: 'export.csv' } })
    const cancelled = await makeRouter(null).dispatch('reports:exportCsv', { kind: 'customer_directory' }, 'app://bundle/index.html')
    expect(cancelled).toMatchObject({ ok: true, data: { saved: false } })
  })

  it('uses parameterized queries: SQL injection text is treated as data', async () => {
    const router = makeRouter(null)
    const evil = "x'); DROP TABLE customers; --"
    const created = await router.dispatch('customers:create', { name: evil, registrationDate: '2026-10-01', idempotencyKey: key() }, 'app://bundle/index.html')
    expect(created.ok).toBe(true)
    const search = await router.dispatch('customers:list', { search: "' OR 1=1 --" }, 'app://bundle/index.html')
    expect(search).toMatchObject({ ok: true, data: { total: 0 } })
    const percent = await router.dispatch('customers:list', { search: '%' }, 'app://bundle/index.html')
    expect(percent).toMatchObject({ ok: true, data: { total: 0 } })
    expect(listCustomers(manager.ctx).rows[0].name).toBe(evil)
    expect(listLedger(manager.ctx).total).toBe(0)
  })

  it('malicious CSV content is never executed: imported as inert text', async () => {
    const csvPath = join(dir, 'evil.csv')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(csvPath, 'Name,Notes\n"=cmd|\' /C calc\'!A0","<script>alert(1)</script>"\n"@SUM(1+1)*cmd|\'/C calc\'!A0",<img src=x onerror=alert(1)>\n')
    const router = makeRouter(join(dir, 'out.html'), csvPath)
    const opened = (await router.dispatch('imports:open', { kind: 'CUSTOMERS' }, 'app://bundle/index.html')) as { ok: true; data: { sessionId: string; suggestedMapping: Record<string, number | null> } }
    expect(opened.ok).toBe(true)
    const commit = await router.dispatch(
      'imports:commit',
      { sessionId: opened.data.sessionId, mapping: opened.data.suggestedMapping, confirmFinancial: true, skipInvalidRows: false, importPossibleDuplicates: false },
      'app://bundle/index.html'
    )
    expect(commit).toMatchObject({ ok: true, data: { importedRows: 2 } })
    const html = reportToHtml(buildReport(manager.ctx, { kind: 'customer_directory' }), { currency: { code: 'INR', locale: 'en-IN', minorDigits: 2 }, dateFormat: 'dd MMM yyyy', businessName: '<b>x</b>' })
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain("default-src 'none'")
    const csvOut = join(dir, 'roundtrip.csv')
    await makeRouter(csvOut).dispatch('reports:exportCsv', { kind: 'customer_directory' }, 'app://bundle/index.html')
    const exported = readFileSync(csvOut, 'utf8')
    expect(exported).toContain(`,'=cmd|' /C calc'!A0,`)
    expect(exported).not.toMatch(/,=cmd/)
    expect(exported).toContain(`'@SUM(1+1)`)
  })

  it('backup and restore flow through IPC: validate before replace, confirmation required', async () => {
    createCustomer(manager.ctx, { name: 'Keep Me', registrationDate: '2026-10-01', idempotencyKey: key() })
    const backupPath = join(dir, 'b.sqlite')
    const router = makeRouter(backupPath, backupPath)
    const created = await router.dispatch('backup:create', { destination: 'CHOOSE', encrypt: false }, 'app://bundle/index.html')
    expect(created).toMatchObject({ ok: true, data: { saved: true, integrity: 'ok' } })
    createCustomer(manager.ctx, { name: 'Added Later', registrationDate: '2026-10-01', idempotencyKey: key() })
    const picked = (await router.dispatch('backup:pickRestore', {}, 'app://bundle/index.html')) as { ok: true; data: { token: string; valid: boolean } }
    expect(picked.data.valid).toBe(true)
    const noConfirm = await router.dispatch('backup:confirmRestore', { token: picked.data.token, confirmText: 'yes' }, 'app://bundle/index.html')
    expect(noConfirm).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    expect(listCustomers(manager.ctx).total).toBe(2)
    const restored = await router.dispatch('backup:confirmRestore', { token: picked.data.token, confirmText: 'RESTORE' }, 'app://bundle/index.html')
    expect(restored).toMatchObject({ ok: true, data: { restored: true, integrity: 'ok' } })
    expect(listCustomers(manager.ctx).rows.map((c) => c.name)).toEqual(['Keep Me'])
    expect(readdirSync(join(dir, 'backups')).some((f) => f.startsWith('pre-restore'))).toBe(true)
  })
})

describe('log redaction', () => {
  it('removes emails, phone numbers, amounts and secrets', () => {
    const line = redact('user anil@example.com phone +91 98765 43210 paid ₹1,250.50 passphrase=hunter22 token: abc123')
    expect(line).not.toContain('anil@example.com')
    expect(line).not.toContain('98765')
    expect(line).not.toContain('1,250.50')
    expect(line).not.toContain('hunter22')
    expect(line).not.toContain('abc123')
  })
})
