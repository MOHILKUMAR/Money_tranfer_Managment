// Runs the database integrity and ledger reconciliation check against a data folder
// using the built app (out/). Usage:
//   npm run db:check                 → production data folder of the installed app
//   npm run db:check -- --dev        → development data folder
//   npm run db:check -- --data <dir> → any data folder (the folder that contains data/)
//   add --demo to check the separate demo database instead
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import electronPath from 'electron'

const APP_NAME = 'Customer Money Manager'
const args = process.argv.slice(2)

function defaultUserData() {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), APP_NAME)
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAME)
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_NAME)
}

let userData = defaultUserData()
const dataIndex = args.indexOf('--data')
if (dataIndex >= 0 && args[dataIndex + 1]) userData = resolve(args[dataIndex + 1])
else if (args.includes('--dev')) userData = `${userData} (Development)`

const demo = args.includes('--demo')
const folder = join(userData, demo ? 'demo' : 'data')
if (!existsSync(folder)) {
  console.error(`No database folder found at ${folder}`)
  process.exit(1)
}
if (!existsSync(resolve('out/main/index.js'))) {
  console.error('Build the app first: npm run build')
  process.exit(1)
}
const env = { ...process.env, CMM_USER_DATA_DIR: userData }
delete env.ELECTRON_RENDERER_URL
const result = spawnSync(electronPath, ['.', '--check-db', ...(demo ? ['--demo'] : [])], { stdio: 'inherit', env })
process.exit(result.status ?? 1)
