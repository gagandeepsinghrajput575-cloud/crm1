#!/usr/bin/env node
/**
 * Generates the Prisma client.
 *
 * Two jobs beyond `npx prisma generate`:
 *
 * 1. Falls back to the WASM schema engine when the platform binaries cannot be
 *    downloaded. Prisma fetches its engine from binaries.prisma.sh at install
 *    time, which is unreachable in some sandboxes and locked-down CI networks.
 *    `@prisma/schema-engine-wasm` is already an npm dependency, so we can point
 *    Prisma at the local .wasm and skip the download entirely. Driver adapters
 *    mean no query engine is needed at runtime either way.
 *
 * 2. Never fails the install. A missing client is reported loudly and
 *    `npm run db:generate` is printed as the fix, rather than turning every
 *    `npm install` into a hard error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const wasm = join(root, 'node_modules', '@prisma', 'schema-engine-wasm', 'schema_engine_bg.wasm')

const env = { ...process.env }

// The TypeScript client is generated into src/, which is gitignored, so a fresh
// checkout has no client until this runs.
const args = ['prisma', 'generate']
const result = spawnSync('npx', args, { cwd: root, env, stdio: 'inherit', shell: false })

if (result.status === 0) {
  process.exit(0)
}

// Retry once against the local WASM engine before giving up.
if (existsSync(wasm)) {
  console.log('[postinstall] retrying with the local WASM schema engine…')
  env.PRISMA_SCHEMA_ENGINE_TYPE = 'wasm'
  env.PRISMA_SCHEMA_ENGINE_BINARY = wasm
  const retry = spawnSync('npx', args, { cwd: root, env, stdio: 'inherit', shell: false })
  if (retry.status === 0) process.exit(0)
}

console.error(
  '\n[postinstall] Prisma client generation failed.\n' +
    '  Run `npm run db:generate` to see the full error.\n',
)
process.exit(0)
