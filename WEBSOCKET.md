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
`AETHERMUX_API_TOKEN`.

- If `AETHERMUX_API_TOKEN` is **unset**, the API is open (local dev).
- If it is **set**, the upgrade is rejected with `401` unless the token is
  presented. Browsers can't set headers on a WebSocket handshake, so the token
  is supplied as a query parameter:

```
ws://host:8080/ws?token=<AETHERMUX_API_TOKEN>
```

Non-browser clients may instead send `Authorization: Bearer <token>` or an
`x-api-token` header. The HTTP API accepts the same three carriers.

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
| `error`  | `{ type, payload: string, sessionId?, agentId? }` | a problem with a prior client frame |

All connected clients receive every agent's output (broadcast); the client
filters by `sessionId` + `agentId`.

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
