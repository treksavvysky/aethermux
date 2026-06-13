import pg from 'pg';
import type { Pool } from 'pg';

import { runMigrations } from './migrator.js';
import {
  DEFAULTS,
  PersistenceError,
  isOutputStream,
  mapAgentRow,
  mapSandboxRow,
  mapSessionRow,
  resolvePoolConfig,
  serializeCommand,
  type AgentProcess,
  type AgentRow,
  type ProcessStatus,
  type Sandbox,
  type SandboxRow,
  type SandboxStatus,
  type Session,
  type SessionGraph,
  type SessionRow,
  type SessionStatus,
  type SessionStoreConfig,
} from './types.js';

/** Input to {@link SessionStore.createSession}. */
export interface CreateSessionInput {
  sessionID: string;
  repoPath?: string | null;
  status?: SessionStatus;
}

/** Patch accepted by {@link SessionStore.updateSession}. */
export interface SessionPatch {
  repoPath?: string | null;
  status?: SessionStatus;
  lastHeartbeat?: Date;
}

/** Input to {@link SessionStore.upsertSandbox}. */
export interface SandboxInput {
  containerID: string;
  sessionID: string;
  workspacePath: string;
  status?: SandboxStatus;
}

/** Input to {@link SessionStore.upsertAgent}. */
export interface AgentInput {
  agentID: string;
  sandboxID: string;
  sessionID: string;
  command: string[];
  status?: ProcessStatus;
  processExitCode?: number | null;
}

/**
 * The persistence layer for AetherMux's ephemeral coordination state.
 *
 * Backed by PostgreSQL via a pooled `pg` connection. Stores the
 * session → sandbox → agent graph so a freshly started orchestrator can query
 * {@link listActiveSessions} / {@link getSession} and reconnect to in-flight
 * sandboxes and agents — the "sessions survive infrastructure" invariant.
 *
 * Phase 1 uses no explicit transactions: row-level conflicts resolve
 * last-write-wins (upserts), as specified by the contract.
 */
export class SessionStore {
  private readonly _pool: Pool;
  private readonly ownsPool: boolean;
  private readonly maxBufferBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly staleThresholdMs: number;

  constructor(config: SessionStoreConfig = {}) {
    this._pool = config.pool ?? new pg.Pool(resolvePoolConfig(config));
    this.ownsPool = config.pool === undefined;
    this.maxBufferBytes = config.maxBufferBytes ?? DEFAULTS.maxBufferBytes;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.staleThresholdMs = config.staleThresholdMs ?? DEFAULTS.staleThresholdMs;
  }

  /** Creates a store and applies migrations. The intended entry point. */
  static async connect(config: SessionStoreConfig = {}): Promise<SessionStore> {
    const store = new SessionStore(config);
    await store.migrate();
    return store;
  }

  /** The underlying connection pool (for health checks / advanced use). */
  get pool(): Pool {
    return this._pool;
  }

  /** Applies any pending schema migrations. */
  async migrate(): Promise<void> {
    await runMigrations(this._pool);
  }

  /** Verifies connectivity through the pool. Returns true on success. */
  async healthcheck(): Promise<boolean> {
    const result = await this._pool.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  }

  // --- Sessions --------------------------------------------------------------

  async createSession(input: CreateSessionInput): Promise<Session> {
    const result = await this.query<SessionRow>(
      `INSERT INTO sessions (session_id, repo_path, status)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [input.sessionID, input.repoPath ?? null, input.status ?? 'active'],
    );
    return mapSessionRow(result.rows[0]);
  }

  async updateSession(sessionID: string, patch: SessionPatch): Promise<Session | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (patch.repoPath !== undefined) {
      values.push(patch.repoPath);
      fields.push(`repo_path = $${values.length}`);
    }
    if (patch.status !== undefined) {
      values.push(patch.status);
      fields.push(`status = $${values.length}`);
    }
    if (patch.lastHeartbeat !== undefined) {
      values.push(patch.lastHeartbeat);
      fields.push(`last_heartbeat = $${values.length}`);
    }
    if (fields.length === 0) {
      return this.getSessionRow(sessionID);
    }
    values.push(sessionID);
    const result = await this.query<SessionRow>(
      `UPDATE sessions SET ${fields.join(', ')} WHERE session_id = $${values.length} RETURNING *`,
      values,
    );
    return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
  }

  /** Hydrates a full session graph (session + sandboxes + agents), or null. */
  async getSession(sessionID: string): Promise<SessionGraph | null> {
    const session = await this.getSessionRow(sessionID);
    if (!session) return null;

    const sandboxes = await this.query<SandboxRow>(
      'SELECT * FROM sandboxes WHERE session_id = $1 ORDER BY created_at',
      [sessionID],
    );
    const agents = await this.query<AgentRow>(
      'SELECT * FROM agent_processes WHERE session_id = $1 ORDER BY created_at',
      [sessionID],
    );
    return {
      session,
      sandboxes: sandboxes.rows.map(mapSandboxRow),
      agents: agents.rows.map(mapAgentRow),
    };
  }

  /** Deletes a session and (via ON DELETE CASCADE) its sandboxes and agents. */
  async destroySession(sessionID: string): Promise<boolean> {
    const result = await this.query('DELETE FROM sessions WHERE session_id = $1', [sessionID]);
    return (result.rowCount ?? 0) > 0;
  }

  /** All sessions currently in the `active` status. */
  async listActiveSessions(): Promise<Session[]> {
    return this.listSessionsByStatus('active');
  }

  /** All sessions in a given status (e.g. `paused` during recovery). */
  async listSessionsByStatus(status: SessionStatus): Promise<Session[]> {
    const result = await this.query<SessionRow>(
      'SELECT * FROM sessions WHERE status = $1 ORDER BY created_at',
      [status],
    );
    return result.rows.map(mapSessionRow);
  }

  // --- Sandboxes & agents ----------------------------------------------------

  async upsertSandbox(input: SandboxInput): Promise<Sandbox> {
    const result = await this.query<SandboxRow>(
      `INSERT INTO sandboxes (container_id, session_id, workspace_path, status)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (container_id) DO UPDATE
         SET session_id = EXCLUDED.session_id,
             workspace_path = EXCLUDED.workspace_path,
             status = EXCLUDED.status
       RETURNING *`,
      [input.containerID, input.sessionID, input.workspacePath, input.status ?? 'running'],
    );
    return mapSandboxRow(result.rows[0]);
  }

  async upsertAgent(input: AgentInput): Promise<AgentProcess> {
    const result = await this.query<AgentRow>(
      `INSERT INTO agent_processes (agent_id, sandbox_id, session_id, command, status, process_exit_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id) DO UPDATE
         SET sandbox_id = EXCLUDED.sandbox_id,
             session_id = EXCLUDED.session_id,
             command = EXCLUDED.command,
             status = EXCLUDED.status,
             process_exit_code = EXCLUDED.process_exit_code
       RETURNING *`,
      [
        input.agentID,
        input.sandboxID,
        input.sessionID,
        serializeCommand(input.command),
        input.status ?? 'running',
        input.processExitCode ?? null,
      ],
    );
    return mapAgentRow(result.rows[0]);
  }

  async updateAgentStatus(agentID: string, status: ProcessStatus, exitCode: number | null = null): Promise<void> {
    await this.query(
      'UPDATE agent_processes SET status = $2, process_exit_code = $3 WHERE agent_id = $1',
      [agentID, status, exitCode],
    );
  }

  /**
   * Appends output to an agent's buffer, capping it at `maxBufferBytes` by
   * keeping the most recent characters (done in SQL via `right()`, so it stays
   * atomic and last-write-wins without a transaction).
   */
  async appendAgentOutput(agentID: string, stream: string, text: string): Promise<void> {
    if (!isOutputStream(stream)) {
      throw new PersistenceError(`Invalid output stream ${JSON.stringify(stream)}`);
    }
    const column = stream === 'stdout' ? 'stdout_buffer' : 'stderr_buffer';
    await this.query(
      `UPDATE agent_processes SET ${column} = right(${column} || $2, $3) WHERE agent_id = $1`,
      [agentID, text, this.maxBufferBytes],
    );
  }

  // --- Heartbeat & staleness -------------------------------------------------

  /** Records a heartbeat for a session (sets last_heartbeat to now). */
  async recordHeartbeat(sessionID: string): Promise<void> {
    await this.query('UPDATE sessions SET last_heartbeat = now() WHERE session_id = $1', [sessionID]);
  }

  /**
   * Marks every active session whose last heartbeat is older than the threshold
   * as `stale` (i.e. ready for cleanup). Returns the affected session ids.
   */
  async markStaleSessions(thresholdMs: number = this.staleThresholdMs): Promise<string[]> {
    const seconds = thresholdMs / 1000;
    const result = await this.query<{ session_id: string }>(
      `UPDATE sessions SET status = 'stale'
       WHERE status = 'active' AND last_heartbeat < now() - make_interval(secs => $1)
       RETURNING session_id`,
      [seconds],
    );
    return result.rows.map((r) => r.session_id);
  }

  /**
   * Starts a recurring heartbeat for `sessionID` (default every 30 s) and
   * returns a function that stops it. The timer is unref'd so it never keeps
   * the process alive on its own.
   */
  startHeartbeat(sessionID: string, intervalMs: number = this.heartbeatIntervalMs): () => void {
    const timer = setInterval(() => {
      void this.recordHeartbeat(sessionID).catch(() => undefined);
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Closes the pool if this store created it (no-op for an injected pool). */
  async close(): Promise<void> {
    if (this.ownsPool) {
      await this._pool.end();
    }
  }

  // --- internals -------------------------------------------------------------

  private async getSessionRow(sessionID: string): Promise<Session | null> {
    const result = await this.query<SessionRow>('SELECT * FROM sessions WHERE session_id = $1', [sessionID]);
    return result.rows[0] ? mapSessionRow(result.rows[0]) : null;
  }

  private async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
    try {
      return await this._pool.query<R>(text, values);
    } catch (err) {
      throw new PersistenceError('Query failed', err);
    }
  }
}
