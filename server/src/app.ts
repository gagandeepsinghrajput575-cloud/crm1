import Fastify, { LogController, type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { config } from './config/env.js'
import { createDb, type Db } from './db.js'
import { authPlugin } from './plugins/auth.js'
import { registerErrorHandler } from './plugins/errorHandler.js'
import { analyticsRoutes } from './routes/analytics.js'
import { callRoutes } from './routes/calls.js'
import { healthRoutes } from './routes/health.js'
import { importRoutes } from './routes/imports.js'
import { leadRoutes } from './routes/leads.js'
import { pipelineRoutes } from './routes/pipeline.js'
import { settingsRoutes } from './routes/settings.js'
import { createTelephonyProvider } from './telephony/index.js'
import type { TelephonyProvider } from './telephony/provider.js'

export interface BuildOptions {
  db?: Db
  provider?: TelephonyProvider
  /** Overrides the persisted agent timezone, mainly for tests. */
  agentTimezone?: string
  logger?: boolean
}

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const startedAt = Date.now()
  const db = opts.db ?? (await createDb())
  const provider = opts.provider ?? createTelephonyProvider()

  // Request logging is on in dev (genuinely useful there) and off in
  // production, where the access log belongs to the reverse proxy and
  // duplicating it just doubles log volume.
  const logController = new LogController({ disableRequestLogging: config.isProd })

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: config.LOG_LEVEL,
            // Pretty output in a terminal, structured JSON everywhere else, so
            // a log shipper never has to parse ANSI codes.
            transport: config.isProd
              ? undefined
              : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers["x-api-key"]',
                'res.headers["set-cookie"]',
                'body.password',
                'body.clientSecret',
                'body.token',
              ],
              remove: true,
            },
          },
    // Behind a reverse proxy, req.ip must come from X-Forwarded-For or every
    // rate-limit bucket collapses onto the proxy's address.
    trustProxy: true,
    bodyLimit: config.MAX_UPLOAD_BYTES,
    genReqId: (req) => {
      const existing = req.headers['x-request-id']
      if (typeof existing === 'string' && existing.length <= 128) return existing
      return crypto.randomUUID()
    },
    logController,
  })

  registerErrorHandler(app)

  await app.register(helmet, {
    // The API serves JSON, not HTML, so a strict CSP buys nothing here but
    // would break the Swagger UI.
    contentSecurityPolicy: false,
    // Helmet defaults this to `same-origin`, which instructs the browser to
    // block cross-origin fetches of our responses even when CORS allows them.
    // For an API that a browser app on another origin calls, that silently
    // defeats the whole CORS configuration.
    crossOriginResourcePolicy: false,
  })

  await app.register(cors, {
    // An empty allow-list means "same-origin / non-browser callers only", which
    // is the safe default when CORS_ORIGIN is unset.
    origin: config.CORS_ORIGIN.length ? config.CORS_ORIGIN : false,
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-api-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-ratelimit-remaining'],
  })

  await app.register(rateLimit, {
    // Bucketing per API key means one noisy client cannot exhaust the budget of
    // every other client behind the same IP.
    keyGenerator: (req) => req.apiKeyPrefix ?? req.ip,
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW,
    // Health checks and docs should never be throttled out of existence.
    allowList: (req) => (req.url.split('?')[0] ?? '').startsWith('/health') || req.url === '/',
    // Health checks would otherwise consume the entire budget of a busy day.
    global: true,
    addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: {
        code: 'RATE_LIMITED',
        message: `Rate limit exceeded. Retry in ${Math.ceil(context.ttl / 1000)}s.`,
      },
    }),
  })

  if (!config.DISABLE_DOCS) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Dialflow API',
          description:
            'Backend for the Dialflow Sonetel power dialer. Every route except /health and /docs requires `Authorization: Bearer <API_KEY>`.',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    })
    await app.register(swaggerUi, { routePrefix: '/docs' })
  }

  await app.register(authPlugin, { db })

  // Lead scoring is timezone-aware, so the agent's working zone is read once at
  // boot rather than on every write.
  const agentTimezone =
    opts.agentTimezone ??
    (await db.setting
      .findUnique({ where: { key: 'dialer' } })
      .then((row) => (row?.value as { agentTimezone?: string } | null)?.agentTimezone ?? 'UTC')
      .catch(() => 'UTC'))

  await app.register(healthRoutes, { db, provider, startedAt })
  await app.register(leadRoutes, { db, agentTimezone })
  await app.register(pipelineRoutes, { db })
  await app.register(callRoutes, { db, provider, defaultCallerId: config.SONETEL_CALLER_ID || '' })
  await app.register(importRoutes, { db, agentTimezone })
  await app.register(analyticsRoutes, { db })
  await app.register(settingsRoutes, { db, provider })

  app.addHook('onClose', async () => {
    if (!opts.db) await db.$disconnect()
  })

  return app
}
