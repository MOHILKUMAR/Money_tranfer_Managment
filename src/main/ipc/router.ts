/**
 * IPC router: every request is checked for a known channel, a trusted sender
 * and a schema-valid payload before its handler runs. Errors are converted to
 * a safe envelope; unexpected errors are logged and reported generically.
 */
import { ZodError, type ZodType } from 'zod'
import { AppError, type ApiErrorShape, type ApiResult } from '@shared/errors'
import { isIpcChannel, type IpcChannel } from '@shared/channels'

export interface RouteMeta {
  senderUrl: string
}

export interface Route {
  schema: ZodType
  handler: (input: never, meta: RouteMeta) => unknown
}

export type Routes = Partial<Record<IpcChannel, Route>>

export function route<S extends ZodType>(schema: S, handler: (input: ReturnType<S['parse']>, meta: RouteMeta) => unknown): Route {
  return { schema, handler: handler as Route['handler'] }
}

export interface RouterOptions {
  isTrustedSender: (url: string) => boolean
  onUnexpectedError?: (channel: string, error: unknown) => void
}

function fail(code: ApiErrorShape['code'], message: string, details?: unknown): ApiResult<never> {
  return { ok: false, error: { code, message, details } }
}

export function mapError(error: unknown): ApiErrorShape | null {
  if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details }
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    return {
      code: 'VALIDATION',
      message: issue ? `${issue.path.join('.') ? `${issue.path.join('.')}: ` : ''}${issue.message}` : 'Invalid input',
      details: { issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }
    }
  }
  const sqlite = error as { code?: string; message?: string }
  if (typeof sqlite?.code === 'string' && sqlite.code.startsWith('SQLITE_CONSTRAINT')) {
    const message = sqlite.message ?? ''
    if (message.includes('cannot be') || message.includes('Invalid') || message.includes('must match')) {
      return { code: 'VALIDATION', message }
    }
    return { code: 'CONFLICT', message: 'The change conflicts with existing records and was not saved.' }
  }
  return null
}

export function createRouter(routes: Routes, options: RouterOptions) {
  return {
    channels: Object.keys(routes) as IpcChannel[],
    async dispatch(channel: unknown, payload: unknown, senderUrl: string): Promise<ApiResult<unknown>> {
      if (!isIpcChannel(channel) || !routes[channel]) return fail('FORBIDDEN', 'Unknown operation')
      if (!options.isTrustedSender(senderUrl)) return fail('FORBIDDEN', 'Request from an untrusted page was rejected')
      const r = routes[channel]!
      const parsed = r.schema.safeParse(payload === undefined || payload === null ? {} : payload)
      if (!parsed.success) {
        const mapped = mapError(parsed.error)!
        return { ok: false, error: mapped }
      }
      try {
        const data = await r.handler(parsed.data as never, { senderUrl })
        return { ok: true, data: data === undefined ? null : data }
      } catch (error) {
        const mapped = mapError(error)
        if (mapped) return { ok: false, error: mapped }
        options.onUnexpectedError?.(channel, error)
        return fail('INTERNAL', 'An unexpected error occurred. No partial changes were saved. Details are in the application log.')
      }
    }
  }
}
