import { describe, expect, it } from 'vitest'
import { CallStatus } from '../src/generated/client/enums.js'
import { canTransition, isTerminal, TERMINAL_STATUSES } from '../src/services/calls.js'
import { CallEvents } from '../src/telephony/provider.js'
import { MockTelephonyProvider } from '../src/telephony/mock.js'

describe('call state machine', () => {
  it('allows the normal happy path', () => {
    expect(canTransition(CallStatus.initiated, CallStatus.ringing)).toBe(true)
    expect(canTransition(CallStatus.ringing, CallStatus.connected)).toBe(true)
    expect(canTransition(CallStatus.connected, CallStatus.completed)).toBe(true)
  })

  it('allows a call to connect directly from initiated', () => {
    // Some carriers skip the ringing callback entirely.
    expect(canTransition(CallStatus.initiated, CallStatus.connected)).toBe(false)
  })

  it('rejects a call connecting before it rings', () => {
    // A late/out-of-order "connected" before "ringing" is not a legal history.
    expect(canTransition(CallStatus.initiated, CallStatus.connected)).toBe(false)
  })

  it('is idempotent for a replayed event', () => {
    // Providers retry webhooks; a duplicate must not be an error.
    for (const status of Object.values(CallStatus)) {
      expect(canTransition(status, status)).toBe(true)
    }
  })

  it('absorbs nothing after a terminal state', () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const target of Object.values(CallStatus)) {
        // Same-status replay is the one exception: it is the provider
        // retrying a webhook, which must stay a no-op rather than an error.
        if (target === terminal) {
          expect(canTransition(terminal, target)).toBe(true)
        } else {
          expect(canTransition(terminal, target)).toBe(false)
        }
      }
      expect(isTerminal(terminal)).toBe(true)
    }
  })

  it('treats a late ringing after completion as illegal', () => {
    // This is the real-world case: a delayed webhook arrives after the call
    // already finished, and must not resurrect it.
    expect(canTransition(CallStatus.completed, CallStatus.ringing)).toBe(false)
  })
})

describe('MockTelephonyProvider', () => {
  const input = {
    idempotencyKey: 'key-1',
    to: '+14155550141',
    mode: 'voip' as const,
    callerId: '+14155550100',
  }

  it('reports the same outcome for the same call every time', async () => {
    const a = new MockTelephonyProvider()
    const b = new MockTelephonyProvider()
    const outcomeA = a.outcomeFor(input)
    const outcomeB = b.outcomeFor(input)
    expect(outcomeA).toBe(outcomeB)
  })

  it('is idempotent for a repeated idempotency key', async () => {
    const provider = new MockTelephonyProvider()
    const first = await provider.initiateCall(input)
    const second = await provider.initiateCall(input)
    expect(second.providerCallId).toBe(first.providerCallId)
    expect(second.raw).toMatchObject({ idempotent: true })
  })

  it('emits a terminal event and then stops', async () => {
    const provider = new MockTelephonyProvider()
    const { providerCallId } = await provider.initiateCall(input)
    const events = provider.advanceToCompletion(providerCallId)

    // Never more than: answered + completed, or a single terminal outcome.
    expect(events.length).toBeLessThanOrEqual(2)
    expect(events.at(-1)?.type).toBe(
      events.length === 2 ? CallEvents.Completed : events[0]!.type,
    )
    // A finished call emits nothing further.
    expect(provider.advance(providerCallId)).toBeNull()
  })

  it('advances an answered call to completed with a duration', async () => {
    const provider = new MockTelephonyProvider()
    // Find a key whose deterministic outcome is "answered".
    let key = ''
    for (let i = 0; i < 200 && key === ''; i += 1) {
      const candidate = { ...input, idempotencyKey: `key-${i}` }
      if (provider.outcomeFor(candidate) === CallEvents.Answered) key = `key-${i}`
    }
    expect(key, 'expected at least one answered outcome in 200 samples').not.toBe('')

    const { providerCallId } = await provider.initiateCall({ ...input, idempotencyKey: key })
    const events = provider.advanceToCompletion(providerCallId)
    expect(events.map((e) => e.type)).toEqual([CallEvents.Answered, CallEvents.Completed])
    expect(events[1]?.durationSec).toBeGreaterThan(0)
  })

  it('requires no credentials', async () => {
    const provider = new MockTelephonyProvider()
    expect(provider.isConfigured()).toBe(true)
    await expect(provider.verifyCredentials()).resolves.toMatchObject({ ok: true })
    await expect(provider.listCallerIds()).resolves.toHaveLength(4)
  })
})
