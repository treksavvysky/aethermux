/**
 * Persistence — the PostgreSQL session-state layer (AETHERMUX-5).
 *
 * Stores only ephemeral coordination state (the session → sandbox → agent
 * graph) so a restarted orchestrator can recover in-flight work. Never stores
 * files; Git remains the source of truth.
 */

export { SessionStore, TRUNCATION_MARKER } from './session-store.js';
export type {
  CreateSessionInput,
  SessionPatch,
  SandboxInput,
  AgentInput,
} from './session-store.js';
export { runMigrations } from './migrator.js';
export { MIGRATIONS, type Migration } from './schema.js';
export {
  DEFAULTS,
  PersistenceError,
  resolvePoolConfig,
  isOutputStream,
  serializeCommand,
  parseCommand,
  mapSessionRow,
  mapSandboxRow,
  mapAgentRow,
  type Session,
  type Sandbox,
  type AgentProcess,
  type SessionGraph,
  type SessionStatus,
  type SandboxStatus,
  type ProcessStatus,
  type SessionStoreConfig,
} from './types.js';
