# AetherMux Console

The Phase 2 browser-only web console: a tabbed dashboard of live per-agent
terminals over the orchestrator's WebSocket transport. **Preact + Vite + xterm.js**
(see [`../DECISIONS.md`](../DECISIONS.md) ADR-0005 / the project decision log).

- **Browser-only** — no Electron, no desktop APIs. The browser is the only client.
- **Agent-agnostic** — every agent renders through the same xterm.js component;
  there is no per-agent rendering branch (see `src/registry.ts` / `src/ui/TerminalPane.tsx`).
- The wire contract is imported directly from the orchestrator's
  `src/server/ws-protocol.ts` and `api-types.ts` (no duplication) via `src/protocol.ts`.

## Architecture

The framework only renders the tab bar and the create form — high-frequency
agent output is written **directly** into xterm.js and bypasses the framework's
render cycle. The reusable logic is framework-agnostic and unit-tested:

```
src/
  protocol.ts   re-exports the shared WS/API types from ../../src/server
  config.ts     reads baseUrl + token from the page URL
  api.ts        ApiClient   — GET/POST/DELETE /sessions (+ graph for re-hydrate)
  socket.ts     ReconnectingSocket — auto-reconnect with exponential back-off
  registry.ts   TerminalRegistry   — routes {sessionId,agentId} frames to terminals
  store.ts      ConsoleStore       — observable tab/session state
  hydrate.ts    re-hydrate terminal history from GET /sessions/:id on reconnect
  terminal.ts   the real xterm.js factory (injectable, so tests don't need a browser)
  ui/           thin Preact view layer (App, TabBar, TerminalPane, CreateForm)
```

## Develop

```bash
npm install
npm run dev        # vite dev server
npm run typecheck  # tsc --noEmit (strict)
npm test           # vitest (logic suites in node + a jsdom App render test)
npm run build      # tsc --noEmit && vite build → dist/
```

### Pointing at an orchestrator

The orchestrator API is **fail-closed**, so the console needs the shared token,
supplied as a URL query param. `?api=` defaults to the page origin.

- **Bundled / same-origin** (the orchestrator serves this SPA — the default for
  `docker compose up`): just the token, no `?api=`, no CORS:
  ```
  http://localhost:8080/?token=<AETHERMUX_API_TOKEN>
  ```
- **Served separately** (e.g. `vite dev`, or the standalone nginx image) — point
  `?api=` at the orchestrator (CORS is enabled there for this case):
  ```
  http://localhost:5173/?api=http://localhost:8080&token=<AETHERMUX_API_TOKEN>
  ```

The WebSocket URL (`/ws?token=…`) is derived from `?api=` automatically.

## Security note — dev-toolchain advisories

`npm audit` reports advisories rooted in **esbuild's dev-server** (propagated
through Vite/Vitest version ranges). These are **development-only**: esbuild,
Vite and Vitest are devDependencies and are **not part of the shipped static
bundle** (`dist/`), and the dev-server issue is only reachable while running
`vite dev`. esbuild is pinned to a patched `^0.25.x` via `overrides`, so the
actual resolved dependency is fixed even though `npm audit` keys the advisory on
the Vite/Vitest version (whose only "fix" is the Vite 8 / Vitest 3 majors). That
major bump is deferred pending `@preact/preset-vite` compatibility and is worth a
follow-up hygiene task; it does not affect shipped code.
