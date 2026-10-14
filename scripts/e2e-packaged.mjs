// Runs the Playwright suite against the packaged Windows build (release/<version>/win-unpacked).
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const { version, productName } = JSON.parse(readFileSync('package.json', 'utf8'))
const exe = resolve('release', version, 'win-unpacked', `${productName}.exe`)
if (!existsSync(exe)) {
  console.error(`Packaged app not found at ${exe}. Run npm run package:win first.`)
  process.exit(1)
}
const result = spawnSync('npx', ['playwright', 'test'], { stdio: 'inherit', shell: true, env: { ...process.env, CMM_E2E_EXECUTABLE: exe } })
process.exit(result.status ?? 1)
