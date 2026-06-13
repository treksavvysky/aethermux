/**
 * Orchestrator — connection router + sandbox/agent manager.
 *
 * Phase 1 core. Responsibilities (implemented in subsequent child issues):
 *   - Provision and tear down isolated Docker sandboxes per repo/task.
 *   - Spawn CLI agent instances inside sandboxes via one generic spawn contract.
 *   - Multiplex agent stdout/stderr with per-agent stream buffering.
 *
 * Intentionally empty: this commit establishes structure only.
 */

export {};
