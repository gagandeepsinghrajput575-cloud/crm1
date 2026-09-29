import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // PGlite boots a WASM Postgres per worker; serialising keeps memory sane
    // and makes database-name collisions impossible.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      // Empty forces the embedded PGlite path, so the suite never needs a
      // Postgres server and never touches a real database.
      DATABASE_URL: '',
      API_KEY: 'df_test_key_for_the_test_suite_0123456789',
      TELEPHONY_PROVIDER: 'mock',
      DISABLE_DOCS: 'true',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: '100000',
      // Enable CORS so the preflight path is actually exercised. The suite
      // also asserts the disabled case explicitly.
      CORS_ORIGIN: 'http://127.0.0.1:5173',
    },
  },
})
