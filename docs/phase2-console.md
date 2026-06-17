# Phase 2 — Unified Web Console

The Phase 2 console is a browser-only SPA (Preact + Vite + xterm.js) that
multiplexes the Phase 1 orchestrator's agents into a tabbed dashboard with live
terminals, real-time stdin, and attention rings. It consumes the orchestrator's
WebSocket transport and session API.

- Console source & its own README: [`../console/`](../console/)
- WebSocket protocol reference: [`../WEBSOCKET.md`](../WEBSOCKET.md)
- Session HTTP API contract: `src/server/api-types.ts` + `GET /openapi.json`

---

## Run the full stack locally (Docker Compose)

```bash
docker compose up --build
```

This starts three services:

| Service | Port | What |
| --- | --- | --- |
| `postgres` | 5432 | session-state DB |
| `orchestrator` | 8080 | Phase 1 orchestrator: HTTP API + WebSocket `/ws` (mounts the Docker socket to provision sandboxes) |
| `console` | 5173 | the static SPA, served by nginx |

Then open the console, passing the orchestrator API base and the shared token as
query params (the API is **fail-closed**; the console reaches it cross-origin and
CORS is enabled on the orchestrator):

```
http://localhost:5173/?api=http://localhost:8080&token=local-dev-token
```

`local-dev-token` is the Compose default for `AETHERMUX_API_TOKEN`; override it
(and any other variable from [`../.env.example`](../.env.example)) via the
environment for anything beyond local dev. No other manual steps are required.

Tear down (drop the DB volume too with `-v`):

```bash
docker compose down -v
```

---

## Run the CI checks locally

CI runs everything below in a single `ci` job. To reproduce locally:

**Orchestrator** (repo root) — needs a reachable Postgres for the integration
tests (or they skip):

```bash
npm ci
npm run lint
npm run typecheck
npm run build
AETHERMUX_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5433/aethermux_test npm test
```

The suite includes the WebSocket transport integration tests (against a real
in-process orchestrator) and the attention-ring **false-green** regression test
(`test/attention.*.test.js`).

**Console** (`console/`) — no infra needed (logic is unit-tested with injected
fakes; a jsdom test covers rendering):

```bash
cd console
npm ci
npm run typecheck
npm test
npm run build
```

**Full-stack images / compose** validation:

```bash
docker compose config -q     # validate the compose file
docker compose build         # build the orchestrator + console images
```

CI runs in well under 10 minutes on a standard runner.

---

## WebSocket message envelope (reference)

Every frame carries `sessionId` + `agentId` so one connection multiplexes across
agents. Full details and auth in [`../WEBSOCKET.md`](../WEBSOCKET.md); summary:

**Server → client**

| `type` | shape |
| --- | --- |
| `stdout` / `stderr` | `{ type, sessionId, agentId, payload: string }` |
| `exit` | `{ type, sessionId, agentId, payload: { status, exitCode } }` |
| `agentState` | `{ type, sessionId, agentId, state }` — `running` \| `awaiting-input` \| `exited` \| `error` (drives attention rings) |
| `error` | `{ type, payload: string, sessionId?, agentId? }` |

**Client → server**

| `type` | shape |
| --- | --- |
| `stdin` | `{ type: 'stdin', sessionId, agentId, data: string }` |

The TypeScript types are the source of truth in `src/server/ws-protocol.ts`
(imported by the console — no duplication).
