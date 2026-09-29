import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { Db } from '../db.js'
import { LeadStage } from '../generated/client/enums.js'
import { notFound } from '../lib/errors.js'
import { parseOrThrow, uuidParam } from '../lib/validate.js'
import { updateLead } from '../services/leads.js'
import { shapeLead } from './leads.js'

/** Column order and display labels, mirrored from the frontend's STAGES array. */
const STAGE_ORDER: Array<{ id: LeadStage; label: string }> = [
  { id: LeadStage.new, label: 'New Leads' },
  { id: LeadStage.attempted, label: 'Attempted' },
  { id: LeadStage.connected, label: 'Connected' },
  { id: LeadStage.followup, label: 'Follow-Up' },
  { id: LeadStage.qualified, label: 'Qualified' },
  { id: LeadStage.won, label: 'Closed Won' },
  { id: LeadStage.lost, label: 'Closed Lost' },
]

export const pipelineRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db }) => {
    const db = opts.db

    /**
     * The whole board in one request. The frontend previously filtered an
     * in-memory array per column; with a real database that is one query
     * instead of seven, and it can never show a lead in two columns.
     */
    app.get('/api/pipeline', async (req) => {
      const q = parseOrThrow(
        z.object({
          search: z.string().trim().max(200).optional(),
          limitPerColumn: z.coerce.number().int().min(1).max(200).default(100),
        }),
        req.query,
      )

      const where = q.search
        ? {
            OR: [
              { firstName: { contains: q.search, mode: 'insensitive' as const } },
              { lastName: { contains: q.search, mode: 'insensitive' as const } },
              { company: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}

      const grouped = await db.lead.groupBy({
        by: ['stage'],
        where,
        _count: { _all: true },
        _sum: { valueCents: true },
      })

      const counts = new Map(grouped.map((g) => [g.stage, g]))

      const columns = await Promise.all(
        STAGE_ORDER.map(async (stage) => {
          const leads = await db.lead.findMany({
            where: { ...where, stage: stage.id },
            orderBy: [{ score: 'desc' }, { id: 'desc' }],
            take: q.limitPerColumn,
          })
          const meta = counts.get(stage.id)
          return {
            stage: stage.id,
            label: stage.label,
            count: meta?._count._all ?? 0,
            // Truncated columns are flagged so the UI can show "showing 100 of N"
            // rather than silently truncating.
            truncated: (meta?._count._all ?? 0) > leads.length,
            valueCents: meta?._sum.valueCents ?? 0,
            leads: leads.map(shapeLead),
          }
        }),
      )

      return {
        data: columns,
        summary: {
          totalLeads: columns.reduce((n, c) => n + c.count, 0),
          totalValueCents: columns.reduce((n, c) => n + c.valueCents, 0),
          openValueCents: columns
            .filter((c) => c.stage !== LeadStage.won && c.stage !== LeadStage.lost)
            .reduce((n, c) => n + c.valueCents, 0),
          wonValueCents: columns.find((c) => c.stage === LeadStage.won)?.valueCents ?? 0,
        },
      }
    })

    /** Drag-and-drop target: moves a lead and records the audit entry. */
    app.post('/api/pipeline/move', async (req) => {
      const body = parseOrThrow(
        z.object({
          leadId: z.uuid(),
          toStage: z.enum(LeadStage),
        }),
        req.body,
      )

      const existing = await db.lead.findUnique({
        where: { id: body.leadId },
        select: { id: true, stage: true },
      })
      if (!existing) throw notFound('Lead')

      const lead = await updateLead(db, body.leadId, { stage: body.toStage })
      return { id: lead.id, fromStage: existing.stage, toStage: lead.stage }
    })

    /** Per-stage conversion, used by the analytics view. */
    app.get('/api/pipeline/velocity', async () => {
      const since = new Date(Date.now() - 30 * 86_400_000)
      const rows = await db.stageChange.findMany({
        where: { createdAt: { gte: since } },
        select: { fromStage: true, toStage: true, createdAt: true },
      })

      const entered = new Map<LeadStage, number>()
      for (const r of rows) {
        entered.set(r.toStage, (entered.get(r.toStage) ?? 0) + 1)
      }

      const totalEntered = rows.length

      return {
        windowDays: 30,
        data: STAGE_ORDER.map((s) => {
          const count = entered.get(s.id) ?? 0
          return {
            stage: s.id,
            label: s.label,
            entered: count,
            share: totalEntered ? Number(((count / totalEntered) * 100).toFixed(1)) : 0,
          }
        }),
      }
    })
  },
  { name: 'pipeline-routes' },
)
