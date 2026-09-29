/**
 * Seeds the workspace with the same demo data the frontend used to generate
 * in the browser, so switching from localStorage to this API does not leave
 * you staring at an empty dialer queue.
 *
 * Idempotent: re-running updates existing rows by phone number instead of
 * creating duplicates.
 *
 *   npm run seed            # against the configured database
 *   npm run seed -- --reset # wipe demo leads first
 */
import { config } from '../config/env.js'
import { createDb } from '../db.js'
import { ImportStatus, LeadStage } from '../generated/client/enums.js'
import { createLead } from '../services/leads.js'
import { hashApiKey, keyPrefix } from '../lib/crypto.js'
import { normalizePhone } from '../lib/phone.js'

/** [first, last, company, title, phone, email, stage, value, tz, source] */
const DEMO_LEADS: Array<[string, string, string, string, string, string, LeadStage, number, string, string]> = [
  ['Maya', 'Chen', 'Northwind', 'VP Sales', '+1 (415) 555-0141', 'maya@northwind.io', LeadStage.new, 24000, 'PT', 'Website'],
  ['Jonas', 'Weber', 'Helios Energy', 'Founder', '+49 170 555 0182', 'jonas@helios.de', LeadStage.new, 18000, 'CET', 'Outbound'],
  ['Priya', 'Nair', 'Finch & Co', 'Head of Ops', '+91 98200 44510', 'priya@finch.co', LeadStage.attempted, 9500, 'IST', 'Referral'],
  ['Tom', 'Okafor', 'Brightline', 'CEO', '+1 (212) 555-0173', 'tom@brightline.co', LeadStage.followup, 32000, 'ET', 'Cold call'],
  ['Sofia', 'Marsh', 'Lumen Labs', 'Growth Lead', '+44 7700 900123', 'sofia@lumenlabs.uk', LeadStage.new, 14000, 'GMT', 'LinkedIn'],
  ['Diego', 'Fuentes', 'Andes Retail', 'Director', '+52 55 1234 8890', 'diego@andes.mx', LeadStage.attempted, 7200, 'CST', 'CSV import'],
  ['Aiko', 'Tanaka', 'Kanso Steel', 'Procurement', '+81 90 1234 5678', 'aiko@kanso.jp', LeadStage.connected, 41000, 'JST', 'Partner'],
  ['Liam', 'Murphy', 'Harbour Freight', 'Owner', '+353 85 123 4567', 'liam@harbour.ie', LeadStage.new, 6800, 'GMT', 'Website'],
  ['Ingrid', 'Larsen', 'Fjord Tech', 'CTO', '+47 900 12 345', 'ingrid@fjord.no', LeadStage.qualified, 27500, 'CET', 'Demo'],
  ['Carlos', 'Mendez', 'Solvivo', 'Sales Mgr', '+34 612 345 678', 'carlos@solvivo.es', LeadStage.followup, 11200, 'CET', 'Outbound'],
  ['Emma', 'Wilson', 'Copperfield', 'COO', '+1 (312) 555-0198', 'emma@copperfield.com', LeadStage.new, 15900, 'CT', 'Referral'],
  ['Ravi', 'Patel', 'Zephyr Air', 'Founder', '+91 99301 22334', 'ravi@zephyr.in', LeadStage.attempted, 21000, 'IST', 'Cold call'],
]

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset')
  const db = await createDb()
  const log = (...args: unknown[]) => console.log(...args)

  log(`Seeding ${config.usePglite ? 'embedded PGlite' : 'Postgres'}…`)

  if (reset) {
    const { count } = await db.lead.deleteMany({})
    await db.importJob.deleteMany({})
    log(`  removed ${count} existing leads`)
  }

  let created = 0
  let updated = 0

  for (const [first, last, company, title, phone, email, stage, value, tz, source] of DEMO_LEADS) {
    const parsed = normalizePhone(phone)
    const existing = parsed.ok
      ? await db.lead.findFirst({ where: { phone: parsed.e164 } })
      : null

    if (existing) {
      await db.lead.update({
        where: { id: existing.id },
        data: { firstName: first, lastName: last, company, title, email, stage, valueCents: value * 100, timezone: tz, source },
      })
      updated += 1
      continue
    }

    const lead = await createLead(db, {
      firstName: first,
      lastName: last,
      phone,
      email,
      company,
      title,
      timezone: tz,
      source,
      valueCents: value * 100,
      stage,
      agentTimezone: 'PT',
    })

    await db.leadNote.create({
      data: { leadId: lead.id, text: `Sourced via ${source}. Interested in international call rates.` },
    })
    created += 1
  }

  await db.importJob.create({
    data: {
      filename: 'seed.ts',
      status: ImportStatus.completed,
      totalRows: DEMO_LEADS.length,
      imported: created,
      updated,
      completedAt: new Date(),
    },
  })

  // Register the bootstrap key so the settings screen can show it in the list.
  // The API_KEY in the environment is the one that actually authenticates;
  // this row is for visibility and so it can be revoked later.
  const bootstrapHash = hashApiKey(config.API_KEY)
  await db.apiKey.upsert({
    where: { keyHash: bootstrapHash },
    create: { name: 'bootstrap (from API_KEY)', keyHash: bootstrapHash, prefix: keyPrefix(config.API_KEY) },
    update: { name: 'bootstrap (from API_KEY)' },
  })

  log(`  ✓ ${created} leads created, ${updated} updated`)
  log(`  ✓ bootstrap API key registered (prefix ${keyPrefix(config.API_KEY)}…)`)

  await db.$disconnect()

  // PGlite runs a WASM Postgres in-process, and its event loop does not drain
  // on its own after $disconnect — the process would otherwise hang for
  // minutes after the work is already done. Exiting explicitly is correct
  // here: this is a one-shot CLI, not the server.
  process.exit(0)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
