import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { Db } from '../db.js'
import { CallMode, CallStatus, LeadStage } from '../generated/client/enums.js'
import { notFound, badRequest } from '../lib/errors.js'
import { buildPage, paginationQuery } from '../lib/pagination.js'
import { parseOrThrow, uuidParam } from '../lib/validate.js'
import { applyProviderEvent, completeCall, hangupCall, initiateCall, isTerminal } from '../services/calls.js'
import type { ProviderEvent, TelephonyProvider } from '../telephony/provider.js'
import { shapeCallSummary, shapeLead } from './leads.js'

const listQuery = paginationQuery.extend({
  leadId: z.uuid().optional(),
  status: z
    .union([z.enum(CallStatus), z.array(z.enum(CallStatus))])
    .optional(),
  mode: z.enum(CallMode).optional(),
  disposition: z.string().optional(),
  /** Bound the date range; unbounded history queries are a denial-of-service. */
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
})

const initiateBody = z.object({
  leadId: z.uuid(),
  mode: z.enum(CallMode).default(CallMode.callback),
  callerId: z.string().min(3).max(40).optional(),
  agentPhone: z.string().min(3).max(40).optional(),
  record: z.boolean().optional(),
  timeoutSec: z.number().int().min(5).max(180).optional(),
})

export const callRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db; provider: TelephonyProvider; defaultCallerId: string }) => {
    const { db, provider } = opts

    app.get('/api/calls', async (req) => {
      const q = parseOrThrow(listQuery, req.query)

      const statuses = q.status
        ? Array.isArray(q.status)
          ? q.status
          : [q.status]
        : undefined

      const where = {
        ...(q.leadId ? { leadId: q.leadId } : {}),
        ...(statuses?.length ? { status: { in: statuses } } : {}),
        ...(q.mode ? { mode: q.mode } : {}),
        ...(q.disposition ? { disposition: q.disposition as never } : {}),
        ...(q.from || q.to
          ? {
              startedAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
      }

      const [rows, totalCount] = await db.$transaction([
        db.call.findMany({
          where,
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: q.limit + 1,
          include: { lead: true },
        }),
        db.call.count({ where }),
      ])

      const page = buildPage(
        rows.map((c) => ({ ...shapeCallSummary(c), lead: shapeLead(c.lead) })),
        q.limit,
        totalCount,
      )
      return page
    })

    app.get('/api/calls/active', async () => {
      const rows = await db.call.findMany({
        where: { status: { in: [CallStatus.initiated, CallStatus.ringing, CallStatus.connected] } },
        orderBy: { startedAt: 'desc' },
        include: { lead: true, events: { orderBy: { occurredAt: 'asc' } } },
      })
      return {
        data: rows.map((c) => ({
          ...shapeCallSummary(c),
          lead: shapeLead(c.lead),
          events: c.events.map((e) => ({
            type: e.type,
            at: e.occurredAt.toISOString(),
          })),
        })),
      }
    })

    app.get('/api/calls/:id', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const call = await db.call.findUnique({
        where: { id },
        include: { lead: true, events: { orderBy: { occurredAt: 'asc' } } },
      })
      if (!call) throw notFound('Call')

      return {
        ...shapeCallSummary(call),
        providerCallId: call.providerCallId,
        sipLeg: call.sipLeg,
        direction: call.direction,
        answeredAt: call.answeredAt?.toISOString() ?? null,
        endedAt: call.endedAt?.toISOString() ?? null,
        lead: shapeLead(call.lead),
        events: call.events.map((e) => ({
          id: e.id,
          type: e.type,
          at: e.occurredAt.toISOString(),
          payload: e.payload,
        })),
      }
    })

    app.post('/api/calls', async (req, reply) => {
      const body = parseOrThrow(initiateBody, req.body)

      if (!provider.isConfigured()) {
        throw badRequest(
          `Telephony provider "${provider.name}" is not configured. Set its credentials and restart.`,
        )
      }

      const call = await initiateCall(db, {
        leadId: body.leadId,
        mode: body.mode,
        provider,
        callerId: body.callerId ?? opts.defaultCallerId,
        agentPhone: body.agentPhone,
        record: body.record,
        timeoutSec: body.timeoutSec,
      })

      reply.status(201)
      return {
        ...shapeCallSummary(call),
        providerCallId: call.providerCallId,
        status: call.status,
      }
    })

    app.post('/api/calls/:id/hangup', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const call = await hangupCall(db, id, provider)
      return { id: call.id, status: call.status, endedAt: call.endedAt?.toISOString() ?? null }
    })

    app.post('/api/calls/:id/complete', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const body = parseOrThrow(
        z.object({
          disposition: z.string().max(40).nullish(),
          note: z.string().max(4000).nullish(),
          durationSec: z.number().int().min(0).max(86_400).optional(),
          stage: z.enum(LeadStage).optional(),
        }),
        req.body,
      )

      const call = await completeCall(db, id, {
        disposition: body.disposition,
        note: body.note,
        durationSec: body.durationSec,
        stage: body.stage,
      })
      return shapeCallSummary(call)
    })

    /**
     * Telephony webhook intake.
     *
     * Auth is the same shared API key (providers that support a custom header
     * can send it); a provider-specific signature check belongs at the top of
     * the adapter's parseWebhook. Always answers 200 so a provider does not
     * retry forever on an event we deliberately ignored.
     */
    app.post('/api/webhooks/telephony', async (req) => {
      const events = provider.parseWebhook(req.headers, req.body)
      if (events.length === 0) {
        return { received: 0, applied: 0, ignored: 0 }
      }

      let applied = 0
      for (const event of events) {
        const result = await applyProviderEvent(db, event)
        if (result.applied) applied += 1
      }

      return { received: events.length, applied, ignored: events.length - applied }
    })

    /**
     * Mock-only driver. Walks a simulated call to its terminal state so the
     * demo and the end-to-end tests can exercise the full state machine
     * without a provider.
     *
     * The events it produces are fed back through `applyProviderEvent` — the
     * exact same path a real provider webhook takes — so this exercises the
     * production code rather than a shortcut around it.
     */
    app.post('/api/calls/:id/simulate', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const mockProvider = provider as unknown as {
        advanceToCompletion?: (cid: string) => ProviderEvent[]
      }
      if (typeof mockProvider.advanceToCompletion !== 'function') {
        throw notFound('Simulation is only available with the mock provider')
      }

      const call = await db.call.findUnique({ where: { id } })
      if (!call) throw notFound('Call')
      if (!call.providerCallId) throw badRequest('Call has no provider id yet')
      if (isTerminal(call.status)) {
        return { id, status: call.status, note: 'already terminal' }
      }

      const events = mockProvider.advanceToCompletion(call.providerCallId)
      const applied: string[] = []
      for (const event of events) {
        const result = await applyProviderEvent(db, event)
        if (result.applied) applied.push(event.type)
      }

      const refreshed = await db.call.findUnique({ where: { id } })
      return { id, status: refreshed?.status, applied }
    })
  },
  { name: 'call-routes' },
)
