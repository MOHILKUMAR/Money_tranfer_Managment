/**
 * Drives the built Electron app (out/) with an isolated data folder.
 * Run with: npm run test:e2e
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let userData: string

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CMM_USER_DATA_DIR: userData }
  delete env.ELECTRON_RENDERER_URL
  // CMM_E2E_EXECUTABLE runs the suite against a packaged build instead of out/.
  const executablePath = process.env.CMM_E2E_EXECUTABLE
  const app = executablePath
    ? await electron.launch({ executablePath, args: [], env })
    : await electron.launch({ args: ['.'], cwd: resolve('.'), env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 30_000 })
  return { app, page }
}

async function go(page: Page, hash: string) {
  await page.evaluate((h) => (window.location.hash = h), hash)
}

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'cmm-e2e-'))
})
test.afterAll(() => {
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  } catch {
    // Windows may hold the file briefly after the app exits; the OS temp folder is cleaned later.
  }
})

test('renderer is isolated from Node.js and the network', async () => {
  const { app, page } = await launch()
  const probe = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>
    let fetchBlocked = false
    try {
      await fetch('https://example.com/')
    } catch {
      fetchBlocked = true
    }
    const popup = window.open('https://example.com/')
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      bufferGlobal: typeof w.Buffer,
      bridgeNamespaces: Object.keys(w.cmm as object).sort(),
      bridgeIsFrozen: Object.isFrozen(w.cmm),
      fetchBlocked,
      popupOpened: popup !== null,
      origin: window.location.href
    }
  })
  expect(probe.require).toBe('undefined')
  expect(probe.process).toBe('undefined')
  expect(probe.module).toBe('undefined')
  expect(probe.bufferGlobal).toBe('undefined')
  expect(probe.bridgeNamespaces).toEqual(['analytics', 'app', 'audit', 'backup', 'customers', 'expenses', 'imports', 'ledger', 'lookups', 'reports', 'settings', 'usage'])
  expect(probe.bridgeIsFrozen).toBe(true)
  expect(probe.fetchBlocked).toBe(true)
  expect(probe.popupOpened).toBe(false)
  expect(probe.origin.startsWith('app://bundle/')).toBe(true)

  // Unknown channels / malformed payloads are refused by the main process.
  const res = await page.evaluate(async () => {
    const cmm = (window as unknown as { cmm: Record<string, Record<string, (p?: unknown) => Promise<unknown>>> }).cmm
    return cmm.customers.get({ id: 'DROP TABLE customers' })
  })
  expect(res).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })

  // First-launch empty state.
  await expect(page.getByText('Welcome to Customer Money Manager')).toBeVisible()

  // External navigation is blocked; the app stays on its own page.
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(800)
  const currentUrl = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())
  expect(currentUrl.startsWith('app://bundle/')).toBe(true)
  await app.close()
})

test('customer lifecycle: register, receive, usage, payout, ledger, persistence', async () => {
  let { app, page } = await launch()

  // Register customer with an opening credit of ₹1,000.
  await page.getByRole('button', { name: 'Quick transaction' }).click()
  await page.getByRole('menuitem', { name: /Register customer/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Register customer' })
  await dialog.getByLabel('Full name or business name').fill('E2E Traders')
  await dialog.getByLabel('Phone').fill('+91 91234 56789')
  await dialog.getByLabel('Opening position').selectOption('CREDIT')
  await dialog.getByLabel('Amount').fill('1000')
  await dialog.getByRole('button', { name: /Register customer/ }).click()
  await expect(page.getByRole('heading', { name: 'E2E Traders' })).toBeVisible()
  await expect(page.getByText('₹1,000.00').first()).toBeVisible()

  // Record ₹10,000 received.
  await page.getByRole('button', { name: 'Record receipt' }).click()
  let form = page.getByRole('dialog', { name: 'Record money received' })
  await form.getByLabel('Amount received').fill('10000')
  await form.getByLabel('Payment method').selectOption({ label: 'UPI' })
  await form.getByRole('button', { name: /Review receipt/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save receipt' }).click()
  await expect(page.getByText(/Receipt RCP-000001 saved/)).toBeVisible()

  // Two usage lines: 10 × ₹100 and a fixed ₹250 → ₹1,250.
  await page.getByRole('button', { name: 'Add usage' }).click()
  form = page.getByRole('dialog', { name: 'Add daily usage' })
  await form.locator('#lines-0-cat').selectOption({ label: 'Service' })
  await form.locator('#lines-0-desc').fill('Service A')
  await form.locator('#lines-0-qty').fill('10')
  await form.locator('#lines-0-rate').fill('100')
  await form.getByRole('button', { name: 'Add line' }).click()
  await form.locator('#lines-1-cat').selectOption({ label: 'Service' })
  await form.locator('#lines-1-desc').fill('Additional usage')
  await form.locator('#lines-1-method').selectOption('FIXED')
  await form.locator('#lines-1-fixed').fill('250')
  await form.locator('#lines-1-fixedReason').fill('Extra work')
  await expect(form.getByText('₹1,250.00')).toBeVisible()
  await form.getByRole('button', { name: 'Review usage' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Post charges' }).click()
  await expect(page.getByText(/2 usage line\(s\) saved/)).toBeVisible()

  // Pay ₹1,500 back.
  await page.getByRole('button', { name: 'Pay customer' }).click()
  form = page.getByRole('dialog', { name: 'Record money paid to customer' })
  await form.getByLabel('Amount paid').fill('1500')
  await form.getByLabel('Payment method').selectOption({ label: 'Cash' })
  await form.getByLabel('Reason for payment').fill('Return of unused advance')
  await expect(form.getByText('Balance after payout')).toBeVisible()
  await form.getByRole('button', { name: /Review payout/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Save payout' }).click()
  await expect(page.getByText(/Payout PAY-000001 saved/)).toBeVisible()

  // 1,000 + 10,000 − 1,250 − 1,500 = 8,250
  await expect(page.getByRole('heading', { name: 'E2E Traders' })).toBeVisible()
  await expect(page.getByText('₹8,250.00').first()).toBeVisible()
  const ledgerRows = page.locator('table').first().locator('tbody tr')
  await expect(ledgerRows).toHaveCount(5)
  await expect(ledgerRows.last()).toContainText('₹8,250.00')

  // Dashboard reflects the new figures.
  await go(page, '/')
  await expect(page.getByText('Registered customers')).toBeVisible()
  await app.close()

  // Restart: data is still there.
  ;({ app, page } = await launch())
  await go(page, '/customers')
  await expect(page.getByRole('heading', { name: 'Customers' })).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: 'CUST-000001' })
  await expect(row).toContainText('₹8,250.00')
  await expect(row).toContainText('Credit')
  await app.close()
})
