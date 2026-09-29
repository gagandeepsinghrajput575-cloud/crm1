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
cd server
cp .env.example .env
node -e "console.log('df_' + require('crypto').randomBytes(32).toString('base64url'))"   # → API_KEY
npm install && npm run db:generate && npm run seed && npm run dev
```

Then open **http://localhost:4000** — the API serves the UI from the same
origin. On first load it asks for your `API_KEY` and remembers it in the
browser.

| URL | |
| --- | --- |
| `http://localhost:4000` | The app |
| `http://localhost:4000/docs` | Swagger UI |
| `http://localhost:4000/health` | Health |

### Why one origin

The UI is served by the API (`STATIC_DIR` in `.env`) rather than from a separate
dev server. With the UI on a different origin, every request needs a correct
CORS allow-list and the browser has to discover where the API lives — and both
break the moment the app is reached from another machine, a tunnel, or a hosted
preview. One origin removes the whole class of problem, and it matches how
this actually deploys: one container, one URL.

`CORS_ORIGIN` still exists for the case where you deliberately run a separate
frontend (a Vite dev server, say) and only then does it matter.

No database server needed: with `DATABASE_URL` empty the API runs on PGlite, a
WASM build of PostgreSQL, using the same schema as production.
