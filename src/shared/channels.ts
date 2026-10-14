/**
 * The complete list of IPC channels. The preload script exposes exactly these
 * as named functions; the main process registers a validated handler for each.
 */
export const IPC_CHANNELS = [
  'app:info',
  'app:notifications',
  'app:revealDataFolder',
  'app:integrityCheck',
  'settings:get',
  'settings:update',
  'lookups:list',
  'lookups:create',
  'lookups:update',
  'customers:list',
  'customers:get',
  'customers:create',
  'customers:update',
  'customers:setStatus',
  'customers:checkDuplicates',
  'customers:search',
  'customers:analytics',
  'ledger:list',
  'ledger:get',
  'ledger:recordReceipt',
  'ledger:recordPayout',
  'ledger:previewPayout',
  'ledger:recordAdjustment',
  'ledger:reverse',
  'ledger:updateNotes',
  'usage:list',
  'usage:recordBatch',
  'usage:correct',
  'usage:summary',
  'expenses:list',
  'expenses:create',
  'expenses:reverse',
  'expenses:summary',
  'analytics:dashboard',
  'reports:preview',
  'reports:exportCsv',
  'reports:saveHtml',
  'reports:print',
  'imports:open',
  'imports:validate',
  'imports:commit',
  'imports:cancel',
  'imports:history',
  'backup:status',
  'backup:create',
  'backup:chooseFolder',
  'backup:pickRestore',
  'backup:inspectRestore',
  'backup:confirmRestore',
  'audit:list'
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (IPC_CHANNELS as readonly string[]).includes(value)
}
