import { config } from '../config/env.js'
import { providerError } from '../lib/errors.js'
import { normalizePhone } from '../lib/phone.js'
import { CallEvents, type CredentialsStatus, type InitiateCallInput, type InitiateCallResult, type ProviderEvent, type TelephonyProvider } from './provider.js'

/**
 * Sonetel adapter.
 *
 * ── Honest status of this file ────────────────────────────────────────────
 * The wiring below is real, but it was written without access to Sonetel's
 * live API or your credentials, so the exact request/response shapes are
 * inferred from the two facts the product surface already tells us:
 *
 *   1. Token endpoint is `POST {base}/api/token` using OAuth2
 *      password-grant (`grant_type=password`, with `client_id` and `scope`).
 *   2. The account exposes a list of caller IDs that can be presented on
 *      outbound PSTN legs.
 *
 * Everything the app depends on — auth, idempotency, error translation,
 * webhook normalisation — is implemented and will not need rewriting. What you
 * must confirm against Sonetel's current docs is marked `CONFIRM` below. Run
 * the server with TELEPHONY_PROVIDER=sonetel and `npm test` to exercise this
 * path against a recorded fixture before going live.
 * ──────────────────────────────────────────────────────────────────────────
 */

interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  scope?: string
  caller_ids?: string[] // CONFIRM: some providers return these inline
}

export class SonetelProvider implements TelephonyProvider {
  readonly name = 'sonetel'

  #token: { value: string; expiresAt: number } | null = null

  isConfigured(): boolean {
    return Boolean(
      config.SONETEL_CLIENT_ID &&
        config.SONETEL_CLIENT_SECRET &&
        config.SONETEL_USERNAME &&
        config.SONETEL_PASSWORD,
    )
  }

  async verifyCredentials(): Promise<CredentialsStatus> {
    if (!this.isConfigured()) {
      return { ok: false, detail: 'Sonetel credentials are not configured.' }
    }
    try {
      const token = await this.#authenticate()
      const callerIds = await this.listCallerIds()
      return {
        ok: true,
        detail: 'Authenticated against Sonetel.',
        callerIds,
        expiresAt: new Date(token.expiresAt),
      }
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'Authentication failed.',
      }
    }
  }

  async #authenticate(): Promise<{ value: string; expiresAt: number }> {
    // Reuse a cached token for 60s less than its real lifetime to avoid racing
    // the expiry boundary under concurrent requests.
    if (this.#token && this.#token.expiresAt - 60_000 > Date.now()) {
      return this.#token
    }

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: config.SONETEL_CLIENT_ID,
      client_secret: config.SONETEL_CLIENT_SECRET,
      username: config.SONETEL_USERNAME,
      password: config.SONETEL_PASSWORD,
      scope: 'call',
    })

    const res = await this.#request('/api/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
    })

    if (!res.ok) {
      throw providerError('Sonetel authentication failed', {
        status: res.status,
        // Never echo the submitted credentials back.
        body: await safeText(res),
      })
    }

    const json = (await res.json()) as TokenResponse
    if (!json.access_token) {
      throw providerError('Sonetel returned no access_token')
    }

    const expiresInMs = (json.expires_in ?? 3600) * 1000
    this.#token = { value: json.access_token, expiresAt: Date.now() + expiresInMs }
    return this.#token
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const token = await this.#authenticate()
    const to = normalizePhone(input.to)
    if (!to.ok) throw providerError(to.reason)

    const body = {
      // CONFIRM: Sonetel's dial endpoint and field names.
      to: to.e164,
      from: input.callerId,
      mode: input.mode,
      timeout: input.timeoutSec ?? 30,
      record: input.record ?? true,
      // Our own id, echoed back on every webhook so we can correlate events
      // without relying on a lookup table.
      clientReference: input.idempotencyKey,
      ...(input.mode === 'callback' && input.agentPhone
        ? { agentNumber: input.agentPhone } // CONFIRM: callback-mode field.
        : {}),
    }

    const res = await this.#request('/api/calls', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.value}`,
        'content-type': 'application/json',
        accept: 'application/json',
        // Native idempotency header; harmless if Sonetel ignores it, and the
        // clientReference lookup covers us if they do.
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw providerError('Sonetel rejected the call', {
        status: res.status,
        body: await safeText(res),
      })
    }

    const json = (await res.json()) as { id?: string; call_id?: string; status?: string }
    const providerCallId = json.id ?? json.call_id
    if (!providerCallId) {
      throw providerError('Sonetel returned no call id', json)
    }

    return {
      providerCallId: String(providerCallId),
      initialStatus: json.status === 'ringing' ? 'ringing' : 'initiated',
      raw: json,
    }
  }

  async hangup(providerCallId: string): Promise<void> {
    const token = await this.#authenticate()
    const res = await this.#request(`/api/calls/${encodeURIComponent(providerCallId)}/hangup`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.value}`, accept: 'application/json' },
    })
    if (!res.ok && res.status !== 404) {
      throw providerError('Sonetel hangup failed', { status: res.status })
    }
  }

  async listCallerIds(): Promise<string[]> {
    const token = await this.#authenticate()
    const res = await this.#request('/api/caller-ids', {
      headers: { authorization: `Bearer ${token.value}`, accept: 'application/json' },
    })
    if (!res.ok) {
      throw providerError('Could not list Sonetel caller IDs', { status: res.status })
    }
    const json = (await res.json()) as
      | { caller_ids?: Array<string | { number: string }> }
      | Array<string | { number: string }>
    const raw = Array.isArray(json) ? json : (json.caller_ids ?? [])
    return raw
      .map((entry) => (typeof entry === 'string' ? entry : entry.number))
      .filter((v): v is string => typeof v === 'string')
  }

  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    raw: unknown,
  ): ProviderEvent[] {
    // CONFIRM: signature scheme. Until you tell me how Sonetel signs payloads,
    // this verifies only presence of a plausible event shape. The route layer
    // still requires the shared API key, so this is not an open endpoint.
    const body = raw as
      | { event?: string; call_id?: string; id?: string; status?: string; duration?: number; recording_url?: string; sip_leg?: string; timestamp?: string }
      | null

    if (!body || typeof body !== 'object') return []
    const providerCallId = body.call_id ?? body.id
    if (!providerCallId) return []

    const type = mapSonetelEvent(body.event ?? body.status)
    if (!type) return []

    void headers
    return [
      {
        type,
        providerCallId: String(providerCallId),
        occurredAt: body.timestamp ? new Date(body.timestamp) : new Date(),
        ...(typeof body.duration === 'number' ? { durationSec: body.duration } : {}),
        ...(body.recording_url ? { recordingUrl: body.recording_url } : {}),
        ...(body.sip_leg ? { sipLeg: body.sip_leg } : {}),
        raw: body,
      },
    ]
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, config.SONETEL_BASE_URL).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw providerError('Sonetel request timed out', { url })
      }
      throw providerError('Could not reach Sonetel', {
        url,
        cause: err instanceof Error ? err.message : String(err),
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}

function mapSonetelEvent(raw: string | undefined): string | null {
  if (!raw) return null
  const key = raw.toLowerCase().replace(/[.\-_]/g, '_')
  switch (key) {
    case 'initiated':
    case 'queued':
      return CallEvents.Initiated
    case 'ringing':
    case 'in_progress':
      return CallEvents.Ringing
    case 'answered':
    case 'connected':
      return CallEvents.Answered
    case 'completed':
    case 'finished':
      return CallEvents.Completed
    case 'failed':
    case 'error':
      return CallEvents.Failed
    case 'no_answer':
    case 'noanswer':
    case 'unanswered':
      return CallEvents.NoAnswer
    case 'busy':
      return CallEvents.Busy
    case 'rejected':
    case 'canceled':
    case 'cancelled':
      return CallEvents.Canceled
    case 'voicemail':
      return CallEvents.Voicemail
    default:
      return null
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.slice(0, 500)
  } catch {
    return '<unreadable>'
  }
}
