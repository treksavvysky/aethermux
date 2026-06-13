# Architecture Decision Log

This file records significant, hard-to-reverse decisions for AetherMux, newest first.
Each entry is an ADR (Architecture Decision Record).

---

## ADR-0002 — CI job name and main branch-protection contexts are one contract

- **Date:** 2026-06-13
- **Status:** Accepted
- **Issue:** AETHERMUX-8

### Context

`main` branch protection gates merges on a required status check whose name must
**exactly** match a check GitHub Actions emits. For a single-job workflow, that
context is the job's name. The job was originally named `lint · typecheck · build
· test` — a brittle, non-ASCII display string (note the `·` middle dots). Branch
protection was twice misconfigured to require contexts CI never emitted, which
blocked every PR until corrected.

### Decision

- The CI workflow exposes **one stable, ASCII context: the job `ci`**
  (`.github/workflows/ci.yml` → `jobs.ci`). It runs lint, typecheck, build, and
  test as steps.
- `main` branch protection requires exactly the `ci` context.
- **The CI job name and `required_status_checks.contexts` are a single contract.**
  Renaming or restructuring the CI job(s) without updating branch protection (or
  vice-versa) leaves the gate waiting on a context that never reports, blocking
  all PRs. Change them together, and source the context name from the check-runs
  API rather than retyping it.

### Merge-flow invariants (preserved)

PR-to-`main` flow; **strict** status checks (branch must be up to date); **no
required reviews** (a solo operator cannot self-approve on GitHub); `enforce_admins
= false` retained as break-glass; force-pushes and branch deletion blocked.

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
