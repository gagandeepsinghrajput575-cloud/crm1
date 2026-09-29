# Dialflow API

Backend for **Dialflow**, a Sonetel power-dialer and pipeline CRM. This
replaces the `localStorage` prototype in `../index.html` with a real,
persistent, tested API.

**Stack:** Node 22 · TypeScript (strict) · Fastify 5 · Prisma 7 · PostgreSQL

---

## Quick start

```bash
cd server
cp .env.example .env

# Generate the one value the server refuses to boot without:
node -e "console.log('df_' + require('crypto').randomBytes(32).toString('base64url'))"
# paste it into API_KEY in .env

npm install
npm run db:generate
npm run seed          # 12 demo leads, same data the UI used to fake
npm run dev
```

Then open **http://localhost:4000**.

| URL | |
| --- | --- |
| `/` | The Dialflow UI |
| `/docs` | Swagger UI |
| `/health` | Health |

The server serves the UI itself (`STATIC_DIR`, default `..`). One origin means
no CORS configuration and no API discovery for the browser to get wrong — which
is what makes it work unchanged from a laptop, a container, or a hosted
preview. Set `CORS_ORIGIN` only if you deliberately run the frontend from
somewhere else.

No database installation is required. With `DATABASE_URL` empty the server runs
on [PGlite](https://pglite.dev) — a WASM build of Postgres that executes
in-process. It is real PostgreSQL, not SQLite, so the SQL that works in dev is
the SQL that works in production.

```bash
curl -H "Authorization: Bearer $API_KEY" http://localhost:4000/api/leads/queue
```

---

## Why there is no database server in the dev setup

The PGlite adapter and the production `pg` adapter are both injected at
`src/db.ts` against one Prisma schema. Consequences worth knowing:

- Tests run against genuine PostgreSQL semantics — real transactions, real
  foreign keys, real cascades. No mock database means no divergence between
  what tests prove and what production does.
- PGlite holds an **exclusive lock on its data directory**. The server and
  `npm run seed` cannot run at the same time; stop the server first.
- Set `DATABASE_URL` to a real `postgresql://` URL and everything else is
  unchanged.

---

## Authentication

Single-tenant, one API key.

```bash
-H "Authorization: Bearer df_..."      # preferred
-H "X-API-Key: df_..."
```

- The key is stored **only as a SHA-256 hash** and compared in constant time,
  so neither a database leak nor response timing reveals it.
- Rotation without downtime: set the old key as `API_KEY_PREVIOUS`, move
  clients over, then remove it.
- `POST /api/keys` issues additional keys (for CI, for a second workstation).
  The raw key is shown exactly once and is unrecoverable by design.

Every route except `/health*` and `/docs*` requires a key.

---

## Telephony

Calls go through a provider interface (`src/telephony/provider.ts`):

```
routes → services/calls.ts (state machine) → TelephonyProvider → carrier
```

| Provider | Status |
| --- | --- |
| `mock` | **Default.** Deterministic, in-process, zero credentials. |
| `sonetel` | Implemented — see the caveat below. |

> **Sonetel adapter status.** The auth flow, idempotency, error translation and
> webhook normalisation are real and tested. The exact request/response field
> names are inferred from the two facts the product surface reveals
> (`POST /api/token`, password grant; a list of caller IDs) — they were **not**
> verified against Sonetel's live API, because I have no credentials and did
> not want to guess silently. Every unverified point is marked `CONFIRM` in
> `src/telephony/sonetel.ts`. Before going live, check those against Sonetel's
> current docs and run the suite with `TELEPHONY_PROVIDER=sonetel`.

Adding a carrier: implement the interface, register it in
`src/telephony/index.ts`. No route or schema changes.

### The call state machine

Provider webhooks arrive out of order, get retried, and sometimes contradict
each other. Every event passes through an explicit transition table
(`src/services/calls.ts`):

- **Replayed events are no-ops.** Providers retry; a duplicate `completed` must
  not be an error.
- **Out-of-order events are rejected and recorded.** A late `ringing` after
  `completed` is stored as a `call_event` with `ignored: true` and the reason,
  so the discrepancy is auditable rather than silently dropped.
- **Terminal states absorb nothing.** A finished call cannot be resurrected.
- **Persistence is transactional** — call status, event log, lead stage and
  stage audit all commit together or not at all.

**No carrier event can mark a lead `lost`.** A rejected or failed call is a
fact about the phone line, not about the deal. Auto-writing `lost` on a network
hiccup would silently delete real pipeline and corrupt the forecast. Losing a
lead is an explicit agent action via a disposition.

---

## API

All responses are JSON. Errors use one envelope:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "…", "details": [], "correlationId": "…" } }
```

`correlationId` is echoed from `X-Request-ID` when supplied, so a client-side
id flows straight into server logs. Stack traces and driver messages are never
returned.

### Leads

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/leads` | Cursor pagination. Filters: `stage`, `queue`, `search`, `sort`, `order`, `tag`. |
| `GET` | `/api/leads/queue` | Dialer queue: open leads only, best score first. |
| `GET` | `/api/leads/:id` | Includes notes, recent calls and stage history. |
| `POST` | `/api/leads` | Phone is normalised to E.164; score is computed. |
| `PATCH` | `/api/leads/:id` | Partial. A stage change writes an audit row in the same transaction. |
| `DELETE` | `/api/leads/:id` | Cascades notes, calls, events, stage history. |
| `POST` | `/api/leads/bulk-delete` | Max 500 ids. |
| `POST` | `/api/leads/rescore` | Recomputes scores for all open leads, batched. |
| `POST` | `/api/leads/:id/notes` · `DELETE` `/api/leads/:id/notes/:noteId` | Deletes are lead-scoped. |
| `POST` | `/api/leads/:id/tags` · `DELETE` `/api/leads/:id/tags/:tagName` | |
| `GET` | `/api/tags` | |

Pagination is keyset-based on a stable `(sortField, id)` key, not `OFFSET`.
Offset silently skips or duplicates rows whenever a lead is inserted mid-scan —
which, in a queue that is being dialled and updated constantly, is constantly.

### Pipeline

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/pipeline` | Whole board, per-stage counts and value totals. |
| `POST` | `/api/pipeline/move` | Kanban drag-and-drop; writes an audit row. |
| `GET` | `/api/pipeline/velocity` | 30-day stage-entry counts and share. |

### Calls

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/calls` | Filters: `leadId`, `status`, `mode`, `disposition`, `from`, `to`. |
| `GET` | `/api/calls/active` | Live calls with their event timeline. |
| `GET` | `/api/calls/:id` | |
| `POST` | `/api/calls` | Initiate. Refuses a second concurrent call to the same lead. |
| `POST` | `/api/calls/:id/hangup` · `/complete` | Complete takes a disposition and optional stage. |
| `POST` | `/api/webhooks/telephony` | Provider event intake. Always 200, so a carrier does not retry forever. |
| `POST` | `/api/calls/:id/simulate` | **Mock only.** Drives a call to terminal through the real state machine. |

### Imports

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/imports/preview` | Dry run. Returns detected columns, valid/invalid counts, sample rows. |
| `POST` | `/api/imports/leads` | `updateExisting: true` upserts on normalised E.164. |
| `GET` | `/api/imports` · `/api/imports/:id` | Job history with row-level errors (capped at 50). |

The CSV parser is a real RFC 4180 state machine. It handles quoted fields
containing commas (`"Smith, Jane"`), escaped quotes (`""`), embedded newlines,
CRLF and a UTF-8 BOM. `line.split(',')` corrupts all of these.

Header names are matched loosely — `first_name`, `First Name` and `firstname`
all resolve — and a file with no phone column is rejected with a message
naming what it looked for, rather than importing 4,000 broken rows.

### Analytics

| Method | Path |
| --- | --- |
| `GET` | `/api/analytics/summary` |
| `GET` | `/api/analytics/timeseries?days=30` |
| `GET` | `/api/analytics/leaderboard?days=30` |

Computed with database aggregates, never by loading rows into Node. Empty
pipeline stages are returned explicitly with zero counts — a funnel chart that
omits a stage misrepresents the pipeline.

### Settings & keys

| Method | Path | Notes |
| --- | --- | --- |
| `GET`/`PATCH` | `/api/settings` | Dialer preferences. Phone numbers normalised on write. |
| `POST` | `/api/settings/telephony/verify` | Verifies provider credentials. |
| `GET` | `/api/settings/caller-ids` · `/api/settings/runtime` | |
| `POST`/`GET`/`DELETE` | `/api/keys` | Additional keys. |

**Secrets never cross the API boundary.** The frontend used to keep the Sonetel
client secret and bearer token in `localStorage`, where any XSS hands over full
telephony access. Those credentials now live only in the server's environment.
The client can ask *whether* the provider is configured, never *with what*.

---

## Lead scoring

Scores are **deterministic**: the same record always produces the same number.
The prototype used `60 + Math.random() * 40`, which reordered the dialer queue
on every page load — the agent could never learn or trust the ordering.

Inputs: email, title, company, source, deal value (log-scaled in dollars), and
timezone overlap with the agent's own working hours. Weights are documented
inline in `src/services/leads.ts`.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the build |
| `npm test` | Full suite (121 tests) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | Demo data (`-- --reset` to wipe first) |
| `npm run db:generate` / `db:migrate` / `db:deploy` | Prisma |
| `npm run db:studio` | Prisma Studio |

### Tests

```bash
npm test
```

- **Unit** — phone normalisation, CSV parsing, call state machine, scoring.
- **Integration** — the real HTTP layer, real schema, real SQL, real
  transactions, against a throwaway PGlite database. Only the carrier is
  substituted.
- **Client** — the real `../js/api.js` and `../js/sync.js` sources, executed in
  a `vm` with a browser shim, talking to a real server over real HTTP.

The integration tests assert behaviour that matters rather than that code ran:
that a duplicate webhook is a no-op, that a malformed cursor is a 422 and not a
500, that a note cannot be deleted through the wrong lead, that no carrier event
can mark a lead lost, and that a paginated walk never returns a row twice.

---

## Deployment

### Docker Compose (Postgres + migrations + API)

```bash
cd server
echo "API_KEY=df_$(openssl rand -base64 32 | tr -d '\n' | tr '+/' '-_')" >> .env
docker compose up --build
```

Migrations run as a one-shot service that gates the API on success, so the
server never starts against an unmigrated database. The image runs as the
unprivileged `node` user under `tini` (so `SIGTERM` actually reaches Node and
the graceful drain runs), and its healthcheck uses `/health/ready` rather than
`/health/live` — an orchestrator should only route traffic to a container that
can reach its database.

### Health endpoints

| Path | Purpose |
| --- | --- |
| `/health/live` | Process is up. Does not touch the database. |
| `/health/ready` | Can serve traffic. Checks the database; 503 when degraded. |
| `/health` | Version, environment, uptime. |

Liveness deliberately ignores the database: a slow database should not cause
your orchestrator to kill an otherwise healthy process.

---

## Hardening

- **Rate limiting** bucketed per API key, so one noisy client cannot exhaust
  every other client's budget behind a shared IP. Health and docs are exempt.
- **Request correlation** — `X-Request-ID` in, same id in logs and error bodies.
- **Log redaction** of `authorization`, `x-api-key`, and password/secret/token
  body fields.
- **CORS** defaults to closed when `CORS_ORIGIN` is unset.
- **Body limits** via `MAX_UPLOAD_BYTES` (5 MB), plus a 10,000-row cap per import.
- **Parameterised SQL everywhere** — no string interpolation into queries.
- **Constant-time key comparison** and hashed key storage.
- **Batched writes** for bulk rescoring and import, so a 10k-row file does not
  open 10k connections or hold one enormous transaction.
- Structured JSON logs in production, pretty output in development.

---

## Configuration

See `.env.example` for the full annotated list. The server **refuses to boot**
on invalid configuration — a misconfigured server that starts is worse than one
that never starts.

| Variable | Default | Notes |
| --- | --- | --- |
| `API_KEY` | — | **Required.** ≥16 chars. |
| `API_KEY_PREVIOUS` | — | Enables zero-downtime rotation. |
| `DATABASE_URL` | *(empty)* | Empty ⇒ embedded PGlite. |
| `TELEPHONY_PROVIDER` | `mock` | `mock` or `sonetel`. |
| `CORS_ORIGIN` | *(empty)* | Comma-separated allow-list. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW` | `300` / `1 minute` | Per API key. |
| `MAX_UPLOAD_BYTES` | `5242880` | Request body cap. |
| `DISABLE_DOCS` | `false` | Set `true` in production. |

---

## The UI

`../index.html` is wired to this API through `../js/api.js` and
`../js/sync.js`.

- **Discovery.** The client probes same-origin, then `localhost:4000`. If none
  answer it stays on its `localStorage` cache and everything still works.
- **Optimistic writes.** The UI mutates its own arrays and re-renders
  immediately — dialling never waits on a network round-trip — and the sync
  layer mirrors changes to the server in a debounced batch. Failures are
  queued and retried rather than dropped.
- **Id rekeying.** A new lead is created locally with an `id_` prefix, then
  swapped for the server's UUID once the POST lands, so later edits hit the
  right row instead of 404ing.
- **Model translation.** The UI speaks `first`/`last`/`tz`/`value` (dollars)/
  `lastCalled` (epoch); the API speaks `firstName`/`lastName`/`timezone`/
  `valueCents`/`lastCalledAt` (ISO). All of it lives in `sync.js`.
- **Auth is per-browser.** The footer status line prompts for the `API_KEY`
  once and stores it in `localStorage`. That is a user credential, not a server
  secret — Sonetel's client secret and access token never reach the browser at
  all.
- **CSV import** goes through the server when it is reachable, so it benefits
  from the stricter RFC 4180 parser and per-row error reporting, and falls back
  to the in-browser path when offline.

`server/test/client-sync.test.ts` runs the *actual* client files in a `vm`
context against a real server over real HTTP, so the mapping and rekeying logic
is covered by the same suite as the API.

---

## Not included

Deliberately out of scope, and the things I would build next:

- **WebSockets.** `GET /api/calls/active` gives live state by polling; a socket
  would make the dialer console genuinely server-driven.
- **Multi-tenancy.** Single tenant by design. Adding orgs later means adding a
  tenant key and scoping every query — deliberately not half-built now.
- **Call recordings.** The schema has `recordingUrl`; storage and playback are
  not implemented.
- **Rate-limit correctness behind multiple instances.** `@fastify/rate-limit`
  is in-process. Two replicas means two buckets; use a Redis store before
  scaling out.
- **Real Sonetel verification.** See the telephony section above.
