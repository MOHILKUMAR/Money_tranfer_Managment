/**
 * Preload (sandboxed, context-isolated). Exposes one function per allowed IPC
 * channel under `window.cmm` — no generic invoke, no Node.js, no file access.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/channels'

type Invoker = (payload?: unknown) => Promise<unknown>
const api: Record<string, Record<string, Invoker>> = {}

for (const channel of IPC_CHANNELS) {
  const [namespace, method] = channel.split(':')
  api[namespace] ??= {}
  api[namespace][method] = (payload?: unknown) => ipcRenderer.invoke(channel, payload)
}

for (const namespace of Object.values(api)) Object.freeze(namespace)
contextBridge.exposeInMainWorld('cmm', Object.freeze(api))
