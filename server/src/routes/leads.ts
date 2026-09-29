import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import { LeadStage } from '../generated/client/enums.js'
import type { Db } from '../db.js'
import { badRequest, notFound } from '../lib/errors.js'
import { buildPage, encodeCursor, paginationQuery, decodeCursor } from '../lib/pagination.js'
import { parseOrThrow, uuidParam } from '../lib/validate.js'
import { BULK_LIMIT, bulkDeleteLeads, createLead, deleteLead, isOpenStage, scoreLead, updateLead } from '../services/leads.js'

const stageEnum = z.enum(LeadStage)

const listQuery = paginationQuery.extend({
  stage: z.union([stageEnum, z.array(stageEnum)]).optional(),
  /** Dialer queue: only leads still eligible for a call. */
  queue: z.coerce.boolean().optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(['score', 'created', 'value', 'lastCalled']).default('score'),
  order: z.enum(['asc', 'desc']).default('desc'),
  tag: z.string().trim().max(64).optional(),
})

const createBody = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  phone: z.string().min(3).max(40),
  email: z.email().max(320).nullish(),
  company: z.string().trim().max(200).nullish(),
  title: z.string().trim().max(200).nullish(),
  timezone: z.string().trim().max(32).nullish(),
  source: z.string().trim().max(64).nullish(),
  /** Accepts dollars (the UI's unit) and stores cents, so no float money. */
  value: z.number().min(0).max(1_000_000_000).nullish(),
  stage: stageEnum.optional(),
  score: z.number().int().min(0).max(100).optional(),
})

const updateBody = createBody.partial().extend({})

function toCents(value: number | null | undefined): number | null | undefined {
  return value === null || value === undefined ? value : Math.round(value * 100)
}

export const leadRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db; agentTimezone: string }) => {
    const db = opts.db

    app.get('/api/leads', async (req) => {
      const q = parseOrThrow(listQuery, req.query)

      let stages = q.stage
        ? Array.isArray(q.stage)
          ? q.stage
          : [q.stage]
        : undefined

      if (q.queue) {
        // The dialer only ever offers open leads, whatever filters are applied.
        stages = stages?.filter(isOpenStage)
      }

      const search = q.search
        ? {
            OR: [
              { firstName: { contains: q.search, mode: 'insensitive' as const } },
              { lastName: { contains: q.search, mode: 'insensitive' as const } },
              { company: { contains: q.search, mode: 'insensitive' as const } },
              { phone: { contains: q.search } },
              { email: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}

      const where = {
        ...(stages?.length ? { stage: { in: stages } } : {}),
        ...(q.tag ? { tags: { some: { tag: { name: q.tag } } } } : {}),
        ...search,
      }

      const orderBy =
        q.sort === 'created'
          ? { createdAt: q.order }
          : q.sort === 'value'
            ? { valueCents: q.order }
            : q.sort === 'lastCalled'
              ? { lastCalled: q.order }
              : { score: q.order }

      // Keyset pagination: `id` breaks ties so the order is total and stable.
      const cursorRow = q.cursor ? await db.lead.findUnique({ where: { id: decodeCursor(q.cursor) }, select: { id: true } }) : null

      const rows = await db.lead.findMany({
        where,
        orderBy: [orderBy, { id: q.order }],
        take: q.limit + 1,
        ...(cursorRow ? { cursor: { id: cursorRow.id }, skip: 1 } : {}),
        include: { tags: { include: { tag: true } } },
      })

      const [totalCount] = await db.$transaction([
        db.lead.count({ where }),
      ])

      return buildPage(
        rows.map(shapeLead),
        q.limit,
        totalCount,
      )
    })

    /** Dialer queue: open leads, best score first, with retry pressure surfaced. */
    app.get('/api/leads/queue', async (req) => {
      const q = parseOrThrow(
        z.object({ limit: z.coerce.number().int().min(1).max(200).default(25) }),
        req.query,
      )

      const rows = await db.lead.findMany({
        where: { stage: { in: [LeadStage.new, LeadStage.attempted, LeadStage.connected, LeadStage.followup, LeadStage.qualified] } },
        orderBy: [{ score: 'desc' }, { id: 'desc' }],
        take: q.limit,
        include: { tags: { include: { tag: true } }, _count: { select: { calls: true } } },
      })

      return {
        data: rows.map((l) => ({
          ...shapeLead(l),
          callCount: l._count.calls,
          // Stale leads drift to the back of the queue rather than being
          // dialled forever at the front.
          lastCalledAt: l.lastCalled?.toISOString() ?? null,
        })),
        pageInfo: { hasNextPage: rows.length === q.limit, endCursor: null, totalCount: null },
      }
    })

    app.get('/api/leads/:id', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const lead = await db.lead.findUnique({
        where: { id },
        include: {
          notes: { orderBy: { createdAt: 'desc' } },
          tags: { include: { tag: true } },
          calls: { orderBy: { startedAt: 'desc' }, take: 20 },
          stageLog: { orderBy: { createdAt: 'desc' }, take: 20 },
        },
      })
      if (!lead) throw notFound('Lead')

      return {
        ...shapeLead(lead),
        notes: lead.notes.map((n) => ({ id: n.id, text: n.text, createdAt: n.createdAt.toISOString() })),
        calls: lead.calls.map(shapeCallSummary),
        stageHistory: lead.stageLog.map((s) => ({
          from: s.fromStage,
          to: s.toStage,
          at: s.createdAt.toISOString(),
        })),
        tags: lead.tags.map((t) => t.tag.name),
      }
    })

    app.post('/api/leads', async (req, reply) => {
      const body = parseOrThrow(createBody, req.body)
      const lead = await createLead(db, {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        email: body.email,
        company: body.company,
        title: body.title,
        timezone: body.timezone,
        source: body.source,
        valueCents: toCents(body.value) ?? 0,
        stage: body.stage,
        score: body.score,
        agentTimezone: opts.agentTimezone,
      })
      reply.status(201)
      return shapeLead(lead)
    })

    app.patch('/api/leads/:id', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const body = parseOrThrow(updateBody, req.body)
      const lead = await updateLead(db, id, {
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone,
        email: body.email,
        company: body.company,
        title: body.title,
        timezone: body.timezone,
        source: body.source,
        valueCents: toCents(body.value),
        stage: body.stage,
        score: body.score,
      })
      return shapeLead(lead)
    })

    app.delete('/api/leads/:id', async (req, reply) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      await deleteLead(db, id)
      reply.status(204)
    })

    app.post('/api/leads/bulk-delete', async (req) => {
      const { ids } = parseOrThrow(
        z.object({ ids: z.array(z.uuid()).min(1).max(BULK_LIMIT) }),
        req.body,
      )
      const deleted = await bulkDeleteLeads(db, ids)
      return { deleted }
    })

    /** Recomputes scores in bulk after a change to the scoring inputs. */
    app.post('/api/leads/rescore', async (req) => {
      const leads = await db.lead.findMany({
        where: { stage: { in: [LeadStage.new, LeadStage.attempted, LeadStage.connected, LeadStage.followup, LeadStage.qualified] } },
        select: {
          id: true, email: true, title: true, company: true, source: true, valueCents: true, timezone: true,
        },
      })

      let updated = 0
      // Batched writes: a 10k-lead rescoring should not open 10k connections.
      const BATCH = 200
      for (let i = 0; i < leads.length; i += BATCH) {
        const batch = leads.slice(i, i + BATCH)
        const result = await Promise.all(
          batch.map((l) =>
            db.lead.update({
              where: { id: l.id },
              data: {
                score: scoreLead({
                  email: l.email, title: l.title, company: l.company,
                  source: l.source, valueCents: l.valueCents,
                  timezone: l.timezone, agentTimezone: opts.agentTimezone,
                }),
              },
              select: { id: true },
            }),
          ),
        )
        updated += result.length
      }

      return { updated, total: leads.length }
    })

    // ------------------------------------------------------------ notes

    app.post('/api/leads/:id/notes', async (req, reply) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const { text } = parseOrThrow(
        z.object({ text: z.string().trim().min(1).max(4000) }),
        req.body,
      )

      const lead = await db.lead.findUnique({ where: { id }, select: { id: true } })
      if (!lead) throw notFound('Lead')

      const note = await db.leadNote.create({ data: { leadId: id, text } })
      reply.status(201)
      return { id: note.id, text: note.text, createdAt: note.createdAt.toISOString() }
    })

    app.delete('/api/leads/:id/notes/:noteId', async (req, reply) => {
      const { id, noteId } = parseOrThrow(
        z.object({ id: z.uuid(), noteId: z.uuid() }),
        req.params,
      )
      // Scoped delete: a note id from another lead must not be removable here.
      const result = await db.leadNote.deleteMany({ where: { id: noteId, leadId: id } })
      if (result.count === 0) throw notFound('Note')
      reply.status(204)
    })

    // ------------------------------------------------------------ tags

    app.post('/api/leads/:id/tags', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const { name, color } = parseOrThrow(
        z.object({
          name: z.string().trim().min(1).max(64),
          color: z.enum(['blue', 'violet', 'emerald', 'amber', 'rose', 'slate']).default('violet'),
        }),
        req.body,
      )

      const lead = await db.lead.findUnique({ where: { id }, select: { id: true } })
      if (!lead) throw notFound('Lead')

      const tag = await db.tag.upsert({
        where: { name },
        create: { name, color },
        update: {},
      })
      await db.leadTag.upsert({
        where: { leadId_tagId: { leadId: id, tagId: tag.id } },
        create: { leadId: id, tagId: tag.id },
        update: {},
      })
      return { ok: true, tag: tag.name }
    })

    app.delete('/api/leads/:id/tags/:tagName', async (req, reply) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const { tagName } = parseOrThrow(z.object({ tagName: z.string().min(1) }), req.params)
      const tag = await db.tag.findUnique({ where: { name: tagName }, select: { id: true } })
      if (!tag) throw notFound('Tag')
      await db.leadTag.deleteMany({ where: { leadId: id, tagId: tag.id } })
      reply.status(204)
    })

    app.get('/api/tags', async () => {
      const tags = await db.tag.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { leads: true } } },
      })
      return {
        data: tags.map((t) => ({ name: t.name, color: t.color, leadCount: t._count.leads })),
      }
    })
  },
  { name: 'lead-routes' },
)

// ---------------------------------------------------------------- shaping

type LeadRow = {
  id: string
  firstName: string
  lastName: string
  company: string | null
  title: string | null
  email: string | null
  phone: string
  phoneRaw: string | null
  timezone: string | null
  stage: LeadStage
  valueCents: number
  score: number
  source: string | null
  lastCalled: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Response shaping. The UI speaks dollars, ISO strings and a derived `name`;
 * the database speaks cents, `Date` and separate name parts. This is the one
 * place that translation is allowed to happen.
 */
function shapeLead(row: LeadRow & { tags?: Array<{ tag: { name: string; color: string } }> }) {
  return {
    id: row.id,
    name: `${row.firstName} ${row.lastName}`.trim(),
    firstName: row.firstName,
    lastName: row.lastName,
    company: row.company,
    title: row.title,
    email: row.email,
    phone: row.phone,
    phoneRaw: row.phoneRaw,
    timezone: row.timezone,
    stage: row.stage,
    value: row.valueCents / 100,
    valueCents: row.valueCents,
    score: row.score,
    source: row.source,
    lastCalledAt: row.lastCalled?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.tags ? { tags: row.tags.map((t) => t.tag.name) } : {}),
  }
}

function shapeCallSummary(call: {
  id: string
  mode: string
  status: string
  disposition: string | null
  durationSec: number
  note: string | null
  startedAt: Date
  recordingUrl: string | null
}) {
  return {
    id: call.id,
    mode: call.mode,
    status: call.status,
    disposition: call.disposition,
    durationSec: call.durationSec,
    note: call.note,
    recordingUrl: call.recordingUrl,
    startedAt: call.startedAt.toISOString(),
  }
}

export { shapeLead, shapeCallSummary, encodeCursor, badRequest }
