/**
 * Server — the orchestrator main loop (AETHERMUX-6). Integrates the sandbox
 * provisioner, agent spawner, and session store into one process with an HTTP
 * API, periodic state persistence, graceful shutdown, and startup recovery.
 */

export {
  OrchestratorEngine,
  type EngineDeps,
  type EngineConfig,
  type CreateSessionRequest,
  type RecoveryResult,
} from './engine.js';
export { createApp } from './http.js';
export { OPENAPI_SPEC } from './openapi.js';
