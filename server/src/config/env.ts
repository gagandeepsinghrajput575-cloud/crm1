import 'dotenv/config'
import { z } from 'zod'

/**
 * Central, fail-fast configuration.
 *
 * The process is expected to refuse to boot on bad config rather than fail
 * later at the first request — a misconfigured server that starts is worse than
 * one that never starts.
 */

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  )

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  CORS_ORIGIN: csv,

  // Empty DATABASE_URL => run on the embedded PGlite database.
  DATABASE_URL: z.string().default(''),

  API_KEY: z
    .string()
    .min(16, 'API_KEY must be at least 16 characters')
    .refine((v) => !v.includes(' '), 'API_KEY must not contain spaces'),
  API_KEY_PREVIOUS: z.string().default(''),

  TELEPHONY_PROVIDER: z.enum(['mock', 'sonetel']).default('mock'),
  SONETEL_BASE_URL: z.string().url().default('https://api.sonetel.com'),
  SONETEL_CLIENT_ID: z.string().default(''),
  SONETEL_CLIENT_SECRET: z.string().default(''),
  SONETEL_USERNAME: z.string().default(''),
  SONETEL_PASSWORD: z.string().default(''),
  SONETEL_CALLER_ID: z.string().default(''),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  DISABLE_DOCS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n')
  // eslint-disable-next-line no-console
  console.error(
    `\n✖ Invalid environment configuration:\n${issues}\n\n` +
      'Copy server/.env.example to server/.env and fill in API_KEY.\n',
  )
  process.exit(1)
}

const raw = parsed.data

if (raw.TELEPHONY_PROVIDER === 'sonetel') {
  const missing = (
    [
      ['SONETEL_CLIENT_ID', raw.SONETEL_CLIENT_ID],
      ['SONETEL_CLIENT_SECRET', raw.SONETEL_CLIENT_SECRET],
      ['SONETEL_USERNAME', raw.SONETEL_USERNAME],
      ['SONETEL_PASSWORD', raw.SONETEL_PASSWORD],
    ] as const
  )
    .filter(([, v]) => !v)
    .map(([k]) => k)

  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✖ TELEPHONY_PROVIDER=sonetel but these are unset: ${missing.join(', ')}\n` +
        'Set them, or use TELEPHONY_PROVIDER=mock.\n',
    )
    process.exit(1)
  }
}

export const config = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  /** True when running on embedded PGlite rather than a real Postgres server. */
  usePglite: raw.DATABASE_URL.trim() === '',
} as const

export type Config = typeof config
