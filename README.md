# AetherMux

> A cross-platform **web workstation for multi-agent orchestration**.

AetherMux is a web-first, containerized orchestrator that multiplexes terminal
agents, browser sandboxes, and persistent database sessions into a single unified
dashboard. It is built for the **solo developer** who has moved from *writing code*
to *orchestrating fleets of specialized AI agents* (Claude Code, Aider, Codex,
Gemini CLI) — eliminating terminal chaos, platform lock-in, and information
blindness.

This repository is the canonical home of the AetherMux orchestrator. Product
strategy, issue contracts, and roadmaps are tracked in **Fluxion Core** under the
`AETHERMUX` product.

---

## Why it exists

Running many agents in parallel introduces severe friction:

- **Terminal chaos** — standard emulators can't separate concurrent agent workflows.
- **Platform lock-in** — desktop-native multiplexers (e.g. CMUX) are macOS-only.
- **Information blindness** — it's hard to tell when an agent is stuck, waiting, or done.
- **Transient context** — sandbox and session state is lost on restart or disconnect.

AetherMux bridges these gaps with multiplexed workspaces, visual attention rings,
and sessions that survive infrastructure restarts and network drops.

---

## Boundaries (what AetherMux is **not**)

These perimeters keep the product focused. Crossing one requires an explicit owner decision.

- **Not an agent or LLM framework.** No proprietary LLM logic or prompting. AetherMux is the
  utility wrapper and interface layer for existing CLI agents.
- **Not a project tracker.** *Where* agents execute (sandboxes, sessions, streams, attention)
  is ours; *what* work exists and why (issues, contracts, roadmaps) belongs to Fluxion Core.
- **Not a code host or file store.** Code and custom agent instructions live in Git. The session
  DB holds only ephemeral coordination state.
- **Not an IDE or terminal emulator.** We embed web VS Code and VNC; we multiplex and route,
  rendering is delegated.
- **Not a desktop application.** Web-first is the founding constraint. The browser — on Linux,
  macOS, Windows, or a tablet — is the only client.
- **Not a team platform.** Built for the solo operator. No accounts beyond the operator, no RBAC.

### Standing invariants

- **Agnosticism first** — every agent CLI integrates via the same spawn/stream contract.
- **HITL hand-off is sacred** — the attention system must never miss or fake a request for input;
  false greens are defects of the highest severity.
- **Sessions survive infrastructure** — restarts and network drops must never lose orchestration state.

---

## Phase 1 — The Core Multiplexer (current scope)

This repository currently targets **Phase 1**: standing up the orchestrator foundation.

- An orchestrator process that provisions and tears down isolated **Docker sandboxes** per repo/task.
- Spawning CLI agent instances inside sandboxes through **one generic spawn contract**.
- Multiplexing agent `stdout`/`stderr` with **per-agent stream buffering** and clean, attributable logs.
- Persisting **session-to-workspace mappings** in PostgreSQL so sessions survive orchestrator restarts.

> Later phases: **Phase 2** — the unified web console (split-pane terminals, live VNC, attention rings);
> **Phase 3** — inter-agent hand-offs via `/command-invoke`.

### Repository layout

```
src/orchestrator/   # connection router + sandbox/agent manager (Phase 1 core)
src/models/         # session + workspace domain models (PostgreSQL-backed)
test/               # test suites
deploy/             # Dockerfile and deployment configs
DECISIONS.md        # architecture decision log (language, runtime, etc.)
```

> **Status:** scaffolding only. This commit establishes structure, CI, and tooling.
> The actual agent-spawn, sandbox, and database layers follow in child issues of the
> Phase 1 epic (`AETHERMUX-1`).

---

## Tech stack

- **Runtime / language:** Node.js 20+ with TypeScript (ESM). See [`DECISIONS.md`](./DECISIONS.md).
- **CI:** GitHub Actions — lint, typecheck, build, and test on every push.

## Development

```bash
npm ci          # install dependencies
npm run lint    # eslint
npm run typecheck   # tsc --noEmit
npm run build   # compile TypeScript to dist/
npm test        # node --test
```

## License

MIT
