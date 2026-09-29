import type { Db } from '../db.js'
import { CallMode, CallStatus, LeadStage } from '../generated/client/enums.js'
import { CallEvents, type ProviderEvent, type TelephonyProvider } from '../telephony/provider.js'
import { badRequest, notFound } from '../lib/errors.js'
import type { InitiateCallInput } from '../telephony/provider.js'

/**
 * Call lifecycle.
 *
 * Webhooks arrive out of order, get retried by providers, and can contradict
 * each other (a late `ringing` after `completed`, two `completed` for one call).
 * Every event therefore passes through an explicit legality table, and all
 * persistence for an event happens in one transaction. A rejected event is
 * still recorded, as a `call_event` with its raw payload, so the discrepancy is
 * auditable rather than silently dropped.
 */

const EVENT_TO_STATUS: Record<string, CallStatus> = {
  [CallEvents.Initiated]: CallStatus.initiated,
  [CallEvents.Ringing]: CallStatus.ringing,
  [CallEvents.Answered]: CallStatus.connected,
  [CallEvents.Completed]: CallStatus.completed,
  [CallEvents.Failed]: CallStatus.failed,
  [CallEvents.NoAnswer]: CallStatus.no_answer,
  [CallEvents.Busy]: CallStatus.busy,
  [CallEvents.Rejected]: CallStatus.rejected,
  [CallEvents.Voicemail]: CallStatus.voicemail,
  [CallEvents.Canceled]: CallStatus.canceled,
  [CallEvents.Hangup]: CallStatus.completed,
}

/** Which statuses may follow which. Anything absent is rejected. */
const TRANSITIONS: Record<CallStatus, CallStatus[]> = {
  [CallStatus.initiated]: [CallStatus.ringing, CallStatus.canceled, CallStatus.failed],
  [CallStatus.ringing]: [
    CallStatus.connected,
    CallStatus.no_answer,
    CallStatus.busy,
    CallStatus.rejected,
    CallStatus.voicemail,
    CallStatus.canceled,
    CallStatus.failed,
  ],
  [CallStatus.connected]: [CallStatus.completed, CallStatus.failed, CallStatus.canceled],
  // Terminal states absorb nothing. Repeated webhooks are the common case.
  [CallStatus.completed]: [],
  [CallStatus.failed]: [],
  [CallStatus.no_answer]: [],
  [CallStatus.busy]: [],
  [CallStatus.rejected]: [],
  [CallStatus.voicemail]: [],
  [CallStatus.canceled]: [],
}

export const TERMINAL_STATUSES: CallStatus[] = [
  CallStatus.completed,
  CallStatus.failed,
  CallStatus.no_answer,
  CallStatus.busy,
  CallStatus.rejected,
  CallStatus.voicemail,
  CallStatus.canceled,
]

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  if (from === to) return true // idempotent replay
  return TRANSITIONS[from].includes(to)
}

/**
 * Stage the lead moves to automatically when a call reaches a given state.
 *
 * Note what is deliberately *absent*: no carrier-level event ever marks a lead
 * `lost`. A rejected or failed call is a fact about the phone line, not about
 * the deal — auto-writing "lost" on a network hiccup silently deletes real
 * pipeline and corrupts the forecast. Losing a lead is an agent decision, made
 * explicitly through a disposition.
 */
const STAGE_ON_STATUS: Partial<Record<CallStatus, LeadStage>> = {
  [CallStatus.no_answer]: LeadStage.attempted,
  [CallStatus.busy]: LeadStage.attempted,
  [CallStatus.rejected]: LeadStage.attempted,
  [CallStatus.failed]: LeadStage.attempted,
  [CallStatus.canceled]: LeadStage.attempted,
  [CallStatus.voicemail]: LeadStage.followup,
  [CallStatus.connected]: LeadStage.connected,
}

export interface InitiateOptions {
  leadId: string
  mode: CallMode
  provider: TelephonyProvider
  callerId: string
  agentPhone?: string
  record?: boolean
  timeoutSec?: number
}

export async function initiateCall(db: Db, opts: InitiateOptions) {
  const lead = await db.lead.findUnique({ where: { id: opts.leadId } })
  if (!lead) throw notFound('Lead')

  // One live call per lead. Without this, a double-click on "Dial" places two
  // real calls to the same person.
  const live = await db.call.findFirst({
    where: {
      leadId: lead.id,
      status: { in: [CallStatus.initiated, CallStatus.ringing, CallStatus.connected] },
    },
    select: { id: true, status: true },
  })
  if (live) {
    throw badRequest(`Lead already has a call in progress (${live.status})`, {
      callId: live.id,
    })
  }

  // Reserve the row first so the idempotency key exists before we call out.
  const call = await db.call.create({
    data: {
      leadId: lead.id,
      mode: opts.mode,
      status: CallStatus.initiated,
      recordingUrl: null,
    },
  })

  try {
    const result = await opts.provider.initiateCall({
      idempotencyKey: call.id,
      to: lead.phone,
      mode: opts.mode,
      callerId: opts.callerId,
      agentPhone: opts.agentPhone,
      record: opts.record,
      timeoutSec: opts.timeoutSec,
    } satisfies InitiateCallInput)

    const initial = result.initialStatus === 'ringing' ? CallStatus.ringing : CallStatus.initiated

    return await db.$transaction(async (tx) => {
      const updated = await tx.call.update({
        where: { id: call.id },
        data: { providerCallId: result.providerCallId, status: initial },
      })
      await tx.callEvent.create({
        data: {
          callId: call.id,
          type: CallEvents.Initiated,
          payload: result.raw as never,
        },
      })
      return updated
    })
  } catch (err) {
    // Never leave a dangling `initiated` row if the provider rejected the call.
    await db.call.update({
      where: { id: call.id },
      data: { status: CallStatus.failed, endedAt: new Date() },
    })
    await db.callEvent.create({
      data: {
        callId: call.id,
        type: CallEvents.Failed,
        payload: { error: err instanceof Error ? err.message : String(err) } as never,
      },
    })
    throw err
  }
}

export interface ApplyEventResult {
  callId: string
  status: CallStatus
  applied: boolean
  reason?: string
}

/**
 * Applies one provider event. Idempotent: replaying an event that does not
 * advance the state machine is a no-op, not an error, because providers retry.
 */
export async function applyProviderEvent(
  db: Db,
  event: ProviderEvent,
): Promise<ApplyEventResult> {
  const target = EVENT_TO_STATUS[event.type]
  if (!target) {
    return { callId: '', status: CallStatus.failed, applied: false, reason: `unknown event ${event.type}` }
  }

  const call = await db.call.findFirst({ where: { providerCallId: event.providerCallId } })
  if (!call) {
    return { callId: '', status: target, applied: false, reason: 'no call matches providerCallId' }
  }

  if (!canTransition(call.status, target)) {
    // Record the contradiction, then leave the truth untouched.
    await db.callEvent.create({
      data: {
        callId: call.id,
        type: event.type,
        payload: { ignored: true, reason: `illegal transition ${call.status} -> ${target}`, ...(event.raw as object) } as never,
      },
    })
    return {
      callId: call.id,
      status: call.status,
      applied: false,
      reason: `illegal transition ${call.status} -> ${target}`,
    }
  }

  const now = event.occurredAt

  return await db.$transaction(async (tx) => {
    const isAnswer = target === CallStatus.connected
    const ending = isTerminal(target)

    const updated = await tx.call.update({
      where: { id: call.id },
      data: {
        status: target,
        ...(isAnswer && !call.answeredAt ? { answeredAt: now } : {}),
        ...(ending ? { endedAt: now } : {}),
        ...(event.durationSec !== undefined ? { durationSec: event.durationSec } : {}),
        ...(event.recordingUrl ? { recordingUrl: event.recordingUrl } : {}),
        ...(event.sipLeg ? { sipLeg: event.sipLeg } : {}),
      },
    })

    await tx.callEvent.create({
      data: { callId: call.id, type: event.type, payload: event.raw as never, occurredAt: now },
    })

    // The lead is "last called" from the moment the call starts, not when it
    // ends, so the queue does not re-offer someone mid-ring.
    await tx.lead.update({
      where: { id: call.leadId },
      data: { lastCalled: call.startedAt },
    })

    const nextStage = STAGE_ON_STATUS[target]
    if (nextStage) {
      const lead = await tx.lead.findUnique({
        where: { id: call.leadId },
        select: { stage: true },
      })
      // Never drag a lead backwards out of a closed stage.
      if (lead && lead.stage !== nextStage && !isClosedStage(lead.stage)) {
        await tx.lead.update({
          where: { id: call.leadId },
          data: { stage: nextStage },
        })
        await tx.stageChange.create({
          data: {
            leadId: call.leadId,
            fromStage: lead.stage,
            toStage: nextStage,
          },
        })
      }
    }

    return { callId: call.id, status: updated.status, applied: true }
  })
}

function isClosedStage(stage: LeadStage): boolean {
  return stage === LeadStage.won || stage === LeadStage.lost
}

export async function hangupCall(db: Db, callId: string, provider: TelephonyProvider) {
  const call = await db.call.findUnique({ where: { id: callId } })
  if (!call) throw notFound('Call')
  if (isTerminal(call.status)) return call

  if (call.providerCallId) {
    await provider.hangup(call.providerCallId)
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.call.update({
      where: { id: callId },
      data: { status: CallStatus.completed, endedAt: new Date() },
    })
    await tx.callEvent.create({ data: { callId, type: CallEvents.Hangup } })
    return updated
  })
}

export interface CompleteCallInput {
  disposition?: string | null
  note?: string | null
  durationSec?: number
  stage?: LeadStage
}

const DISPOSITIONS = new Set([
  'Connected',
  'Voicemail',
  'No_Answer',
  'Busy',
  'Wrong_Number',
  'Not_Interested',
  'Callback',
  'Follow_Up',
  'Qualified',
  'Gatekeeper',
  'Sale',
])

/** Agent-initiated wrap-up: records the outcome and optionally moves the lead. */
export async function completeCall(db: Db, callId: string, input: CompleteCallInput) {
  const call = await db.call.findUnique({ where: { id: callId }, include: { lead: true } })
  if (!call) throw notFound('Call')

  if (input.disposition && !DISPOSITIONS.has(input.disposition)) {
    throw badRequest(`Unknown disposition "${input.disposition}"`, {
      allowed: [...DISPOSITIONS],
    })
  }

  const now = new Date()
  const duration =
    input.durationSec ??
    (call.answeredAt ? Math.max(0, Math.round((now.getTime() - call.answeredAt.getTime()) / 1000)) : call.durationSec)

  return await db.$transaction(async (tx) => {
    const updated = await tx.call.update({
      where: { id: callId },
      data: {
        status: CallStatus.completed,
        endedAt: now,
        durationSec: duration,
        disposition: (input.disposition as never) ?? call.disposition,
        note: input.note ?? call.note,
      },
    })

    await tx.callEvent.create({ data: { callId, type: CallEvents.Completed } })

    if (input.stage && input.stage !== call.lead.stage) {
      await tx.lead.update({ where: { id: call.leadId }, data: { stage: input.stage } })
      await tx.stageChange.create({
        data: { leadId: call.leadId, fromStage: call.lead.stage, toStage: input.stage },
      })
    }

    return updated
  })
}
