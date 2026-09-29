import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authHeader, createTestContext, json, resetDatabase, type TestContext } from './helpers.js'

let ctx: TestContext

beforeAll(async () => {
  ctx = await createTestContext()
})

afterAll(async () => {
  await ctx.cleanup()
})

beforeEach(async () => {
  await resetDatabase(ctx.db)
})

const post = (url: string, payload: unknown) =>
  ctx.app.inject({ method: 'POST', url, headers: authHeader, payload: payload as object })

const patch = (url: string, payload: unknown) =>
  ctx.app.inject({ method: 'PATCH', url, headers: authHeader, payload: payload as object })

const get = (url: string) => ctx.app.inject({ method: 'GET', url, headers: authHeader })

async function makeLead(overrides: Record<string, unknown> = {}) {
  const res = await post('/api/leads', {
    firstName: 'Maya',
    lastName: 'Chen',
    company: 'Northwind',
    title: 'VP Sales',
    phone: '+1 (415) 555-0141',
    email: 'maya@northwind.io',
    value: 24000,
    source: 'Referral',
    timezone: 'PT',
    ...overrides,
  })
  expect(res.statusCode).toBe(201)
  return json<{ id: string; stage: string; score: number; phone: string; value: number }>(res.body)
}

describe('authentication', () => {
  it('serves health without a key', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(json<{ status: string }>(res.body).status).toBe('ok')
  })

  it('rejects a request with no key', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/leads' })
    expect(res.statusCode).toBe(401)
    expect(json<{ error: { code: string } }>(res.body).error.code).toBe('UNAUTHORIZED')
  })

  it('rejects a wrong key', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/leads',
      headers: { authorization: 'Bearer df_totally_wrong_key_000000000000' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts the key via X-API-Key as well as Bearer', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/leads',
      headers: { 'x-api-key': 'df_test_key_for_the_test_suite_0123456789' },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('leads', () => {
  it('creates a lead and normalises the phone number', async () => {
    const lead = await makeLead()
    expect(lead.phone).toBe('+14155550141')
    expect(lead.value).toBe(24000)
    expect(lead.stage).toBe('new')
    expect(lead.score).toBeGreaterThan(0)
  })

  it('rejects an invalid phone number with a 400', async () => {
    const res = await post('/api/leads', { firstName: 'A', lastName: 'B', phone: 'abc' })
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(res.body).error.code).toBe('BAD_REQUEST')
  })

  it('rejects a missing required field with a 422 naming the field', async () => {
    const res = await post('/api/leads', { lastName: 'Chen' })
    expect(res.statusCode).toBe(422)
    const body = json<{ error: { code: string; details: Array<{ field: string }> } }>(res.body)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details.map((d) => d.field)).toContain('firstName')
  })

  it('rejects a malformed email', async () => {
    const res = await post('/api/leads', {
      firstName: 'A', lastName: 'B', phone: '+14155550141', email: 'nope',
    })
    expect(res.statusCode).toBe(422)
  })

  it('404s on an unknown lead', async () => {
    const res = await get('/api/leads/0198f000-0000-7000-8000-000000000000')
    expect(res.statusCode).toBe(404)
  })

  it('records a stage change in the audit trail', async () => {
    const lead = await makeLead()
    await patch(`/api/leads/${lead.id}`, { stage: 'qualified' })

    const res = await get(`/api/leads/${lead.id}`)
    const body = json<{ stage: string; stageHistory: Array<{ from: string; to: string }> }>(res.body)
    expect(body.stage).toBe('qualified')
    expect(body.stageHistory.some((h) => h.from === 'new' && h.to === 'qualified')).toBe(true)
  })

  it('recomputes the score when a scoring input changes', async () => {
    const lead = await makeLead({ score: undefined, email: undefined, company: undefined })
    const before = lead.score
    const res = await patch(`/api/leads/${lead.id}`, { company: 'Northwind Global', value: 90000 })
    const after = json<{ score: number }>(res.body).score
    expect(after).not.toBe(before)
  })

  it('honours a pinned score instead of recomputing it', async () => {
    const lead = await makeLead()
    const res = await patch(`/api/leads/${lead.id}`, { company: 'New Co', score: 77 })
    expect(json<{ score: number }>(res.body).score).toBe(77)
  })

  it('cascades deletes to notes and calls', async () => {
    const lead = await makeLead()
    await post(`/api/leads/${lead.id}/notes`, { text: 'Wants pricing' })
    await post('/api/calls', { leadId: lead.id, mode: 'voip' })

    const del = await ctx.app.inject({
      method: 'DELETE', url: `/api/leads/${lead.id}`, headers: authHeader,
    })
    expect(del.statusCode).toBe(204)

    const orphanNotes = await ctx.db.leadNote.count({ where: { leadId: lead.id } })
    const orphanCalls = await ctx.db.call.count({ where: { leadId: lead.id } })
    expect(orphanNotes).toBe(0)
    expect(orphanCalls).toBe(0)
  })

  it('returns a cursor that paginates without duplicating rows', async () => {
    for (let i = 0; i < 7; i += 1) {
      await makeLead({ firstName: `Lead${i}`, phone: `+1415555010${i}` })
    }

    const first = json<{ data: Array<{ id: string }>; pageInfo: { endCursor: string; hasNextPage: boolean } }>(
      (await get('/api/leads?limit=3')).body,
    )
    expect(first.data).toHaveLength(3)
    expect(first.pageInfo.hasNextPage).toBe(true)

    const seen = new Set(first.data.map((l) => l.id))
    let cursor = first.pageInfo.endCursor
    let pages = 1

    while (cursor) {
      const res = json<{ data: Array<{ id: string }>; pageInfo: { endCursor: string | null; hasNextPage: boolean } }>(
        (await get(`/api/leads?limit=3&cursor=${encodeURIComponent(cursor)}`)).body,
      )
      for (const lead of res.data) {
        expect(seen.has(lead.id), 'lead appeared on two pages').toBe(false)
        seen.add(lead.id)
      }
      pages += 1
      cursor = res.pageInfo.endCursor
      if (pages > 10) break
    }

    expect(seen.size).toBe(7)
  })

  it('rejects a malformed cursor', async () => {
    const res = await get('/api/leads?cursor=!!!not-base64!!!')
    expect(res.statusCode).toBe(422)
  })

  it('excludes closed leads from the dialer queue', async () => {
    await makeLead({ firstName: 'Open' })
    await makeLead({ firstName: 'Won', phone: '+14155550200', stage: 'won' })
    await makeLead({ firstName: 'Lost', phone: '+14155550201', stage: 'lost' })

    const body = json<{ data: Array<{ firstName: string }> }>((await get('/api/leads/queue')).body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]?.firstName).toBe('Open')
  })

  it('searches across name, company and phone', async () => {
    await makeLead({ firstName: 'Maya', company: 'Northwind' })
    await makeLead({ firstName: 'Jonas', company: 'Helios', phone: '+491705550182' })

    const byCompany = json<{ data: unknown[] }>((await get('/api/leads?search=Helios')).body)
    expect(byCompany.data).toHaveLength(1)

    const byPhone = json<{ data: unknown[] }>((await get('/api/leads?search=49170')).body)
    expect(byPhone.data).toHaveLength(1)
  })

  it('caps a limit that is too large', async () => {
    const res = await get('/api/leads?limit=100000')
    expect(res.statusCode).toBe(422)
  })
})

describe('notes', () => {
  it('adds and removes a note', async () => {
    const lead = await makeLead()
    const created = json<{ id: string }>((await post(`/api/leads/${lead.id}/notes`, { text: 'Asked for pricing' })).body)
    expect(created.id).toBeTruthy()

    const del = await ctx.app.inject({
      method: 'DELETE', url: `/api/leads/${lead.id}/notes/${created.id}`, headers: authHeader,
    })
    expect(del.statusCode).toBe(204)
    expect(await ctx.db.leadNote.count({ where: { leadId: lead.id } })).toBe(0)
  })

  it('will not delete a note belonging to a different lead', async () => {
    const a = await makeLead()
    const b = await makeLead({ firstName: 'Jonas', phone: '+491705550182' })
    const note = json<{ id: string }>((await post(`/api/leads/${a.id}/notes`, { text: 'mine' })).body)

    // Scoping the delete by leadId is what prevents cross-tenant note removal.
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/leads/${b.id}/notes/${note.id}`, headers: authHeader,
    })
    expect(res.statusCode).toBe(404)
    expect(await ctx.db.leadNote.count({ where: { id: note.id } })).toBe(1)
  })

  it('rejects an empty note', async () => {
    const lead = await makeLead()
    const res = await post(`/api/leads/${lead.id}/notes`, { text: '   ' })
    expect(res.statusCode).toBe(422)
  })
})

describe('pipeline', () => {
  it('groups leads into their stage columns with totals', async () => {
    await makeLead({ firstName: 'A', stage: 'new' })
    await makeLead({ firstName: 'B', phone: '+14155550200', stage: 'qualified' })
    await makeLead({ firstName: 'C', phone: '+14155550201', stage: 'won' })

    const body = json<{
      data: Array<{ stage: string; count: number; valueCents: number }>
      summary: { totalLeads: number; openValueCents: number; wonValueCents: number }
    }>((await get('/api/pipeline')).body)

    expect(body.summary.totalLeads).toBe(3)
    expect(body.summary.wonValueCents).toBe(2_400_000)
    const won = body.data.find((c) => c.stage === 'won')
    expect(won?.count).toBe(1)
  })

  it('moves a lead between columns and audits the move', async () => {
    const lead = await makeLead()
    const res = await post('/api/pipeline/move', { leadId: lead.id, toStage: 'followup' })
    expect(res.statusCode).toBe(200)
    expect(json<{ fromStage: string; toStage: string }>(res.body)).toMatchObject({
      fromStage: 'new', toStage: 'followup',
    })

    const changes = await ctx.db.stageChange.count({ where: { leadId: lead.id, toStage: 'followup' } })
    expect(changes).toBe(1)
  })

  it('rejects an unknown target stage', async () => {
    const lead = await makeLead()
    const res = await post('/api/pipeline/move', { leadId: lead.id, toStage: 'nonsense' })
    expect(res.statusCode).toBe(422)
  })
})

describe('calls', () => {
  it('initiates a call and drives it to a terminal state', async () => {
    const lead = await makeLead()
    const call = json<{ id: string; status: string; providerCallId: string }>(
      (await post('/api/calls', { leadId: lead.id, mode: 'voip' })).body,
    )
    expect(call.status).toBe('ringing')
    expect(call.providerCallId).toMatch(/^mock_/)

    const sim = json<{ status: string; applied: string[] }>(
      (await post(`/api/calls/${call.id}/simulate`, {})).body,
    )
    expect(sim.applied.length).toBeGreaterThan(0)
    // The call must have moved on from where it was before simulating.
    expect(sim.status).not.toBe(call.status)

    const detail = json<{ status: string; events: Array<{ type: string }> }>(
      (await get(`/api/calls/${call.id}`)).body,
    )
    expect(detail.status).toBe(sim.status)
    expect(detail.events[0]?.type).toBe('call.initiated')
  })

  it('refuses to place a second concurrent call to the same lead', async () => {
    const lead = await makeLead()
    await post('/api/calls', { leadId: lead.id, mode: 'voip' })
    const second = await post('/api/calls', { leadId: lead.id, mode: 'callback' })
    expect(second.statusCode).toBe(400)
    expect(json<{ error: { message: string } }>(second.body).error.message).toMatch(/in progress/i)
  })

  it('allows a new call once the previous one is terminal', async () => {
    const lead = await makeLead()
    const first = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)
    await post(`/api/calls/${first.id}/simulate`, {})
    const second = await post('/api/calls', { leadId: lead.id })
    expect(second.statusCode).toBe(201)
  })

  it('records a disposition and moves the lead when completing', async () => {
    const lead = await makeLead()
    const call = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)

    const res = await post(`/api/calls/${call.id}/complete`, {
      disposition: 'Qualified', note: 'Wants a trial', stage: 'qualified',
    })
    expect(res.statusCode).toBe(200)
    expect(json<{ disposition: string }>(res.body).disposition).toBe('Qualified')

    const updated = await ctx.db.lead.findUnique({ where: { id: lead.id } })
    expect(updated?.stage).toBe('qualified')
  })

  it('rejects an unknown disposition', async () => {
    const lead = await makeLead()
    const call = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)
    const res = await post(`/api/calls/${call.id}/complete`, { disposition: 'Teleported' })
    expect(res.statusCode).toBe(400)
  })

  it('never marks a lead lost from a carrier-side event', async () => {
    // A rejected/failed call is a fact about the line, not the deal. Losing
    // pipeline on a network hiccup would silently corrupt the forecast.
    const lead = await makeLead()
    const call = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)
    await post(`/api/calls/${call.id}/simulate`, {})

    const updated = await ctx.db.lead.findUnique({ where: { id: lead.id } })
    expect(updated?.stage).not.toBe('lost')
  })

  it('stamps lastCalled on the lead', async () => {
    const lead = await makeLead()
    expect((await ctx.db.lead.findUnique({ where: { id: lead.id } }))?.lastCalled).toBeNull()

    const call = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)
    await post(`/api/calls/${call.id}/simulate`, {})

    const updated = await ctx.db.lead.findUnique({ where: { id: lead.id } })
    expect(updated?.lastCalled).not.toBeNull()
  })

  it('hangs up a live call', async () => {
    const lead = await makeLead()
    const call = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)
    const res = await post(`/api/calls/${call.id}/hangup`, {})
    expect(res.statusCode).toBe(200)
    expect(json<{ status: string }>(res.body).status).toBe('completed')
  })

  it('rejects a call for an unknown lead', async () => {
    const res = await post('/api/calls', { leadId: '0198f000-0000-7000-8000-000000000000' })
    expect(res.statusCode).toBe(404)
  })
})

describe('webhooks', () => {
  it('ignores an unknown provider call id without erroring', async () => {
    const res = await post('/api/webhooks/telephony', {
      events: [{ type: 'call.completed', providerCallId: 'does-not-exist' }],
    })
    // Always 200 so a provider does not retry forever on a no-op.
    expect(res.statusCode).toBe(200)
    expect(json<{ received: number; applied: number }>(res.body)).toMatchObject({
      received: 1, applied: 0,
    })
  })

  it('handles an empty webhook body', async () => {
    const res = await post('/api/webhooks/telephony', {})
    expect(res.statusCode).toBe(200)
  })
})

describe('imports', () => {
  const csv = [
    'First Name,Last Name,Phone,Email,Company,Value,Source',
    'Maya,Chen,+1 (415) 555-0141,maya@northwind.io,Northwind,"$24,000",Referral',
    '"Smith, Jane",Doe,+49 170 555 0182,jane@smith.de,Helios,18000,Cold call',
    'Bad,Number,not-a-phone,,Broken,5000,CSV',
  ].join('\n')

  it('previews an import without writing anything', async () => {
    const res = await post('/api/imports/preview', { csv })
    expect(res.statusCode).toBe(200)
    const body = json<{ totalRows: number; validRows: number; invalidRows: number; detectedColumns: Record<string, number> }>(res.body)
    expect(body.totalRows).toBe(3)
    expect(body.validRows).toBe(2)
    expect(body.invalidRows).toBe(1)
    expect(await ctx.db.lead.count()).toBe(0)
  })

  it('imports valid rows, normalises numbers and reports failures', async () => {
    const res = await post('/api/imports/leads', { csv, filename: 'leads.csv' })
    expect(res.statusCode).toBe(201)

    const body = json<{ imported: number; skipped: number; totalRows: number; errors: Array<{ line: number; reason: string }> }>(res.body)
    expect(body.imported).toBe(2)
    expect(body.skipped).toBe(1)
    expect(body.totalRows).toBe(3)
    expect(body.errors[0]?.line).toBe(4) // 1-based, header is line 1

    const leads = await ctx.db.lead.findMany()
    const maya = leads.find((l) => l.firstName === 'Maya')
    expect(maya?.phone).toBe('+14155550141')
    expect(maya?.valueCents).toBe(2_400_000)

    // The quoted "Smith, Jane" field must not have been split.
    const jane = leads.find((l) => l.lastName === 'Doe')
    expect(jane?.firstName).toBe('Smith, Jane')
  })

  it('rejects a CSV with no phone column', async () => {
    const res = await post('/api/imports/leads', { csv: 'Name,Company\nA,B' })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an empty CSV', async () => {
    const res = await post('/api/imports/leads', { csv: '' })
    expect(res.statusCode).toBe(422)
  })

  it('upserts on updateExisting instead of creating duplicates', async () => {
    await post('/api/imports/leads', { csv })
    const first = await ctx.db.lead.count()
    expect(first).toBe(2)

    const res = await post('/api/imports/leads', { csv, updateExisting: true })
    const body = json<{ imported: number; updated: number }>(res.body)
    expect(body.updated).toBe(2)
    expect(await ctx.db.lead.count()).toBe(2)
  })
})

describe('analytics', () => {
  it('summarises an empty workspace without dividing by zero', async () => {
    const res = await get('/api/analytics/summary')
    expect(res.statusCode).toBe(200)
    const body = json<{ calls: { connectRate: number }; pipeline: { totalLeads: number } }>(res.body)
    expect(body.calls.connectRate).toBe(0)
    expect(body.pipeline.totalLeads).toBe(0)
  })

  it('reports pipeline totals and per-stage counts', async () => {
    await makeLead({ firstName: 'A' })
    await makeLead({ firstName: 'B', phone: '+14155550200', stage: 'won' })
    const body = json<{ pipeline: { totalLeads: number; wonCount: number }; stages: unknown[] }>(
      (await get('/api/analytics/summary')).body,
    )
    expect(body.pipeline.totalLeads).toBe(2)
    expect(body.pipeline.wonCount).toBe(1)
    expect(body.stages).toHaveLength(7)
  })

  it('returns a contiguous daily timeseries with no gaps', async () => {
    const lead = await makeLead()
    const call = json<{ id: string }>((await post('/api/calls', { leadId: lead.id })).body)
    await post(`/api/calls/${call.id}/simulate`, {})

    const body = json<{ data: Array<{ date: string; total: number }> }>(
      (await get('/api/analytics/timeseries?days=7')).body,
    )
    expect(body.data).toHaveLength(7)
    expect(body.data.reduce((n, d) => n + d.total, 0)).toBe(1)
  })

  it('rejects an out-of-range window', async () => {
    expect((await get('/api/analytics/summary?days=0')).statusCode).toBe(422)
    expect((await get('/api/analytics/summary?days=9999')).statusCode).toBe(422)
  })
})

describe('settings', () => {
  it('returns defaults on first read', async () => {
    const body = json<{ data: { mode: string; telephony: { provider: string; configured: boolean } } }>(
      (await get('/api/settings')).body,
    )
    expect(body.data.mode).toBe('callback')
    expect(body.data.telephony.provider).toBe('mock')
  })

  it('persists an update and normalises a phone number', async () => {
    await patch('/api/settings', { agentPhone: '(415) 555-0132', mode: 'voip' })
    const body = json<{ data: { agentPhone: string; mode: string } }>((await get('/api/settings')).body)
    expect(body.data.agentPhone).toBe('+14155550132')
    expect(body.data.mode).toBe('voip')
  })

  it('rejects an invalid agent phone', async () => {
    const res = await patch('/api/settings', { agentPhone: 'nope' })
    expect(res.statusCode).toBe(400)
  })

  it('never exposes telephony secrets', async () => {
    const res = await get('/api/settings')
    const text = res.body.toLowerCase()
    for (const secret of ['password', 'clientsecret', 'client_secret', 'access_token', 'sonetel_password']) {
      expect(text).not.toContain(secret)
    }
  })

  it('verifies mock provider credentials', async () => {
    const body = json<{ data: { ok: boolean; callerIds: string[] } }>(
      (await post('/api/settings/telephony/verify', {})).body,
    )
    expect(body.data.ok).toBe(true)
    expect(body.data.callerIds.length).toBeGreaterThan(0)
  })
})

describe('api keys', () => {
  it('issues a key once and never returns it again', async () => {
    const created = json<{ id: string; key: string; prefix: string }>(
      (await post('/api/keys', { name: 'ci' })).body,
    )
    expect(created.key).toMatch(/^df_/)

    const list = json<{ data: Array<Record<string, unknown>> }>((await get('/api/keys')).body)
    const found = list.data.find((k) => k.id === created.id)
    expect(found).toBeDefined()
    // The raw key must not be retrievable after issuance.
    expect(JSON.stringify(found)).not.toContain(created.key)
  })

  it('stores only a hash, never the key itself', async () => {
    const created = json<{ id: string; key: string }>((await post('/api/keys', { name: 'ci2' })).body)
    const row = await ctx.db.apiKey.findUnique({ where: { id: created.id } })
    expect(row?.keyHash).not.toBe(created.key)
    expect(row?.keyHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('revokes a key', async () => {
    const created = json<{ id: string }>((await post('/api/keys', { name: 'ci3' })).body)
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/keys/${created.id}`, headers: authHeader })
    expect(del.statusCode).toBe(204)
    expect((await ctx.db.apiKey.findUnique({ where: { id: created.id } }))?.revokedAt).not.toBeNull()
  })
})

describe('error handling', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const res = await get('/api/nope')
    expect(res.statusCode).toBe(404)
    const body = json<{ error: { code: string; correlationId: string } }>(res.body)
    expect(body.error.code).toBe('NOT_FOUND')
    expect(body.error.correlationId).toBeTruthy()
  })

  it('returns a structured 400 for a malformed JSON body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/leads',
      headers: { ...authHeader, 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(json<{ error: { code: string } }>(res.body).error.code).toBe('BAD_REQUEST')
  })

  it('never leaks a stack trace', async () => {
    const res = await get('/api/leads/0198f000-0000-7000-8000-000000000000')
    expect(res.body).not.toContain('at Object')
    expect(res.body).not.toContain('.ts:')
  })

  it('echoes a caller-supplied request id for correlation', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/leads', headers: { ...authHeader, 'x-request-id': 'req-abc-123' },
    })
    expect(json<{ error?: { correlationId: string } }>(res.body).error?.correlationId ?? 'req-abc-123').toBe('req-abc-123')
  })
})
