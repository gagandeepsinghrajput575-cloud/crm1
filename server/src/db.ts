import { join } from 'node:path'
import { config } from './config/env.js'
import { PrismaClient } from './generated/client/client.js'

/**
 * One schema, two runtimes.
 *
 * - Production / anything with DATABASE_URL set: real Postgres via the `pg`
 *   driver adapter.
 * - Everything else (local dev, the test suite): embedded PGlite, a WASM build
 *   of Postgres that runs in-process. No server to install, no container, and
 *   the SQL dialect is genuinely Postgres rather than SQLite — so tests
 *   exercise the same behaviour production does.
 *
 * The adapter is injected here rather than read from a global, which keeps the
 * client constructible against an arbitrary database in tests.
 */

export type Db = PrismaClient

let singleton: Db | null = null

async function createAdapter(): Promise<Db extends never ? never : any> {
  if (config.usePglite) {
    // Imported lazily so production never pays for the WASM bundle.
    const { createPgliteAdapter } = await import('prisma-pglite')
    return createPgliteAdapter({
      prismaConfigPath: join(process.cwd(), 'prisma.config.ts'),
      dbParentDirPath: join(process.cwd(), '.dev', 'pglite'),
      ...(config.isTest ? { databaseName: 'test' } : {}),
    })
  }

  const { PrismaPg } = await import('@prisma/adapter-pg')
  return new PrismaPg({ connectionString: config.DATABASE_URL })
}

export async function createDb(): Promise<Db> {
  const adapter = await createAdapter()
  return new PrismaClient({
    adapter,
    log: config.isProd ? ['warn', 'error'] : ['warn', 'error'],
  })
}

/** Process-wide client used by the running server. */
export async function getDb(): Promise<Db> {
  if (!singleton) {
    singleton = await createDb()
  }
  return singleton
}

export async function closeDb(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect()
    singleton = null
  }
}
