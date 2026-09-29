import type { Db } from '../db.js'
import { LeadStage } from '../generated/client/enums.js'
import { conflict, notFound } from '../lib/errors.js'
import { requirePhone } from '../lib/phone.js'

/**
 * Lead domain logic.
 *
 * Kept out of the route handlers so scoring, stage auditing and phone
 * normalisation have one definition no matter which endpoint calls them.
 */

export const OPEN_STAGES: LeadStage[] = [
  LeadStage.new,
  LeadStage.attempted,
  LeadStage.connected,
  LeadStage.followup,
  LeadStage.qualified,
]

/** A lead in a closed stage should leave the dialer queue. */
export function isOpenStage(stage: LeadStage): boolean {
  return OPEN_STAGES.includes(stage)
}

/**
 * Deterministic lead score, 0–100.
 *
 * The original frontend did `60 + Math.random() * 40`, which meant the dialer
 * queue order changed on every page load — the agent had no way to learn or
 * trust the ordering. This scores the same inputs to the same number every
 * time, so "dial next" is reproducible and the ordering is explainable.
 *
 * Weights reflect what actually predicts a good conversation on a cold
 * outbound list: being reachable, having context to open with, and having
 * enough value to justify the call.
 */
export interface ScoreInput {
  email?: string | null
  title?: string | null
  company?: string | null
  source?: string | null
  valueCents?: number | null
  timezone?: string | null
  agentTimezone?: string | null
}

const SOURCE_WEIGHTS: Record<string, number> = {
  referral: 18,
  partner: 16,
  'inbound demo': 15,
  demo: 15,
  website: 12,
  linkedin: 10,
  'cold call': 6,
  outbound: 6,
  'csv import': 4,
}

export function scoreLead(input: ScoreInput): number {
  let score = 30 // baseline so nothing scores an absolute zero

  if (input.email) score += 12
  if (input.title) score += 8
  if (input.company) score += 8

  const source = input.source?.trim().toLowerCase()
  if (source) score += SOURCE_WEIGHTS[source] ?? 5

  // Log-scaled value: a $32k deal should beat a $700 one, but a $5M deal
  // should not run away with the ranking. Scaled in dollars, not cents — an
  // earlier version used cents, which saturated the bonus at around a $100
  // deal and made deal value meaningless for every real opportunity.
  const dollars = Number(input.valueCents ?? 0) / 100
  if (dollars > 0) {
    score += Math.min(20, Math.round(Math.log10(dollars + 1) * 2.5))
  }

  // Reaching someone in the agent's own working hours is worth a real bonus —
  // it is the single biggest driver of connect rate on outbound.
  if (input.timezone && input.agentTimezone) {
    const a = input.agentTimezone.trim().toUpperCase()
    const b = input.timezone.trim().toUpperCase()
    if (a === b) score += 12
    else if (offsetHours(a) !== null && offsetHours(b) !== null && Math.abs(offsetHours(a)! - offsetHours(b)!) <= 3) {
      score += 6
    }
  }

  return Math.max(0, Math.min(100, score))
}

/**
 * Timezone offsets in hours. Includes the bare labels (ET, PT, CT) that the
 * lead importer and the existing seed data actually use, not just the formal
 * IANA names — a missing entry here silently costs a lead its timezone bonus.
 */
const TZ_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  WET: 0,
  BST: 1,
  CET: 1,
  CEST: 2,
  EET: 2,
  EEST: 3,
  IST: 5.5,
  MSK: 3,
  // Bare US labels used by the UI's seed data.
  ET: -5,
  EDT: -4,
  CT: -6,
  CDT: -5,
  MT: -7,
  MDT: -6,
  PT: -8,
  PDT: -7,
  AKST: -9,
  HST: -10,
  AEST: 10,
  AEDT: 11,
  NZST: 12,
  SGT: 8,
  HKT: 8,
  JST: 9,
  KST: 9,
}

function offsetHours(tz: string): number | null {
  return TZ_OFFSETS[tz.toUpperCase()] ?? null
}

export interface CreateLeadInput {
  firstName: string
  lastName: string
  phone: string
  email?: string | null
  company?: string | null
  title?: string | null
  timezone?: string | null
  source?: string | null
  valueCents?: number | null
  stage?: LeadStage
  score?: number
  agentTimezone?: string
}

export async function createLead(db: Db, input: CreateLeadInput) {
  const phone = requirePhone(input.phone)
  const valueCents = Math.max(0, Math.round(input.valueCents ?? 0))
  const stage = input.stage ?? LeadStage.new

  const score =
    input.score ??
    scoreLead({
      email: input.email,
      title: input.title,
      company: input.company,
      source: input.source,
      valueCents,
      timezone: input.timezone,
      agentTimezone: input.agentTimezone,
    })

  return db.lead.create({
    data: {
      firstName: input.firstName,
      lastName: input.lastName,
      phone,
      phoneRaw: input.phone,
      email: input.email ?? null,
      company: input.company ?? null,
      title: input.title ?? null,
      timezone: input.timezone ?? null,
      source: input.source ?? null,
      valueCents,
      stage,
      score,
      stageLog: { create: { toStage: stage } },
    },
  })
}

export interface UpdateLeadInput {
  firstName?: string
  lastName?: string
  email?: string | null
  company?: string | null
  title?: string | null
  timezone?: string | null
  source?: string | null
  valueCents?: number | null
  phone?: string
  stage?: LeadStage
  score?: number
}

/**
 * Applies a partial update. A stage change always writes an audit row in the
 * same transaction, so the kanban history can never drift from the lead.
 */
export async function updateLead(db: Db, id: string, input: UpdateLeadInput) {
  const existing = await db.lead.findUnique({ where: { id } })
  if (!existing) throw notFound('Lead')

  const data: Record<string, unknown> = {}

  for (const key of ['firstName', 'lastName', 'email', 'company', 'title', 'timezone', 'source'] as const) {
    if (input[key] !== undefined) data[key] = input[key]
  }

  if (input.valueCents !== undefined) {
    data.valueCents = Math.max(0, Math.round(input.valueCents ?? 0))
  }

  if (input.phone !== undefined) {
    data.phone = requirePhone(input.phone)
    data.phoneRaw = input.phone
  }

  if (input.score !== undefined) {
    data.score = Math.max(0, Math.min(100, Math.round(input.score)))
  } else if (
    input.valueCents !== undefined ||
    input.email !== undefined ||
    input.company !== undefined ||
    input.title !== undefined ||
    input.source !== undefined ||
    input.timezone !== undefined
  ) {
    // Re-score when any scoring input moved, unless the caller pinned a score.
    data.score = scoreLead({
      email: input.email ?? existing.email,
      title: input.title ?? existing.title,
      company: input.company ?? existing.company,
      source: input.source ?? existing.source,
      valueCents: input.valueCents ?? existing.valueCents,
      timezone: input.timezone ?? existing.timezone,
    })
  }

  const stageChanged = input.stage !== undefined && input.stage !== existing.stage
  if (stageChanged) {
    data.stage = input.stage
  }

  return db.$transaction(async (tx) => {
    const lead = await tx.lead.update({ where: { id }, data })

    if (stageChanged) {
      await tx.stageChange.create({
        data: { leadId: id, fromStage: existing.stage, toStage: input.stage! },
      })
    }

    return lead
  })
}

export async function deleteLead(db: Db, id: string): Promise<void> {
  const existing = await db.lead.findUnique({ where: { id }, select: { id: true } })
  if (!existing) throw notFound('Lead')
  // Notes, calls, events and stage history cascade in the schema.
  await db.lead.delete({ where: { id } })
}

/** Rejects bulk deletes that would remove more than the caller expects. */
export const BULK_LIMIT = 500

export async function bulkDeleteLeads(db: Db, ids: string[]): Promise<number> {
  if (ids.length > BULK_LIMIT) {
    throw conflict(`Cannot delete more than ${BULK_LIMIT} leads in one request`)
  }
  const result = await db.lead.deleteMany({ where: { id: { in: ids } } })
  return result.count
}
