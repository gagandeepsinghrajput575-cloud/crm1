import { z } from 'zod'
import { validationFailed } from './errors.js'

/**
 * Zod → Fastify glue.
 *
 * Parsing is centralised so every route rejects malformed input with the same
 * 422 envelope listing field paths, instead of each handler inventing its own
 * error shape.
 */

export function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw validationFailed(
    result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
      code: i.code,
    })),
  )
}

export const uuidParam = z.object({ id: z.uuid('Must be a valid UUID') })
