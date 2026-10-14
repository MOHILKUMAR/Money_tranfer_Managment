/**
 * The privileged `app://` scheme. `app://bundle/...` serves the built renderer
 * from the application directory (with path-traversal protection and a strict
 * CSP header); `app://reports/<id>` serves generated, script-free report pages
 * from memory.
 */
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildContentSecurityPolicy, REPORT_CSP } from '@shared/csp'
import { APP_HOST, APP_SCHEME, REPORT_HOST, resolveInside } from './security'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}

const reportPages = new Map<string, string>()

export function registerPrivilegedScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

export function storeReportPage(html: string): string {
  const id = randomUUID()
  reportPages.set(id, html)
  if (reportPages.size > 20) reportPages.delete(reportPages.keys().next().value!)
  return `${APP_SCHEME}://${REPORT_HOST}/${id}`
}

export function releaseReportPage(url: string): void {
  reportPages.delete(url.split('/').pop() ?? '')
}

export function handleAppProtocol(rendererRoot: string): void {
  const csp = buildContentSecurityPolicy('production')
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host === REPORT_HOST) {
      const html = reportPages.get(url.pathname.replace(/^\//, ''))
      if (!html) return new Response('Report expired', { status: 404 })
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': REPORT_CSP, 'x-content-type-options': 'nosniff' }
      })
    }
    if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = resolveInside(rendererRoot, pathname)
    if (!filePath) return new Response('Forbidden', { status: 403 })
    try {
      const body = await readFile(filePath)
      return new Response(body, {
        headers: {
          'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
          'cross-origin-opener-policy': 'same-origin'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
