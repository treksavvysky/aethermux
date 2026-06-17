# WebSocket streaming transport

The orchestrator exposes a real-time WebSocket transport **on the same HTTP
server** (no separate port) for live per-agent terminal streaming. It is the
foundation for the Phase 2 web console.

- **Path:** `/ws` (exported as `WS_PATH`).
- **Relationship to Postgres:** purely additive. Agent output still flushes to
  Postgres on the ~1s loop for restart recovery; the WebSocket is a parallel,
  synchronous fan-out emitted as each line arrives (well within the 100 ms
  target — typically single-digit milliseconds on a local connection).

## Authentication

The WebSocket uses the **same mechanism as the HTTP API**: the shared
`AETHERMUX_API_TOKEN`, validated **fail-closed** (per the AetherMux API
authentication Decision, 2026-06-16).

- The token is **required**. The orchestrator refuses to start without it, and
  any upgrade without the matching token is rejected with `401` — there is no
  open mode (no open relay).
- Browsers can't set headers on a WebSocket handshake, so the token is supplied
  as a query parameter:

```
ws://host:8080/ws?token=<AETHERMUX_API_TOKEN>
```

Non-browser clients may instead send `Authorization: Bearer <token>` or an
`x-api-token` header. The HTTP API accepts the same three carriers. (`/healthz`
is the one unauthenticated endpoint, for liveness probes.)

## Message framing

Every frame is JSON and carries `sessionId` + `agentId`, so a single connection
can be **demultiplexed across any number of agents**. The wire types are the
source of truth in [`src/server/ws-protocol.ts`](./src/server/ws-protocol.ts)
(imported by the frontend so client and server cannot drift).

### Server → client

| `type` | shape | meaning |
| --- | --- | --- |
| `stdout` | `{ type, sessionId, agentId, payload: string }` | one line of agent stdout |
| `stderr` | `{ type, sessionId, agentId, payload: string }` | one line of agent stderr |
| `exit`   | `{ type, sessionId, agentId, payload: { status, exitCode } }` | the agent process terminated |
| `agentState` | `{ type, sessionId, agentId, state }` | an attention state-machine transition (`running` \| `awaiting-input` \| `exited` \| `error`) |
| `error`  | `{ type, payload: string, sessionId?, agentId? }` | a problem with a prior client frame |

All connected clients receive every agent's output (broadcast); the client
filters by `sessionId` + `agentId`.

## Attention state (rings)

Each agent has an authoritative state machine in the orchestrator
([`src/server/attention.ts`](./src/server/attention.ts)) whose value drives the
console's attention rings. States and transitions:

- `running` → `awaiting-input` when a **real stdout prompt** is detected, and
  back to `running` when stdin is injected.
- → `exited` **only** on a real process exit with code 0 (green), or `error` on a
  non-zero exit or a stream/spawn error.

Every transition is logged and broadcast as an `agentState` frame, and the
current value is also surfaced in `GET /sessions` (`attentionState`) so the
console can colour a ring before the stream connects.

**Detection strategy.** `awaiting-input` is entered by matching newline-terminated
stdout lines against a configurable regex list (`DEFAULT_PROMPT_PATTERNS`, or
`EngineConfig.promptPatterns`) — a **real signal**, not a timeout/heuristic. The
defaults cover generic `?`/`>`/`(y/n)`/`press enter` prompts and the confirmation
phrasings of common CLI agents (Claude Code, Aider); the console renders the ring
with **no per-agent code**. Limitation: a prompt printed without a trailing
newline stays in the line buffer and is matched only once a newline arrives — a
PTY-based enhancement is deferred to a later phase.

**No false greens.** `exited` (green) is reachable solely via a real exit-code-0
process exit — never inferred from output, prompts, or timeouts. This is enforced
by the state machine and guarded by unit, integration, and console-render tests.

### Client → server

| `type` | shape | meaning |
| --- | --- | --- |
| `stdin` | `{ type: 'stdin', sessionId, agentId, data: string }` | inject `data` into that agent's stdin |

Stdin is written to the agent's process with back-pressure (the write resolves
once the pipe drains). An unknown/again-not-live agent yields an `error` frame
to the sender. Stdin only reaches **live, locally-tracked** agents (those spawned
by the running orchestrator instance).

## Example (browser)

```js
const ws = new WebSocket(`ws://localhost:8080/ws?token=${TOKEN}`);
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'stdout' || msg.type === 'stderr') {
    terminals[`${msg.sessionId}/${msg.agentId}`]?.write(msg.payload + '\n');
  }
};
// send a keystroke to a specific agent
ws.send(JSON.stringify({ type: 'stdin', sessionId, agentId, data: 'ls\n' }));
```
