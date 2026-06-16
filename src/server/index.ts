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
  type AgentLogEvent,
  type AgentExitEvent,
} from './engine.js';
export { createApp, type AppOptions } from './http.js';
export { OPENAPI_SPEC } from './openapi.js';
export { OrchestratorSocket, type WebSocketOptions } from './ws.js';
export { isAuthorized, extractRequestToken } from './auth.js';
export {
  WS_PATH,
  parseClientMessage,
  type ServerMessage,
  type ClientMessage,
  type StdoutMessage,
  type StderrMessage,
  type ExitMessage,
  type ErrorMessage,
  type StdinMessage,
} from './ws-protocol.js';
