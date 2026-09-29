import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Prisma 7 keeps connection URLs out of schema.prisma. The CLI needs one only
// for `migrate` / `db push` against real Postgres; the server itself always
// injects the URL through a driver adapter (see src/db.ts), which is what lets
// the exact same schema run on embedded PGlite for dev and tests.
const url =
  process.env.DATABASE_URL ??
  'postgresql://dialflow:dialflow@localhost:5432/dialflow?schema=public'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url,
  },
})
