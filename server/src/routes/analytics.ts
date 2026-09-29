import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { Db } from '../db.js'
import { CallStatus, LeadStage } from '../generated/client/enums.js'
import { parseOrThrow } from '../lib/validate.js'

/** Display order for the funnel, mirrored from the pipeline's columns. */
const STAGE_ORDER: Array<{ id: LeadStage; label: string }> = [
  { id: LeadStage.new, label: 'New Leads' },
  { id: LeadStage.attempted, label: 'Attempted' },
  { id: LeadStage.connected, label: 'Connected' },
  { id: LeadStage.followup, label: 'Follow-Up' },
  { id: LeadStage.qualified, label: 'Qualified' },
  { id: LeadStage.won, label: 'Closed Won' },
  { id: LeadStage.lost, label: 'Closed Lost' },
]

const rangeQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
})

export const analyticsRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db }) => {
    const db = opts.db

    /**
     * Dashboard summary.
     *
     * Computed with database aggregates rather than by pulling rows into
     * Node — the previous approach would have loaded every call in the window
     * to average a handful of numbers.
     */
    app.get('/api/analytics/summary', async (req) => {
      const { days } = parseOrThrow(rangeQuery, req.query)
      const since = new Date(Date.now() - days * 86_400_000)
      const priorSince = new Date(Date.now() - days * 2 * 86_400_000)

      const [callAgg, leadAgg, stageCounts, topSources, won] = await db.$transaction([
        db.call.aggregate({
          where: { startedAt: { gte: since } },
          _count: { id: true },
          _avg: { durationSec: true },
          _sum: { durationSec: true },
        }),
        db.lead.aggregate({
          _count: { id: true },
          _sum: { valueCents: true },
        }),
        db.lead.groupBy({
          by: ['stage'],
          _count: { _all: true },
          _sum: { valueCents: true },
        }),
        db.lead.groupBy({
          by: ['source'],
          _count: { _all: true },
          _sum: { valueCents: true },
          orderBy: { _count: { id: 'desc' } },
          take: 8,
        }),
        db.lead.aggregate({
          where: { stage: LeadStage.won },
          _count: { id: true },
          _sum: { valueCents: true },
        }),
      ])

      const connected = await db.call.count({
        where: { startedAt: { gte: since }, status: CallStatus.completed, durationSec: { gt: 0 } },
      })
      const priorTotal = await db.call.count({ where: { startedAt: { gte: priorSince, lt: since } } })
      const priorConnected = await db.call.count({
        where: {
          startedAt: { gte: priorSince, lt: since },
          status: CallStatus.completed,
          durationSec: { gt: 0 },
        },
      })

      const totalCalls = callAgg._count.id
      const connectRate = totalCalls ? connected / totalCalls : 0
      const priorConnectRate = priorTotal ? priorConnected / priorTotal : 0

      const wonCount = won._count.id
      const wonValue = won._sum.valueCents ?? 0

      return {
        windowDays: days,
        calls: {
          total: totalCalls,
          connected,
          connectRate: round(connectRate),
          connectRateDelta: round(connectRate - priorConnectRate),
          averageDurationSec: Math.round(callAgg._avg.durationSec ?? 0),
          totalTalkTimeSec: callAgg._sum.durationSec ?? 0,
        },
        pipeline: {
          totalLeads: leadAgg._count.id,
          totalValueCents: leadAgg._sum.valueCents ?? 0,
          wonCount,
          wonValueCents: wonValue,
          // Revenue actually closed per lead that was worked.
          revenuePerLeadCents: leadAgg._count.id ? Math.round(wonValue / leadAgg._count.id) : 0,
        },
        stages: STAGE_ORDER.map((stage) => {
          // Always emit every stage, including empty ones. A funnel chart that
          // silently omits a stage with zero leads misrepresents the pipeline
          // — "Qualified: —" is information, a missing series is not.
          const row = stageCounts.find((s) => s.stage === stage.id)
          return {
            stage: stage.id,
            label: stage.label,
            count: row?._count._all ?? 0,
            valueCents: row?._sum.valueCents ?? 0,
          }
        }),
        sources: topSources.map((s) => ({
          source: s.source ?? 'unknown',
          count: s._count._all,
          valueCents: s._sum.valueCents ?? 0,
        })),
      }
    })

    /** Daily call volume + outcome mix, for the trend chart. */
    app.get('/api/analytics/timeseries', async (req) => {
      const { days } = parseOrThrow(rangeQuery, req.query)
      const since = new Date(Date.now() - days * 86_400_000)

      const calls = await db.call.findMany({
        where: { startedAt: { gte: since } },
        select: { startedAt: true, status: true, durationSec: true, mode: true },
      })

      // Bucket in UTC so the chart does not depend on the server's local zone.
      const buckets = new Map<string, { date: string; total: number; connected: number; talkSec: number; callback: number; voip: number }>()

      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(Date.now() - i * 86_400_000)
        buckets.set(d.toISOString().slice(0, 10), {
          date: d.toISOString().slice(0, 10),
          total: 0,
          connected: 0,
          talkSec: 0,
          callback: 0,
          voip: 0,
        })
      }

      for (const call of calls) {
        const key = call.startedAt.toISOString().slice(0, 10)
        const bucket = buckets.get(key)
        if (!bucket) continue
        bucket.total += 1
        if (call.status === CallStatus.completed && call.durationSec > 0) {
          bucket.connected += 1
          bucket.talkSec += call.durationSec
        }
        if (call.mode === 'callback') bucket.callback += 1
        else bucket.voip += 1
      }

      return {
        windowDays: days,
        data: [...buckets.values()].map((b) => ({
          ...b,
          connectRate: b.total ? round(b.connected / b.total) : 0,
          avgTalkSec: b.connected ? Math.round(b.talkSec / b.connected) : 0,
        })),
      }
    })

    /** Agent leaderboard — who is actually converting, not just dialling. */
    app.get('/api/analytics/leaderboard', async (req) => {
      const { days } = parseOrThrow(rangeQuery, req.query)
      const since = new Date(Date.now() - days * 86_400_000)

      const byDisposition = await db.call.groupBy({
        by: ['disposition'],
        where: { startedAt: { gte: since }, disposition: { not: null } },
        _count: { _all: true },
        _avg: { durationSec: true },
        orderBy: { _count: { disposition: 'desc' } },
      })

      const [wonAgg, qualifiedCount] = await db.$transaction([
        db.lead.aggregate({ where: { stage: LeadStage.won }, _count: { id: true } }),
        db.lead.count({ where: { stage: LeadStage.qualified } }),
      ])

      const totalDispositions = byDisposition.reduce((n, d) => n + d._count._all, 0)

      return {
        windowDays: days,
        outcomes: byDisposition.map((d) => ({
          disposition: d.disposition,
          count: d._count._all,
          share: totalDispositions ? round(d._count._all / totalDispositions) : 0,
          avgDurationSec: Math.round(d._avg.durationSec ?? 0),
        })),
        funnel: {
          qualified: qualifiedCount,
          won: wonAgg._count.id,
          // Qualified → won is the number that actually predicts a forecast.
          closeRate: qualifiedCount ? round(wonAgg._count.id / qualifiedCount) : 0,
        },
      }
    })
  },
  { name: 'analytics-routes' },
)

function round(n: number): number {
  return Number(n.toFixed(4))
}
