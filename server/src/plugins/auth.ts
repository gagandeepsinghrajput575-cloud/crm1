import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { config } from '../config/env.js'
import { hashApiKey, keyPrefix } from '../lib/crypto.js'
import { unauthorized } from '../lib/errors.js'
import type { Db } from '../db.js'

/**
 * Single-tenant API-key authentication.
 *
 * The key is supplied as `Authorization: Bearer <key>` (preferred) or
 * `X-API-Key: <key>`. Comparison is constant-time against SHA-256 digests so
 * neither timing nor a database read can be used to guess it.
 *
 * `API_KEY_PREVIOUS` lets you rotate without downtime: deploy with the old key
 * in that slot, ship clients over, then drop it.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /** Non-secret fragment of the key that authenticated this request. */
    apiKeyPrefix?: string
  }
}

/** Routes that must stay reachable without a key. */
const PUBLIC_ROUTES = new Set(['/health', '/health/live', '/health/ready', '/'])

/** Only touch the database to record usage this often, not on every request. */
const USAGE_WRITE_INTERVAL_MS = 60_000

function extractKey(req: FastifyRequest): string | null {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim()
  const header = req.headers['x-api-key']
  if (typeof header === 'string' && header.trim()) return header.trim()
  return null
}

function constantTimeDigestMatch(provided: string, expectedKey: string): boolean {
  const a = Buffer.from(hashApiKey(provided), 'hex')
  const b = Buffer.from(hashApiKey(expectedKey), 'hex')
  return timingSafeEqual(a, b)
}

export const authPlugin = fp(
  async (app: FastifyInstance, opts: { db: Db }) => {
    let lastWrite = 0

    app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const path = req.url.split('?')[0] ?? ''
      if (PUBLIC_ROUTES.has(path)) return
      // Swagger assets are static and carry no data.
      if (path.startsWith('/docs') || path === '/openapi.json') return

      const provided = extractKey(req)
      if (!provided) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing API key. Send `Authorization: Bearer <key>`.',
            correlationId: req.id,
          },
        })
      }

      const valid =
        constantTimeDigestMatch(provided, config.API_KEY) ||
        (config.API_KEY_PREVIOUS !== '' &&
          constantTimeDigestMatch(provided, config.API_KEY_PREVIOUS))

      if (!valid) throw unauthorized('Invalid API key')

      req.apiKeyPrefix = keyPrefix(provided)

      // Best-effort usage stamp. A failure here must never fail the request.
      const now = Date.now()
      if (now - lastWrite > USAGE_WRITE_INTERVAL_MS) {
        lastWrite = now
        void opts.db.apiKey
          .updateMany({
            where: { keyHash: hashApiKey(provided) },
            data: { lastUsedAt: new Date(now) },
          })
          .catch((err) => req.log.warn({ err }, 'could not record api key usage'))
      }
    })
  },
  { name: 'auth' },
)
