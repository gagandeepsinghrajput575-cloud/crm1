import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type { Db } from '../db.js'
import { config } from '../config/env.js'
import type { TelephonyProvider } from '../telephony/provider.js'

export const healthRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db; provider: TelephonyProvider; startedAt: number }) => {
    // Liveness: the process is up. Deliberately does not touch the database —
    // a slow database should not cause the orchestrator to kill a healthy pod.
    app.get('/health/live', async () => ({
      status: 'ok',
      uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
    }))

    // Readiness: can we actually serve traffic? This one checks the database.
    app.get('/health/ready', async (_req, reply) => {
      let database = 'ok'
      try {
        await opts.db.$queryRaw`SELECT 1`
      } catch {
        database = 'unavailable'
      }

      const healthy = database === 'ok'
      return reply.status(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        checks: { database },
        telephony: {
          provider: opts.provider.name,
          configured: opts.provider.isConfigured(),
        },
      })
    })

    app.get('/health', async () => ({
      status: 'ok',
      version: process.env.npm_package_version ?? '1.0.0',
      environment: config.NODE_ENV,
      database: config.usePglite ? 'pglite' : 'postgres',
      uptimeSec: Math.round((Date.now() - opts.startedAt) / 1000),
    }))

    app.get('/', async () => ({
      name: 'dialflow-api',
      docs: config.DISABLE_DOCS ? null : '/docs',
      health: '/health',
    }))
  },
  { name: 'health-routes' },
)
