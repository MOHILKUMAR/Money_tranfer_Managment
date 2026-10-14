import type { ApiInput, ApiOutput } from '@shared/api'
import type { IpcChannel } from '@shared/channels'
import type { ApiErrorShape, ApiResult } from '@shared/errors'

type Bridge = Record<string, Record<string, (payload?: unknown) => Promise<unknown>>>

declare global {
  interface Window {
    cmm?: Bridge
  }
}

export class ApiError extends Error {
  readonly code: ApiErrorShape['code']
  readonly details?: unknown

  constructor(shape: ApiErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.code = shape.code
    this.details = shape.details
  }
}

/** Calls a main-process operation and unwraps the result envelope. */
export async function call<C extends IpcChannel>(channel: C, ...args: ApiInput<C> extends void ? [] : [ApiInput<C>]): Promise<ApiOutput<C>> {
  const [namespace, method] = channel.split(':')
  const fn = window.cmm?.[namespace]?.[method]
  if (!fn) throw new ApiError({ code: 'INTERNAL', message: 'The desktop bridge is not available.' })
  const result = (await fn(args[0])) as ApiResult<ApiOutput<C>>
  if (!result.ok) throw new ApiError(result.error)
  return result.data
}

export function newRequestKey(): string {
  return crypto.randomUUID()
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong'
}
