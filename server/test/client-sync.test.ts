import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { createPgliteAdapter } from 'prisma-pglite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { PrismaClient } from '../src/generated/client/client.js'
import { MockTelephonyProvider } from '../src/telephony/mock.js'
import { resetDatabase } from './helpers.js'

/**
 * Runs the real browser client (../js/api.js + ../js/sync.js) against a real
 * server over real HTTP.
 *
 * The client files are executed in a vm context with a minimal browser shim,
 * so what is under test is the code the browser actually loads — not a
 * reimplementation of it. Mapping bugs and id-rekeying bugs are exactly the
 * kind that a mocked client test would happily pass.
 */

const here = dirname(fileURLToPath(import.meta.url))
const clientDir = join(here, '..', '..', 'js')

const TEST_KEY = 'df_test_key_for_the_test_suite_0123456789'

let app: Awaited<ReturnType<typeof buildApp>>
let db: PrismaClient
let dir: string
let baseUrl: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dialflow-client-test-'))
  const adapter = await createPgliteAdapter({
    prismaConfigPath: join(process.cwd(), 'prisma.config.ts'),
    dbParentDirPath: dir,
    databaseName: 'test',
  })
  db = new PrismaClient({ adapter })
  app = await buildApp({ db: db as never, provider: new MockTelephonyProvider(), agentTimezone: 'PT', logger: false })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
}, 120_000)

afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await resetDatabase(db)
})

interface SyncModule {
  connect: (key?: string) => Promise<boolean>
  load: () => Promise<{ leads: unknown[]; calls: unknown[] }>
  fromApiLead: (a: Record<string, unknown>) => Record<string, unknown>
  toApiLead: (l: Record<string, unknown>) => Record<string, unknown>
  fromApiCall: (c: Record<string, unknown>) => Record<string, unknown>
  markCreated: (l: unknown) => void
  markDirty: (l: unknown) => void
  markRemoved: (id: string) => void
  queueNote: (leadId: string, text: string) => void
  queueCall: (p: unknown) => void
  flush: () => Promise<unknown>
  setHooks: (h: unknown) => void
  onStatus: (fn: unknown) => void
  api: { setKey: (k: string) => void; baseUrl: string; getKey: () => string }
  state: { online: boolean }
}

/** Loads the unmodified client sources into a vm sandbox. */
function loadClient(): SyncModule {
  const store = new Map<string, string>()
  const sandbox: Record<string, unknown> = {
    console,
    fetch,
    AbortController,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    Promise,
    Date,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Error,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(join(clientDir, 'api.js'), 'utf8'), sandbox, { filename: 'api.js' })
  vm.runInContext(readFileSync(join(clientDir, 'sync.js'), 'utf8'), sandbox, { filename: 'sync.js' })
  return (sandbox as unknown as { window: { DialflowSync: SyncModule } }).window.DialflowSync
}

function connectedClient(): SyncModule {
  const sync = loadClient()
  // Point at the ephemeral test port rather than relying on discovery.
  sync.api.baseUrl = baseUrl
  return sync
}

describe('client → server integration', () => {
  it('connects with a valid key and reports online', async () => {
    const sync = connectedClient()
    const ok = await sync.connect(TEST_KEY)
    expect(ok).toBe(true)
    expect(sync.state.online).toBe(true)
  })

  it('does not report online when the key is rejected', async () => {
    const sync = connectedClient()
    const ok = await sync.connect('df_wrong_key_that_should_be_rejected')
    // The server is reachable but unusable. Treating this as "offline" would
    // hide an auth problem behind a plausible-looking "saved locally" message.
    expect(ok).toBe(false)
  })

  it('creates a lead through the client and rekeys the temp id', async () => {
    const sync = connectedClient()
    await sync.connect(TEST_KEY)

    // The UI's own lead shape, with the local `id_` prefix it generates.
    const local: Record<string, unknown> = {
      id: 'id_abc123', first: 'Maya', last: 'Chen', name: 'Maya Chen',
      company: 'Northwind', title: 'VP Sales', email: 'maya@northwind.io',
      phone: '+14155550141', raw: '+1 (415) 555-0141', tz: 'PT',
      stage: 'new', value: 24000, source: 'Website', score: 90, notes: [],
    }

    const leads: Array<Record<string, unknown>> = [local]
    sync.setHooks({ findLead: (id: string) => leads.find((l) => l.id === id) })
    sync.markCreated(local)
    await sync.flush()

    expect(local.id).not.toBe('id_abc123') // rekeyed to the server's id
    expect(String(local.id)).toMatch(/^[0-9a-f-]{36}$/)

    const stored = await db.lead.findFirst()
    expect(stored?.firstName).toBe('Maya')
    expect(stored?.phone).toBe('+14155550141')
    expect(stored?.valueCents).toBe(2_400_000)
  })

  it('persists a later edit to the same lead', async () => {
    const sync = connectedClient()
    await sync.connect(TEST_KEY)

    const local: Record<string, unknown> = {
      id: 'id_edit1', first: 'Jonas', last: 'Weber', name: 'Jonas Weber',
      company: 'Helios', title: 'Founder', email: '', phone: '+491705550182',
      raw: '+491705550182', tz: 'CET', stage: 'new', value: 18000, source: 'Outbound', notes: [],
    }
    const leads: Array<Record<string, unknown>> = [local]
    sync.setHooks({ findLead: (id: string) => leads.find((l) => l.id === id) })

    sync.markCreated(local)
    await sync.flush()

    local.stage = 'qualified'
    local.value = 25000
    sync.markDirty(local)
    await sync.flush()

    const stored = await db.lead.findFirst()
    expect(stored?.stage).toBe('qualified')
    expect(stored?.valueCents).toBe(2_500_000)
  })

  it('deletes a lead that disappears locally', async () => {
    const sync = connectedClient()
    await sync.connect(TEST_KEY)

    const local: Record<string, unknown> = {
      id: 'id_del1', first: 'A', last: 'B', name: 'A B', company: 'X', title: 'Y',
      email: '', phone: '+14155550199', raw: '+14155550199', tz: 'PT',
      stage: 'new', value: 1000, source: 'Manual', notes: [],
    }
    const leads: Array<Record<string, unknown>> = [local]
    sync.setHooks({ findLead: (id: string) => leads.find((l) => l.id === id) })
    sync.markCreated(local)
    await sync.flush()
    expect(await db.lead.count()).toBe(1)

    leads.length = 0
    sync.markRemoved(local.id as string)
    await sync.flush()

    expect(await db.lead.count()).toBe(0)
  })

  it('writes a note against the right lead', async () => {
    const sync = connectedClient()
    await sync.connect(TEST_KEY)

    const local: Record<string, unknown> = {
      id: 'id_note1', first: 'Priya', last: 'Nair', name: 'Priya Nair', company: 'Finch',
      title: 'Head of Ops', email: '', phone: '+919820044510', raw: '+919820044510',
      tz: 'IST', stage: 'new', value: 9500, source: 'Referral', notes: [],
    }
    const leads: Array<Record<string, unknown>> = [local]
    sync.setHooks({ findLead: (id: string) => leads.find((l) => l.id === id) })
    sync.markCreated(local)
    await sync.flush()

    sync.queueNote(local.id as string, 'Asked for international pricing')
    await sync.flush()

    const notes = await db.leadNote.findMany()
    expect(notes).toHaveLength(1)
    expect(notes[0]?.text).toBe('Asked for international pricing')
  })

  it('does not send a note for a lead the server has never seen', async () => {
    // A lead created seconds ago may not have its server id yet; POSTing a
    // note against the temp id would be a guaranteed 404 on every keystroke.
    const sync = connectedClient()
    await sync.connect(TEST_KEY)
    sync.queueNote('id_pending', 'should be ignored')
    await sync.flush()
    expect(await db.leadNote.count()).toBe(0)
  })

  it('maps the API lead shape onto the UI shape', () => {
    const sync = connectedClient()
    const mapped = sync.fromApiLead({
      id: 'abc', firstName: 'Maya', lastName: 'Chen', name: 'Maya Chen',
      company: 'Northwind', title: 'VP Sales', email: 'maya@northwind.io',
      phone: '+14155550141', phoneRaw: '+1 (415) 555-0141', timezone: 'PT',
      stage: 'qualified', value: 24000, valueCents: 2_400_000, score: 90,
      source: 'Website', lastCalledAt: '2026-01-01T00:00:00.000Z',
    })

    // The UI reads first/last/tz/value/lastCalled — none of which the API uses.
    expect(mapped.first).toBe('Maya')
    expect(mapped.last).toBe('Chen')
    expect(mapped.tz).toBe('PT')
    expect(mapped.value).toBe(24000)
    expect(mapped.raw).toBe('+1 (415) 555-0141')
    expect(typeof mapped.lastCalled).toBe('number')
  })

  it('maps the UI lead shape onto the API write shape', () => {
    const sync = connectedClient()
    const payload = sync.toApiLead({
      first: 'Maya', last: 'Chen', phone: '+14155550141', email: 'maya@northwind.io',
      company: 'Northwind', title: 'VP Sales', tz: 'PT', source: 'Website',
      value: 24000, stage: 'new', score: 90,
    })
    expect(payload).toMatchObject({
      firstName: 'Maya', lastName: 'Chen', value: 24000, stage: 'new', timezone: 'PT',
    })
  })

  it('turns the UI em-dash placeholders into null', () => {
    const sync = connectedClient()
    const payload = sync.toApiLead({
      first: 'A', last: 'B', phone: '+14155550141', company: '—', title: '—', source: '—',
      value: 0, stage: 'new',
    })
    // "—" is a display placeholder, not real data; sending it would pollute
    // the database and skew analytics.
    expect(payload.company).toBeNull()
    expect(payload.title).toBeNull()
    expect(payload.source).toBeNull()
  })

  it('maps the API call shape onto the UI shape', () => {
    const sync = connectedClient()
    const mapped = sync.fromApiCall({
      id: 'c1', leadId: 'l1', mode: 'voip', status: 'completed',
      disposition: 'Qualified', durationSec: 187, note: 'wants trial',
      startedAt: '2026-01-01T00:00:00.000Z',
      lead: { name: 'Maya Chen', company: 'Northwind', phone: '+14155550141' },
    })
    expect(mapped).toMatchObject({
      leadName: 'Maya Chen', company: 'Northwind', duration: 187, disposition: 'Qualified',
    })
  })

  it('loads leads and calls from the server', async () => {
    const sync = connectedClient()
    await sync.connect(TEST_KEY)

    await db.lead.create({
      data: { firstName: 'Maya', lastName: 'Chen', phone: '+14155550141', valueCents: 2_400_000 },
    })
    await db.call.create({
      data: {
        leadId: (await db.lead.findFirstOrThrow()).id,
        mode: 'callback', status: 'completed', durationSec: 42, disposition: 'Voicemail',
      },
    })

    const data = await sync.load()
    expect(data.leads).toHaveLength(1)
    expect(data.calls).toHaveLength(1)
    expect((data.leads[0] as Record<string, unknown>).name).toBe('Maya Chen')
  })

  it('is a no-op rather than a crash when offline', async () => {
    const sync = connectedClient()
    sync.api.baseUrl = 'http://127.0.0.1:1' // nothing listening
    const ok = await sync.connect()
    expect(ok).toBe(false)
    sync.markDirty({ id: 'whatever' })
    // flush() must resolve quietly so the UI is never wedged by an outage.
    await expect(sync.flush()).resolves.toBeTruthy()
  })
})
