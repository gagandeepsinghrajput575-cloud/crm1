import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { Db } from '../db.js'
import { config } from '../config/env.js'
import { generateApiKey, hashApiKey, keyPrefix } from '../lib/crypto.js'
import { providerError } from '../lib/errors.js'
import { requirePhone } from '../lib/phone.js'
import { parseOrThrow } from '../lib/validate.js'
import type { TelephonyProvider } from '../telephony/provider.js'
import { availableProviders } from '../telephony/index.js'

/**
 * Dialer settings.
 *
 * The frontend stored Sonetel client secrets and a bearer token in
 * localStorage, which means any XSS in the page hands over full telephony
 * access. Those credentials now live only in the server's environment and are
 * never returned by this endpoint — the client can ask *whether* the provider
 * is configured, never *with what*.
 */
const SETTINGS_KEY = 'dialer'

interface DialerSettings {
  mode: 'callback' | 'voip'
  autoAdvance: boolean
  /** Seconds to wait after hangup before offering the next lead. */
  delaySec: number
  record: boolean
  agentPhone: string | null
  callerId: string | null
  sipUser: string | null
  sipDomain: string | null
  agentTimezone: string
}

const DEFAULT_SETTINGS: DialerSettings = {
  mode: 'callback',
  autoAdvance: true,
  delaySec: 2,
  record: true,
  agentPhone: null,
  callerId: null,
  sipUser: null,
  sipDomain: null,
  agentTimezone: 'UTC',
}

const patchBody = z.object({
  mode: z.enum(['callback', 'voip']).optional(),
  autoAdvance: z.boolean().optional(),
  delaySec: z.number().min(0).max(30).optional(),
  record: z.boolean().optional(),
  agentPhone: z.string().max(40).nullish(),
  callerId: z.string().max(40).nullish(),
  sipUser: z.string().max(120).nullish(),
  sipDomain: z.string().max(200).nullish(),
  agentTimezone: z.string().max(32).optional(),
})

export const settingsRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db; provider: TelephonyProvider }) => {
    const db = opts.db
    const provider = opts.provider

    const read = async (): Promise<DialerSettings> => {
      const row = await db.setting.findUnique({ where: { key: SETTINGS_KEY } })
      if (!row) return { ...DEFAULT_SETTINGS }
      // Merge so a newly-added setting gets its default instead of undefined.
      return { ...DEFAULT_SETTINGS, ...(row.value as Partial<DialerSettings>) }
    }

    const write = async (value: DialerSettings) => {
      await db.setting.upsert({
        where: { key: SETTINGS_KEY },
        create: { key: SETTINGS_KEY, value: value as never },
        update: { value: value as never },
      })
    }

    app.get('/api/settings', async () => {
      const settings = await read()
      return {
        data: {
          ...settings,
          // Presence flags only. No secret ever crosses this boundary.
          telephony: {
            provider: provider.name,
            availableProviders: availableProviders(),
            configured: provider.isConfigured(),
          },
        },
      }
    })

    app.patch('/api/settings', async (req) => {
      const patch = parseOrThrow(patchBody, req.body)
      const current = await read()
      const next: DialerSettings = { ...current }

      if (patch.mode !== undefined) next.mode = patch.mode
      if (patch.autoAdvance !== undefined) next.autoAdvance = patch.autoAdvance
      if (patch.delaySec !== undefined) next.delaySec = patch.delaySec
      if (patch.record !== undefined) next.record = patch.record
      if (patch.agentTimezone !== undefined) next.agentTimezone = patch.agentTimezone
      if (patch.sipUser !== undefined) next.sipUser = patch.sipUser
      if (patch.sipDomain !== undefined) next.sipDomain = patch.sipDomain

      // Phone numbers are normalised on the way in, not just validated.
      if (patch.agentPhone !== undefined) {
        next.agentPhone = patch.agentPhone === null ? null : requirePhone(patch.agentPhone)
      }
      if (patch.callerId !== undefined) {
        next.callerId = patch.callerId === null ? null : requirePhone(patch.callerId)
      }

      await write(next)
      return { data: next }
    })

    /** Verifies provider credentials without ever echoing them back. */
    app.post('/api/settings/telephony/verify', async (req) => {
      const status = await provider.verifyCredentials()
      if (status.ok) {
        req.log.info({ provider: provider.name }, 'telephony credentials verified')
      } else {
        req.log.warn({ provider: provider.name }, 'telephony verification failed')
      }
      return {
        data: {
          provider: provider.name,
          ok: status.ok,
          detail: status.detail,
          callerIds: status.callerIds ?? [],
          expiresAt: status.expiresAt?.toISOString() ?? null,
        },
      }
    })

    app.get('/api/settings/caller-ids', async (_req, reply) => {
      try {
        const ids = await provider.listCallerIds()
        return { data: ids }
      } catch (err) {
        // Provider outages must not surface as a 500 with a stack trace.
        throw providerError(
          err instanceof Error ? err.message : 'Could not fetch caller IDs',
        )
      }
    })

    /**
     * Issues an additional API key.
     *
     * This is the one endpoint that returns a secret, and it does so exactly
     * once: only the SHA-256 is persisted, so a lost key must be rotated
     * rather than recovered.
     */
    app.post('/api/keys', async (req, reply) => {
      const { name } = parseOrThrow(
        z.object({ name: z.string().trim().min(1).max(80).default('secondary') }),
        req.body ?? {},
      )

      const key = generateApiKey()
      const record = await db.apiKey.create({
        data: { name, keyHash: hashApiKey(key), prefix: keyPrefix(key) },
        select: { id: true, name: true, prefix: true, createdAt: true },
      })

      reply.status(201)
      return { ...record, key, warning: 'Store this key now. It cannot be retrieved again.' }
    })

    app.get('/api/keys', async () => {
      const keys = await db.apiKey.findMany({
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, prefix: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      })
      return { data: keys }
    })

    app.delete('/api/keys/:id', async (req, reply) => {
      const { id } = parseOrThrow(z.object({ id: z.uuid() }), req.params)
      const result = await db.apiKey.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      if (result.count === 0) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Key not found or already revoked', correlationId: req.id },
        })
      }
      reply.status(204)
    })

    // The bootstrap key is not stored, so make that explicit for operators.
    app.get('/api/settings/runtime', async () => {
      return {
        data: {
          environment: config.NODE_ENV,
          telephonyProvider: config.TELEPHONY_PROVIDER,
          database: config.usePglite ? 'pglite (embedded)' : 'postgres',
          docsEnabled: !config.DISABLE_DOCS,
          rateLimit: { max: config.RATE_LIMIT_MAX, window: config.RATE_LIMIT_WINDOW },
          maxUploadBytes: config.MAX_UPLOAD_BYTES,
          bootstrapKeyConfigured: Boolean(config.API_KEY),
          previousKeyActive: Boolean(config.API_KEY_PREVIOUS),
        },
      }
    })
  },
  { name: 'settings-routes' },
)
