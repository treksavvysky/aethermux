/**
 * Orchestrator — the generic CLI agent spawn contract and stream multiplexer
 * (AETHERMUX-4). Agents run inside provisioned sandboxes; their output is
 * captured into isolated, per-agent buffers (AETHERMUX-3 provides the sandboxes).
 */

export { Orchestrator } from './orchestrator.js';
export { AgentHandle, type AgentExit } from './agent-handle.js';
export { AgentLogBuffer } from './log-buffer.js';
export {
  SpawnError,
  formatAgentId,
  formatLogEntry,
  toEnvArray,
  validateSpawnContract,
  type SpawnContract,
  type LogEntry,
  type StreamKind,
  type AgentStatus,
} from './types.js';
