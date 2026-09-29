import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { Db } from '../db.js'
import { ImportStatus, LeadStage } from '../generated/client/enums.js'
import { config } from '../config/env.js'
import { indexHeaders, parseCsv } from '../lib/csv.js'
import { badRequest, notFound, payloadTooLarge } from '../lib/errors.js'
import { isValidE164, normalizePhone } from '../lib/phone.js'
import { parseOrThrow, uuidParam } from '../lib/validate.js'
import { createLead, scoreLead } from '../services/leads.js'

/** Hard cap on rows in one import, independent of the byte-size limit. */
const MAX_ROWS = 10_000
const MAX_ERRORS_STORED = 50

/** Accepts the header spellings real CSVs actually use. */
const COLUMN_ALIASES: Record<string, string[]> = {
  firstName: ['first_name', 'firstname', 'first', 'given_name'],
  lastName: ['last_name', 'lastname', 'last', 'surname', 'family_name'],
  name: ['name', 'full_name', 'fullname', 'contact'],
  phone: ['phone', 'phone_number', 'phonenumber', 'number', 'mobile', 'tel', 'telephone'],
  email: ['email', 'email_address', 'emailaddress', 'e-mail'],
  company: ['company', 'organisation', 'organization', 'account', 'employer'],
  title: ['title', 'job_title', 'role', 'position'],
  timezone: ['timezone', 'time_zone', 'tz'],
  source: ['source', 'lead_source', 'channel'],
  value: ['value', 'deal_value', 'amount', 'budget', 'revenue'],
  stage: ['stage', 'status', 'pipeline_stage'],
}

function buildColumnMap(headers: string[]) {
  const index = indexHeaders(headers)
  const map = new Map<string, number>()
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = index.get(alias)
      if (idx !== undefined) {
        map.set(field, idx)
        break
      }
    }
  }
  return map
}

const previewBody = z.object({
  csv: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
})

const commitBody = z.object({
  csv: z.string().min(1),
  filename: z.string().max(255).optional(),
  defaultStage: z.enum(LeadStage).default(LeadStage.new),
  /** Upsert matches on normalised E.164 and refreshes the existing lead. */
  updateExisting: z.boolean().default(false),
})

export const importRoutes = fp(
  async (app: FastifyInstance, opts: { db: Db; agentTimezone: string }) => {
    const db = opts.db

    /** Dry run: shows exactly what an import would do, without writing. */
    app.post('/api/imports/preview', async (req) => {
      const body = parseOrThrow(previewBody, req.body)
      assertSize(body.csv.length)

      const { headers, rows } = parseCsv(body.csv)
      if (headers.length === 0) throw badRequest('CSV has no header row')

      const columns = buildColumnMap(headers)
      const missingRequired = ['phone'].filter((c) => !columns.has(c))
      const missingName = !columns.has('firstName') && !columns.has('name')

      const sample = rows.slice(0, body.limit).map((row, idx) => {
        const record = mapRow(row, columns)
        return { line: idx + 2, ...record, _valid: validateRecord(record).ok }
      })

      const validCount = rows.filter((r) => validateRecord(mapRow(r, columns)).ok).length

      return {
        headers,
        detectedColumns: Object.fromEntries(columns),
        totalRows: rows.length,
        validRows: validCount,
        invalidRows: rows.length - validCount,
        sample,
        // Surfaced rather than silently guessed, so the user knows before
        // committing whether the file will import correctly.
        problems: [
          ...(missingRequired.length
            ? [`Missing required column: ${missingRequired.join(', ')}`]
            : []),
          ...(missingName ? ['No name column found — leads will be imported without a name'] : []),
        ],
      }
    })

    app.post('/api/imports/leads', async (req, reply) => {
      const body = parseOrThrow(commitBody, req.body)
      assertSize(body.csv.length)

      const job = await db.importJob.create({
        data: { filename: body.filename ?? null, status: ImportStatus.processing },
      })

      const { headers, rows } = parseCsv(body.csv)
      if (headers.length === 0) {
        await failJob(job.id, 'CSV has no header row')
        throw badRequest('CSV has no header row')
      }
      if (rows.length > MAX_ROWS) {
        await failJob(job.id, `Row limit exceeded`)
        throw payloadTooLarge(`Import is limited to ${MAX_ROWS} rows per file`)
      }

      const columns = buildColumnMap(headers)
      if (!columns.has('phone')) {
        await failJob(job.id, 'No phone column detected')
        throw badRequest(
          'No phone column detected. Expected one of: ' + COLUMN_ALIASES.phone!.join(', '),
        )
      }

      const errors: Array<{ line: number; reason: string; value?: string }> = []
      let imported = 0
      let updated = 0
      let skipped = 0

      // Imported in chunks so a 10k-row file does not hold one enormous
      // transaction open or exhaust the connection pool.
      const CHUNK = 250
      for (let start = 0; start < rows.length; start += CHUNK) {
        const chunk = rows.slice(start, start + CHUNK)

        for (const [offset, row] of chunk.entries()) {
          const line = start + offset + 2 // 1-based, +1 for the header
          const record = mapRow(row, columns)
          const check = validateRecord(record)

          if (!check.ok) {
            skipped += 1
            if (errors.length < MAX_ERRORS_STORED) {
              errors.push({ line, reason: check.reason, value: record.phone ?? undefined })
            }
            continue
          }

          try {
            if (body.updateExisting) {
              // `phone` is indexed but not unique (a shared office line is
              // legitimate), so this is deliberately findFirst, not findUnique.
              const existing = await db.lead.findFirst({
                where: { phone: record.phone! },
                select: { id: true },
                orderBy: { createdAt: 'asc' },
              })
              if (existing) {
                await db.lead.update({
                  where: { id: existing.id },
                  data: {
                    firstName: record.firstName ?? existingFallback('firstName'),
                    lastName: record.lastName ?? existingFallback('lastName'),
                    email: record.email,
                    company: record.company,
                    title: record.title,
                    valueCents: record.valueCents,
                    score: scoreLead({
                      email: record.email,
                      title: record.title,
                      company: record.company,
                      source: record.source,
                      valueCents: record.valueCents,
                      timezone: record.timezone,
                      agentTimezone: opts.agentTimezone,
                    }),
                  },
                })
                updated += 1
                continue
              }
            }

            await createLead(db, {
              firstName: record.firstName || 'Unknown',
              lastName: record.lastName || '(no name)',
              phone: record.phone!,
              email: record.email,
              company: record.company,
              title: record.title,
              timezone: record.timezone,
              source: record.source,
              valueCents: record.valueCents,
              stage: record.stage ?? body.defaultStage,
              agentTimezone: opts.agentTimezone,
            })
            imported += 1
          } catch (err) {
            skipped += 1
            if (errors.length < MAX_ERRORS_STORED) {
              errors.push({
                line,
                reason: err instanceof Error ? err.message : 'Import failed',
                value: record.phone,
              })
            }
          }
        }
      }

      const completed = await db.importJob.update({
        where: { id: job.id },
        data: {
          status: ImportStatus.completed,
          totalRows: rows.length,
          imported,
          updated,
          skipped,
          failed: skipped,
          errors: errors.length ? errors : undefined,
          completedAt: new Date(),
        },
      })

      req.log.info({ jobId: job.id, imported, updated, skipped }, 'csv import finished')
      reply.status(201)
      return shapeJob(completed)
    })

    app.get('/api/imports', async () => {
      const jobs = await db.importJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
      return { data: jobs.map(shapeJob) }
    })

    app.get('/api/imports/:id', async (req) => {
      const { id } = parseOrThrow(uuidParam, req.params)
      const job = await db.importJob.findUnique({ where: { id } })
      if (!job) throw notFound('Import job')
      return shapeJob(job)
    })

    async function failJob(id: string, reason: string): Promise<void> {
      await db.importJob.update({
        where: { id },
        data: { status: ImportStatus.failed, errors: [{ reason }] as never, completedAt: new Date() },
      })
    }
  },
  { name: 'import-routes' },
)

// ---------------------------------------------------------------- helpers

function existingFallback(field: string): string {
  return field === 'firstName' ? 'Unknown' : '(no name)'
}

function assertSize(csvLength: number): void {
  // Cheap pre-check: UTF-16 code units, close enough to catch oversized bodies
  // before we spend CPU parsing them.
  if (csvLength * 2 > config.MAX_UPLOAD_BYTES) {
    throw payloadTooLarge(
      `CSV exceeds the ${Math.floor(config.MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`,
    )
  }
}

interface ImportRecord {
  firstName?: string
  lastName?: string
  phone?: string
  email?: string | null
  company?: string | null
  title?: string | null
  timezone?: string | null
  source?: string | null
  valueCents?: number
  stage?: LeadStage
}

function mapRow(row: string[], columns: Map<string, number>): ImportRecord {
  const get = (field: string): string | undefined => {
    const idx = columns.get(field)
    if (idx === undefined) return undefined
    const v = row[idx]
    return v === undefined ? undefined : v.trim()
  }

  const record: ImportRecord = {}
  const first = get('firstName')
  const last = get('lastName')
  const full = get('name')

  if (first || last) {
    record.firstName = first || full || 'Unknown'
    record.lastName = last || '(no name)'
  } else if (full) {
    // "Maya Chen" / "Chen, Maya" both land in a sensible shape.
    const parts = full.split(/\s+/)
    if (full.includes(',') && parts.length > 1) {
      const [lastName, firstName] = full.split(',')
      record.lastName = lastName!.trim()
      record.firstName = (firstName ?? '').trim() || 'Unknown'
    } else {
      record.firstName = parts[0]!
      record.lastName = parts.slice(1).join(' ') || '(no name)'
    }
  }

  const phone = get('phone')
  if (phone) {
    const parsed = normalizePhone(phone)
    record.phone = parsed.ok ? parsed.e164 : phone
  }

  const email = get('email')
  if (email) record.email = email.toLowerCase()

  for (const field of ['company', 'title', 'timezone', 'source'] as const) {
    const v = get(field)
    if (v) record[field] = v
  }

  const value = get('value')
  if (value) {
    // Tolerates "$24,000", "24000", "24k".
    const cleaned = value.replace(/[$,\s]/g, '').toLowerCase()
    const multiplier = cleaned.endsWith('k') ? 1000 : cleaned.endsWith('m') ? 1_000_000 : 1
    const n = Number.parseFloat(cleaned.replace(/[km]$/, ''))
    if (Number.isFinite(n)) record.valueCents = Math.round(n * multiplier * 100)
  }

  const stage = get('stage')
  if (stage) {
    const match = Object.values(LeadStage).find(
      (s) => s.toLowerCase() === stage.toLowerCase().replace(/[\s-]/g, ''),
    )
    if (match) record.stage = match
  }

  return record
}

function validateRecord(r: ImportRecord): { ok: true } | { ok: false; reason: string } {
  if (!r.phone) return { ok: false, reason: 'Missing phone number' }
  if (!isValidE164(r.phone)) return { ok: false, reason: `Not a valid E.164 number: ${r.phone}` }
  if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) {
    return { ok: false, reason: `Invalid email: ${r.email}` }
  }
  return { ok: true }
}

function shapeJob(job: {
  id: string
  filename: string | null
  status: ImportStatus
  totalRows: number
  imported: number
  updated: number
  skipped: number
  failed: number
  errors: unknown
  createdAt: Date
  completedAt: Date | null
}) {
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    totalRows: job.totalRows,
    imported: job.imported,
    updated: job.updated,
    skipped: job.skipped,
    failed: job.failed,
    errors: job.errors ?? [],
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  }
}
