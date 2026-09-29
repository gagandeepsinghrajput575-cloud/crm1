import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '../generated/client/client.js'
import { AppError } from '../lib/errors.js'

/**
 * Central error handler.
 *
 * The contract: clients get a stable `{ error: { code, message, details? } }`
 * envelope and never a stack trace, a Prisma error, or a driver message. Logs
 * keep the full detail, with request correlation attached.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const correlationId = req.id

    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        req.log.error({ err, correlationId }, 'application error')
      } else {
        req.log.warn(
          { code: err.code, status: err.statusCode, correlationId },
          err.message,
        )
      }
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details === undefined ? {} : { details: err.details }),
          correlationId,
        },
      })
    }

    // Prisma's own errors carry user-facing meaning worth translating.
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      return translatePrismaError(err, req, reply, correlationId)
    }

    if (err instanceof Prisma.PrismaClientValidationError) {
      req.log.error({ err, correlationId }, 'prisma validation error')
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          correlationId,
        },
      })
    }

    // Body parser and Fastify's own limits.
    const httpError = err as { statusCode?: number; code?: string } | null
    if (httpError?.statusCode === 400 || httpError?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Malformed request body', correlationId },
      })
    }
    if (httpError?.statusCode === 413) {
      return reply.status(413).send({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', correlationId },
      })
    }

    req.log.error({ err, correlationId }, 'unhandled error')
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        correlationId,
      },
    })
  })

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${req.method} ${req.url} does not exist`,
        correlationId: req.id,
      },
    })
  })
}

function translatePrismaError(
  err: Prisma.PrismaClientKnownRequestError,
  req: FastifyRequest,
  reply: FastifyReply,
  correlationId: string,
) {
  switch (err.code) {
    case 'P2002': {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'field'
      req.log.warn({ correlationId, target }, 'unique constraint violation')
      return reply.status(409).send({
        error: { code: 'CONFLICT', message: `Already exists: ${target}`, correlationId },
      })
    }
    case 'P2003':
      req.log.warn({ correlationId }, 'foreign key violation')
      return reply.status(409).send({
        error: {
          code: 'CONFLICT',
          message: 'Referenced record does not exist',
          correlationId,
        },
      })
    case 'P2025':
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Record not found', correlationId },
      })
    default:
      req.log.error({ err, correlationId }, 'prisma error')
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', correlationId },
      })
  }
}
