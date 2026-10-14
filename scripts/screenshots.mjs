// Launches the built app with an isolated data folder and captures each screen.
// Usage: node scripts/screenshots.mjs <userDataDir> <outDir> [--demo]
import { _electron as electron } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [userData, outDir, flag] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const env = { ...process.env, CMM_USER_DATA_DIR: resolve(userData) }
delete env.ELECTRON_RENDERER_URL
const app = await electron.launch({ args: ['.', ...(flag ? [flag] : [])], cwd: resolve('.'), env })
const page = await app.firstWindow()
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()))
page.on('pageerror', (e) => console.log('page error:', e.message))
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForSelector('text=Dashboard', { timeout: 30000 })
const routes = ['/', '/customers', '/usage', '/received', '/paid', '/expenses', '/transactions', '/analytics', '/csv', '/backup', '/settings']
for (const route of routes) {
  await page.evaluate((r) => (globalThis.location.hash = r), route)
  await page.waitForTimeout(1200)
  const name = route === '/' ? 'dashboard' : route.slice(1)
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: false })
  console.log('captured', name)
}
await app.close()
