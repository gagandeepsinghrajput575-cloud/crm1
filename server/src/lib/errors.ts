/**
 * Typed application errors.
 *
 * Anything thrown that is an `AppError` is considered a *client* fault and is
 * reported to the caller with a stable machine-readable `code`. Everything
 * else is treated as an internal fault: logged in full, reported as a generic
 * 500 so we never leak stack traces or driver messages to the client.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'NOT_CONFIGURED'
  | 'INTERNAL_ERROR'

export class AppError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly details?: unknown

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
    Error.captureStackTrace?.(this, AppError)
  }
}

export const badRequest = (m: string, details?: unknown) =>
  new AppError('BAD_REQUEST', m, 400, details)

export const validationFailed = (details: unknown) =>
  new AppError('VALIDATION_FAILED', 'Request validation failed', 422, details)

export const unauthorized = (m = 'Missing or invalid API key') =>
  new AppError('UNAUTHORIZED', m, 401)

export const forbidden = (m = 'Not allowed') => new AppError('FORBIDDEN', m, 403)

export const notFound = (what = 'Resource') =>
  new AppError('NOT_FOUND', `${what} not found`, 404)

export const conflict = (m: string) => new AppError('CONFLICT', m, 409)

export const payloadTooLarge = (m: string) =>
  new AppError('PAYLOAD_TOO_LARGE', m, 413)

export const providerError = (m: string, details?: unknown) =>
  new AppError('PROVIDER_ERROR', m, 502, details)

export const notConfigured = (m: string) =>
  new AppError('NOT_CONFIGURED', m, 503)

export const internal = (m = 'Internal server error') =>
  new AppError('INTERNAL_ERROR', m, 500)
