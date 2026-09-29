# Dialflow

Sonetel power-dialer and pipeline CRM.

| Path | What it is |
| --- | --- |
| `index.html` | The UI — a single-file prototype that still runs on `localStorage`. |
| `server/` | The backend API. See **[`server/README.md`](server/README.md)**. |
| `.github/workflows/ci.yml` | Typecheck, tests, build, image smoke test. |

## Status

The backend is complete, tested (106 tests) and running. The UI has **not** yet
been pointed at it — it still uses `localStorage`.

## Running it

```bash
cd server
cp .env.example .env
node -e "console.log('df_' + require('crypto').randomBytes(32).toString('base64url'))"   # → API_KEY
npm install && npm run db:generate && npm run seed && npm run dev
```

- API → http://localhost:4000
- Docs → http://localhost:4000/docs

No database server needed: with `DATABASE_URL` empty it runs on PGlite, a WASM
build of PostgreSQL, using the same schema as production.
