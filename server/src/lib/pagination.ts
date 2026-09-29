import { z } from 'zod'
import { validationFailed } from './errors.js'

/**
 * Cursor pagination.
 *
 * Offset pagination silently skips or duplicates rows whenever a record is
 * inserted mid-scan, which matters a lot for the dialer queue where leads are
 * being created and advanced constantly. Leads therefore paginate by a stable
 * `(sortField, id)` keyset cursor.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().optional(),
  /** Offset fallback, used by the pipeline board where columns are small. */
  offset: z.coerce.number().int().min(0).optional(),
})

export type PaginationQuery = z.infer<typeof paginationQuery>

export interface Page<T> {
  data: T[]
  pageInfo: {
    hasNextPage: boolean
    endCursor: string | null
    totalCount?: number
  }
}

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/**
 * Cursors must decode to a plausible record identifier.
 *
 * `Buffer.from(x, 'base64url')` never throws — it silently ignores invalid
 * characters and returns garbage — so without this check a malformed cursor
 * flows into Prisma as a nonsense `id` and surfaces as a 500 from deep inside
 * the driver, instead of a 422 the caller can act on.
 */
const CURSOR_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function decodeCursor(cursor: string): string {
  let decoded: string
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    throw validationFailed([{ path: ['cursor'], message: 'Malformed cursor' }])
  }
  if (!CURSOR_PATTERN.test(decoded)) {
    throw validationFailed([{ path: ['cursor'], message: 'Malformed cursor' }])
  }
  return decoded
}

/**
 * Builds a page from one extra row fetched beyond the limit: its presence is
 * what tells us whether another page exists, without a COUNT query.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  totalCount?: number,
): Page<T> {
  const hasNextPage = rows.length > limit
  const data = hasNextPage ? rows.slice(0, limit) : rows
  return {
    data,
    pageInfo: {
      hasNextPage,
      endCursor: data.length ? encodeCursor(data[data.length - 1]!.id) : null,
      ...(totalCount === undefined ? {} : { totalCount }),
    },
  }
}
