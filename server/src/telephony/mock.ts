import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { CallEvents, type CredentialsStatus, type InitiateCallInput, type InitiateCallResult, type ProviderEvent, type TelephonyProvider } from './provider.js'

/**
 * Deterministic in-memory telephony provider.
 *
 * Two jobs:
 *  - Make the whole application runnable, and demoable, with zero credentials.
 *  - Make tests deterministic. The outcome of a call is derived from a hash of
 *    its idempotency key, so the same call always produces the same sequence of
 *    events. No timers, no flakiness, no sleeping in tests.
 *
 * Timers are not used to "play out" a call. The mock publishes events on demand
 * through `advance()`, which the test harness and the demo endpoint both drive
 * explicitly.
 */

const OUTCOMES = [
  CallEvents.Answered,
  CallEvents.Answered,
  CallEvents.Answered,
  CallEvents.Answered,
  CallEvents.Voicemail,
  CallEvents.NoAnswer,
  CallEvents.Busy,
  CallEvents.Rejected,
] as const

export type MockOutcome = (typeof OUTCOMES)[number]

function hashToInt(input: string): number {
  return createHash('sha256').update(input).digest().readUInt32BE(0)
}

interface MockCall {
  providerCallId: string
  input: InitiateCallInput
  outcome: MockOutcome
  cursor: number
  /** Set once a terminal event has been emitted, so nothing follows it. */
  finished: boolean
  startedAt: Date
}

export class MockTelephonyProvider extends EventEmitter implements TelephonyProvider {
  readonly name = 'mock'

  #calls = new Map<string, MockCall>()
  #byIdempotency = new Map<string, string>()
  #callerIds = ['+14155550100', '+12125550147', '+46855556420', '+442038684712']

  isConfigured(): boolean {
    return true
  }

  async verifyCredentials(): Promise<CredentialsStatus> {
    return {
      ok: true,
      detail: 'Mock provider — no credentials required, calls are simulated in-process.',
      callerIds: [...this.#callerIds],
    }
  }

  async listCallerIds(): Promise<string[]> {
    return [...this.#callerIds]
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    // Idempotency: the same call row must never produce two provider calls.
    const existingId = this.#byIdempotency.get(input.idempotencyKey)
    if (existingId) {
      return { providerCallId: existingId, initialStatus: 'initiated', raw: { idempotent: true } }
    }

    const providerCallId = `mock_${hashToInt(input.idempotencyKey).toString(36)}`
    const outcome = OUTCOMES[hashToInt(input.idempotencyKey + input.to) % OUTCOMES.length]!

    this.#calls.set(providerCallId, {
      providerCallId,
      input,
      outcome,
      cursor: 0,
      finished: false,
      startedAt: new Date(),
    })
    this.#byIdempotency.set(input.idempotencyKey, providerCallId)

    // No event is emitted here. The caller persists the `initiated` record and
    // stamps the provider id inside a transaction, and an event emitted before
    // that commit could not be correlated back to a call row.
    return { providerCallId, initialStatus: 'ringing', raw: { outcome } }
  }

  async hangup(providerCallId: string): Promise<void> {
    const call = this.#calls.get(providerCallId)
    if (!call) return
    this.emit('event', this.#event(providerCallId, CallEvents.Hangup))
  }

  /**
   * Emits the next event for a call, following a realistic progression:
   *   answered  → answered → completed
   *   otherwise → voicemail | no_answer | busy | rejected   (call ends here)
   * Returns null once the call has reached a terminal state.
   */
  advance(providerCallId: string): ProviderEvent | null {
    const call = this.#calls.get(providerCallId)
    if (!call || call.finished) return null

    let event: ProviderEvent

    if (call.cursor === 0) {
      if (call.outcome === CallEvents.Answered) {
        // Still in progress: the call ends on the next advance.
        event = this.#event(providerCallId, CallEvents.Answered)
        call.cursor = 1
      } else {
        // A terminal outcome ends the call immediately.
        event = this.#event(providerCallId, call.outcome)
        call.finished = true
      }
    } else {
      event = this.#event(providerCallId, CallEvents.Completed, {
        durationSec: 17 + (hashToInt(providerCallId) % 300),
        recordingUrl: `https://recordings.example/${providerCallId}.mp3`,
      })
      call.finished = true
    }

    this.emit('event', event)
    return event
  }

  /** Drives a call all the way to its terminal state. Test/demo convenience. */
  advanceToCompletion(providerCallId: string): ProviderEvent[] {
    const emitted: ProviderEvent[] = []
    for (;;) {
      const next = this.advance(providerCallId)
      if (!next) break
      emitted.push(next)
    }
    return emitted
  }

  parseWebhook(
    _headers: Record<string, string | string[] | undefined>,
    raw: unknown,
  ): ProviderEvent[] {
    // The mock has no real webhook endpoint; tests inject events directly.
    if (raw && typeof raw === 'object' && 'events' in raw) {
      const events = (raw as { events: unknown[] }).events
      return events
        .map((e) => {
          const rec = e as { type?: string; providerCallId?: string }
          if (!rec.type || !rec.providerCallId) return null
          return this.#event(rec.providerCallId, rec.type)
        })
        .filter((e): e is ProviderEvent => e !== null)
    }
    return []
  }

  /** Test seam: the outcome a given number will produce. */
  outcomeFor(input: { idempotencyKey: string; to: string }): MockOutcome {
    return OUTCOMES[hashToInt(input.idempotencyKey + input.to) % OUTCOMES.length]!
  }

  #event(
    providerCallId: string,
    type: string,
    extra: Partial<ProviderEvent> = {},
  ): ProviderEvent {
    return {
      type,
      providerCallId,
      occurredAt: new Date(),
      raw: { mock: true, ...extra },
      ...extra,
    }
  }
}
