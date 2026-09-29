/**
 * Telephony provider contract.
 *
 * Everything above this line (routes, call state machine, persistence) is
 * provider-agnostic. Swapping in a real carrier means implementing this
 * interface and registering it in ./index.ts — no route or schema changes.
 *
 * Two rules the rest of the server relies on:
 *  1. `initiateCall` must be idempotent for a given `idempotencyKey`, so a
 *     client retry can never place a second real call.
 *  2. Providers never invent terminal states on their own. They report what
 *     happened via `parseWebhook`; the state machine in ../services/calls.ts
 *     decides what is legal.
 */

export type CallMode = 'callback' | 'voip'

export interface InitiateCallInput {
  /** Our own call row id — used as the provider's idempotency key. */
  idempotencyKey: string
  to: string
  mode: CallMode
  /** Number presented to the lead. */
  callerId: string
  /** Number that should ring first in callback mode (the agent's phone). */
  agentPhone?: string
  timeoutSec?: number
  record?: boolean
  metadata?: Record<string, string | undefined>
}

export interface InitiateCallResult {
  providerCallId: string
  /** Status the provider believes the call is in immediately after handoff. */
  initialStatus: 'initiated' | 'ringing'
  raw: unknown
}

export interface ProviderEvent {
  /** Normalised event name: call.ringing | call.answered | call.completed ... */
  type: string
  providerCallId: string
  occurredAt: Date
  durationSec?: number
  recordingUrl?: string
  sipLeg?: string
  raw: unknown
}

export interface CredentialsStatus {
  ok: boolean
  /** Non-secret, safe to surface in the settings UI. */
  detail: string
  callerIds?: string[]
  expiresAt?: Date
}

export interface TelephonyProvider {
  readonly name: string

  /** True when credentials are present. The API surfaces this, never the secret. */
  isConfigured(): boolean

  verifyCredentials(): Promise<CredentialsStatus>

  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>

  hangup(providerCallId: string): Promise<void>

  /** Numbers available to present as caller ID. */
  listCallerIds(): Promise<string[]>

  /** Translate a raw webhook body into normalised events. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, raw: unknown): ProviderEvent[]
}

/** Canonical event names. Keep in sync with CallStatus in the schema. */
export const CallEvents = {
  Initiated: 'call.initiated',
  Ringing: 'call.ringing',
  Answered: 'call.answered',
  Completed: 'call.completed',
  Failed: 'call.failed',
  NoAnswer: 'call.no_answer',
  Busy: 'call.busy',
  Rejected: 'call.rejected',
  Voicemail: 'call.voicemail',
  Canceled: 'call.canceled',
  Hangup: 'call.hangup',
} as const

export type CallEventName = (typeof CallEvents)[keyof typeof CallEvents]
