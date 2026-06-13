# Architecture Decision Log

This file records significant, hard-to-reverse decisions for AetherMux, newest first.
Each entry is an ADR (Architecture Decision Record).

---

## ADR-0001 — Implementation language & runtime: Node.js + TypeScript

- **Date:** 2026-06-13
- **Status:** Accepted
- **Decision owner:** George Loudon
- **Issue:** AETHERMUX-2 (Establish aethermux repository, CI, and Fluxion product linkage)

### Context

AETHERMUX-2's technical intent requires the implementation language to be decided
immediately, between **Go** and **Node**, and recorded here. The choice anchors the
entire orchestrator and all three product phases.

### Decision

AetherMux is built on **Node.js (20+) with TypeScript (ESM)**.

### Rationale

- **Unified stack across all phases.** Phase 1 is the orchestrator core, but Phase 2 is a
  web console and Phase 3 is inter-agent hand-offs in the browser. A single TypeScript
  codebase shares domain types end-to-end (over WebSocket) instead of splitting into two
  language ecosystems.
- **Mature multiplexing tooling.** `node-pty` (PTY-backed agent processes), `dockerode`
  (sandbox lifecycle), `ws` and `xterm.js` (stream transport + rendering) are exactly the
  primitives Phase 1 and 2 need.
- **Solo-developer velocity.** The target user is a solo operator; a single toolchain,
  shared types, and a fast edit/run loop matter more than raw concurrency throughput at
  this scale.
- **Environment readiness.** Node 20 is already provisioned in the build/runtime environment.

### Consequences

- Concurrency relies on Node's event loop + async I/O rather than Go's goroutines. For
  stream multiplexing this is sufficient; CPU-bound work (if any later arises) will be
  isolated into worker threads or out-of-process workers.
- Tooling baseline: `tsc` for builds, `eslint` (flat config + `typescript-eslint`) for lint,
  and the built-in `node:test` runner for tests.
- Deployment artifacts are Node-based container images (see `deploy/Dockerfile`).

### Alternatives considered

- **Go.** Strong fit for the concurrency-heavy core (goroutines/channels, single static
  binary, shared lineage with Docker/Kubernetes). Rejected primarily because it would split
  the web-first product into two stacks across phases and slow solo-developer iteration; Go
  was also not provisioned in the current environment.
