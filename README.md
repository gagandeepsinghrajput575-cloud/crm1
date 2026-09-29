# Dialflow

Sonetel power-dialer and pipeline CRM.

| Path | What it is |
| --- | --- |
| `index.html` | The UI — six views (dialer, pipeline, history, import, analytics, setup). |
| `js/api.js` | API client with runtime discovery and offline detection. |
| `js/sync.js` | Optimistic sync layer: maps the UI's model to the API's, mirrors writes. |
| `server/` | The backend API. See **[`server/README.md`](server/README.md)**. |
| `.github/workflows/ci.yml` | Typecheck, tests, build, image smoke test. |

## Status

The backend is complete and the UI is wired to it — 121 tests, including
integration tests that run the real `js/api.js` and `js/sync.js` sources against
a real server over real HTTP.

The UI talks to the API when it can reach it, and falls back to its
`localStorage` cache when it cannot, so opening `index.html` directly still
works offline.

## Running it

```bash
# 1. backend
cd server
cp .env.example .env
node -e "console.log('df_' + require('crypto').randomBytes(32).toString('base64url'))"   # → API_KEY
npm install && npm run db:generate && npm run seed && npm run dev

# 2. UI, in another shell
python3 -m http.server 5173      # or any static file server
```

Open http://localhost:5173, then click the status line in the footer to paste
your `API_KEY`. It is remembered in the browser.

- API → http://localhost:4000
- Swagger UI → http://localhost:4000/docs

No database server needed: with `DATABASE_URL` empty the API runs on PGlite, a
WASM build of PostgreSQL, using the same schema as production.
