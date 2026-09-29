import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createPgliteAdapter } from 'prisma-pglite'
import { buildApp } from '../src/app.js'
import { PrismaClient } from '../src/generated/client/client.js'
import { MockTelephonyProvider } from '../src/telephony/mock.js'

export const TEST_API_KEY = 'df_test_key_for_the_test_suite_0123456789'

export interface TestContext {
  app: FastifyInstance
  db: PrismaClient
  provider: MockTelephonyProvider
  dir: string
  cleanup: () => Promise<void>
}

/**
 * Boots a real server against a throwaway PGlite database.
 *
 * These are integration tests, not mocked ones: the real schema, the real
 * migrations, the real SQL, the real HTTP layer. The only substitution is the
 * telephony carrier, which is replaced by the deterministic mock.
 */
export async function createTestContext(): Promise<TestContext> {
  // `dbParentDirPath` (not `directDatabaseDirPath`) is what makes
  // createPgliteAdapter push the Prisma schema into a fresh database. With a
  // direct path it silently creates an empty cluster and every query then
  // fails with "relation does not exist".
  const dir = mkdtempSync(join(tmpdir(), 'dialflow-test-'))

  const adapter = await createPgliteAdapter({
    prismaConfigPath: join(process.cwd(), 'prisma.config.ts'),
    dbParentDirPath: dir,
    databaseName: 'test',
  })

  const db = new PrismaClient({ adapter })
  const provider = new MockTelephonyProvider()

  const app = await buildApp({
    db: db as never,
    provider,
    agentTimezone: 'UTC',
    logger: false,
  })

  await app.ready()

  return {
    app,
    db: db as never,
    provider,
    dir,
    cleanup: async () => {
      await app.close()
      await db.$disconnect()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Truncates every table so each test starts from a known-empty world. */
export async function resetDatabase(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      call_events, calls, stage_changes, lead_tags, lead_notes,
      tags, leads, import_jobs, api_keys, settings
    RESTART IDENTITY CASCADE
  `)
}

export const authHeader = { authorization: `Bearer ${TEST_API_KEY}` }

export function json<T = unknown>(body: string): T {
  return JSON.parse(body) as T
}
