import type { Pool, PoolConfig } from 'pg';

/**
 * Lifecycle state of a session.
 * - `active`: running and owned by a live orchestrator.
 * - `paused`: orchestrator shut down gracefully; recoverable on restart.
 * - `orphaned`: recovery found the sandbox gone; needs cleanup.
 * - `stale`: heartbeat lapsed past the threshold; marked for cleanup.
 * - `destroyed`: torn down.
 */
export type SessionStatus = 'active' | 'paused' | 'orphaned' | 'stale' | 'destroyed';
/** Lifecycle state of a sandbox container. */
export type SandboxStatus = 'running' | 'stopped' | 'destroyed';
/** Lifecycle state of an agent process (mirrors the orchestrator's AgentStatus). */
export type ProcessStatus = 'running' | 'exited' | 'error';

/** A session: the top of the coordination graph. */
export interface Session {
  sessionID: string;
  createdAt: Date;
  lastHeartbeat: Date;
  repoPath: string | null;
  status: SessionStatus;
}

/** A sandbox container belonging to a session. */
export interface Sandbox {
  containerID: string;
  sessionID: string;
  createdAt: Date;
  workspacePath: string;
  status: SandboxStatus;
}

/** An agent process running inside a sandbox, with its captured output buffers. */
export interface AgentProcess {
  agentID: string;
  sandboxID: string;
  sessionID: string;
  command: string[];
  status: ProcessStatus;
  processExitCode: number | null;
  stdoutBuffer: string;
  stderrBuffer: string;
  createdAt: Date;
}

/** A fully hydrated session graph, used to recover state after a restart. */
export interface SessionGraph {
  session: Session;
  sandboxes: Sandbox[];
  agents: AgentProcess[];
}

/** Configuration for a {@link SessionStore}. */
export interface SessionStoreConfig {
  /** PostgreSQL connection string. Ignored if `pool` is provided. */
  connectionString?: string;
  /** An existing pool to use (e.g. shared in tests). The store won't close it. */
  pool?: Pool;
  /** Minimum pooled connections. Default 0. */
  poolMin?: number;
  /** Maximum pooled connections. Clamped to [10, 50]. Default 10. */
  poolMax?: number;
  /**
   * Per-agent output buffer cap, enforced on append. Default 100 MB. Once a
   * write would exceed it, the buffer keeps the most-recent bytes and is prefixed
   * with a truncation marker. Applied in characters (= bytes for ASCII output).
   */
  maxBufferBytes?: number;
  /** Heartbeat interval for {@link SessionStore.startHeartbeat}. Default 30 s. */
  heartbeatIntervalMs?: number;
  /** Age after which a session with no heartbeat is stale. Default 5 min. */
  staleThresholdMs?: number;
}

/** Built-in defaults for {@link SessionStoreConfig}. */
export const DEFAULTS = {
  poolMin: 0,
  poolMax: 10,
  maxBufferBytes: 100 * 1024 * 1024,
  heartbeatIntervalMs: 30_000,
  staleThresholdMs: 5 * 60_000,
} as const;

/** Error raised for all persistence failures. */
export class PersistenceError extends Error {
  override readonly name = 'PersistenceError';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Derives a pg PoolConfig, clamping the max pool size into the supported
 * 10–50 concurrent-connection range.
 */
export function resolvePoolConfig(config: SessionStoreConfig): PoolConfig {
  const max = Math.min(50, Math.max(10, config.poolMax ?? DEFAULTS.poolMax));
  const min = Math.max(0, config.poolMin ?? DEFAULTS.poolMin);
  return { connectionString: config.connectionString, max, min };
}

/** Type guard for the two valid output streams (guards a dynamic column name). */
export function isOutputStream(stream: string): stream is 'stdout' | 'stderr' {
  return stream === 'stdout' || stream === 'stderr';
}

/** Serializes an argv array for the `command` column. */
export function serializeCommand(command: string[]): string {
  return JSON.stringify(command);
}

/** Parses a stored `command` value back into argv, tolerating legacy plain text. */
export function parseCommand(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
      return parsed as string[];
    }
  } catch {
    // fall through to legacy handling
  }
  return [text];
}

// --- Row shapes (snake_case, as returned by PostgreSQL) and their mappers -----

export interface SessionRow {
  session_id: string;
  created_at: Date;
  last_heartbeat: Date;
  repo_path: string | null;
  status: string;
}

export interface SandboxRow {
  container_id: string;
  session_id: string;
  created_at: Date;
  workspace_path: string;
  status: string;
}

export interface AgentRow {
  agent_id: string;
  sandbox_id: string;
  session_id: string;
  command: string;
  status: string;
  process_exit_code: number | null;
  stdout_buffer: string;
  stderr_buffer: string;
  created_at: Date;
}

export function mapSessionRow(row: SessionRow): Session {
  return {
    sessionID: row.session_id,
    createdAt: row.created_at,
    lastHeartbeat: row.last_heartbeat,
    repoPath: row.repo_path,
    status: row.status as SessionStatus,
  };
}

export function mapSandboxRow(row: SandboxRow): Sandbox {
  return {
    containerID: row.container_id,
    sessionID: row.session_id,
    createdAt: row.created_at,
    workspacePath: row.workspace_path,
    status: row.status as SandboxStatus,
  };
}

export function mapAgentRow(row: AgentRow): AgentProcess {
  return {
    agentID: row.agent_id,
    sandboxID: row.sandbox_id,
    sessionID: row.session_id,
    command: parseCommand(row.command),
    status: row.status as ProcessStatus,
    processExitCode: row.process_exit_code,
    stdoutBuffer: row.stdout_buffer,
    stderrBuffer: row.stderr_buffer,
    createdAt: row.created_at,
  };
}
