export const ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'POSSIBLE_DUPLICATE',
  'INSUFFICIENT_CREDIT',
  'OVERRIDE_REQUIRED',
  'REFUND_EXCEEDS_RECEIPT',
  'ALREADY_REVERSED',
  'CONFLICT',
  'FORBIDDEN',
  'CANCELLED',
  'CURRENCY_LOCKED',
  'IMPORT_HAS_ERRORS',
  'BACKUP_INVALID',
  'DB_ERROR',
  'INTERNAL'
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ApiErrorShape {
  code: ErrorCode
  message: string
  details?: unknown
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiErrorShape }

/** Expected, user-facing failure. Messages must not contain secrets. */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
