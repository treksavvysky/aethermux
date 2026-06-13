import { randomUUID } from 'node:crypto';

import type { SandboxProvisioner } from '../sandbox/index.js';
import type { AgentHandle, LogEntry, Orchestrator } from '../orchestrator/index.js';
import type { Session, SessionGraph, SessionStore } from '../persistence/index.js';

/** Collaborators the engine drives. Injected so they can be faked in tests. */
export interface EngineDeps {
  store: SessionStore;
  provisioner: SandboxProvisioner;
  spawner: Orchestrator;
}

/** Engine tuning. */
export interface EngineConfig {
  /** How often agent output buffers are flushed to the DB. Default 1000 ms. */
  flushIntervalMs?: number;
  /** Working directory inside the sandbox. Default `/workspace`. */
  workspaceDir?: string;
}

/** Request body for {@link OrchestratorEngine.createSession}. */
export interface CreateSessionRequest {
  repoPath?: string | null;
  command: string[];
  env?: Record<string, string>;
}

/** Outcome of a {@link OrchestratorEngine.recover} pass. */
export interface RecoveryResult {
  reconnected: string[];
  orphaned: string[];
}

interface AgentRecord {
  handle: AgentHandle;
  sessionID: string;
  pendingStdout: string;
  pendingStderr: string;
  exited: { status: 'exited' | 'error'; exitCode: number | null } | null;
  statusPersisted: boolean;
}

/**
 * The orchestrator's core: it integrates the sandbox provisioner, the agent
 * spawner, and the session store into one process. It creates sessions
 * (provision → spawn → persist), periodically flushes agent output to the DB,
 * pauses everything on graceful shutdown, and — on startup — recovers paused
 * sessions whose sandboxes are still alive.
 *
 * Single-process by design (no Kubernetes); no transactions (last-write-wins).
 */
export class OrchestratorEngine {
  private readonly store: SessionStore;
  private readonly provisioner: SandboxProvisioner;
  private readonly spawner: Orchestrator;
  private readonly flushIntervalMs: number;
  private readonly workspaceDir: string;

  private readonly agents = new Map<string, AgentRecord>();
  private readonly sessions = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(deps: EngineDeps, config: EngineConfig = {}) {
    this.store = deps.store;
    this.provisioner = deps.provisioner;
    this.spawner = deps.spawner;
    this.flushIntervalMs = config.flushIntervalMs ?? 1000;
    this.workspaceDir = config.workspaceDir ?? '/workspace';
  }

  /** Starts the periodic DB flush loop (once per {@link flushIntervalMs}). */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flushBuffers(), this.flushIntervalMs);
    this.flushTimer.unref();
  }

  /**
   * Provisions a sandbox, spawns the agent, and persists the whole graph, then
   * begins streaming the agent's output into the DB. Returns the new session id.
   */
  async createSession(req: CreateSessionRequest): Promise<{ sessionID: string }> {
    if (!Array.isArray(req.command) || req.command.length === 0) {
      throw new Error('createSession requires a non-empty command (argv)');
    }
    const sessionID = `s-${randomUUID()}`;
    const repoPath = req.repoPath ?? null;

    await this.store.createSession({ sessionID, repoPath, status: 'active' });
    this.sessions.add(sessionID);

    let containerID: string | undefined;
    try {
      const sandbox = await this.provisioner.create(repoPath, sessionID);
      containerID = sandbox.containerID;
      await this.store.upsertSandbox({
        containerID,
        sessionID,
        workspacePath: sandbox.workspacePath,
        status: 'running',
      });

      const handle = await this.spawner.spawn({
        sessionID,
        containerID,
        command: req.command,
        workspaceDir: this.workspaceDir,
        env: req.env ?? {},
      });

      const agentID = this.agentDbId(sessionID, handle.id);
      await this.store.upsertAgent({
        agentID,
        sandboxID: containerID,
        sessionID,
        command: req.command,
        status: 'running',
      });
      this.track(agentID, handle, sessionID);
    } catch (err) {
      // Best-effort cleanup so a failed create leaves no live sandbox behind.
      if (containerID) await this.provisioner.destroy(containerID).catch(() => undefined);
      await this.store.destroySession(sessionID).catch(() => undefined);
      this.sessions.delete(sessionID);
      throw err;
    }

    return { sessionID };
  }

  /** Hydrates a session graph from the DB. */
  async getSession(sessionID: string): Promise<SessionGraph | null> {
    return this.store.getSession(sessionID);
  }

  /** Lists currently active sessions. */
  async listActiveSessions(): Promise<Session[]> {
    return this.store.listActiveSessions();
  }

  /** Destroys a session: tears down its sandboxes and removes its rows. */
  async destroySession(sessionID: string): Promise<boolean> {
    const graph = await this.store.getSession(sessionID);
    if (graph) {
      for (const sandbox of graph.sandboxes) {
        await this.provisioner.destroy(sandbox.containerID).catch(() => undefined);
      }
    }
    for (const [agentID, rec] of this.agents) {
      if (rec.sessionID === sessionID) this.agents.delete(agentID);
    }
    this.sessions.delete(sessionID);
    return this.store.destroySession(sessionID);
  }

  /**
   * Flushes each agent's accumulated output to its DB buffer and persists any
   * terminal status. Re-entrancy-guarded so a slow flush never overlaps itself.
   */
  async flushBuffers(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [agentID, rec] of this.agents) {
        if (rec.pendingStdout) {
          const text = rec.pendingStdout;
          rec.pendingStdout = '';
          await this.store.appendAgentOutput(agentID, 'stdout', text).catch(() => undefined);
        }
        if (rec.pendingStderr) {
          const text = rec.pendingStderr;
          rec.pendingStderr = '';
          await this.store.appendAgentOutput(agentID, 'stderr', text).catch(() => undefined);
        }
        if (rec.exited && !rec.statusPersisted) {
          rec.statusPersisted = true;
          await this.store
            .updateAgentStatus(agentID, rec.exited.status, rec.exited.exitCode)
            .catch(() => undefined);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Graceful shutdown: stop the flush loop, persist a final flush, mark every
   * owned session `paused`, detach stream listeners, and close the store.
   * Sandboxes are deliberately left running so they can be recovered.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushBuffers();

    for (const sessionID of this.sessions) {
      await this.store.updateSession(sessionID, { status: 'paused' }).catch(() => undefined);
    }
    for (const rec of this.agents.values()) {
      try {
        rec.handle.removeAllListeners();
      } catch {
        // ignore
      }
    }
    this.agents.clear();
    this.sessions.clear();
    await this.store.close().catch(() => undefined);
  }

  /**
   * Startup recovery: for each `paused` session, conservatively reconnect if a
   * sandbox container is still running, otherwise mark the session `orphaned`.
   *
   * Note: a live `docker exec` cannot be re-attached after our client process
   * died, so "re-attach" here means re-establishing ownership of the surviving
   * sandbox (its workspace is intact); a fresh agent can be spawned into it.
   */
  async recover(): Promise<RecoveryResult> {
    const paused = await this.store.listSessionsByStatus('paused');
    const reconnected: string[] = [];
    const orphaned: string[] = [];

    for (const session of paused) {
      const graph = await this.store.getSession(session.sessionID);
      const sandboxes = graph?.sandboxes ?? [];
      let anyRunning = false;

      for (const sandbox of sandboxes) {
        const running = await this.provisioner.isRunning(sandbox.containerID).catch(() => false);
        if (running) {
          anyRunning = true;
        } else {
          await this.store
            .upsertSandbox({
              containerID: sandbox.containerID,
              sessionID: session.sessionID,
              workspacePath: sandbox.workspacePath,
              status: 'stopped',
            })
            .catch(() => undefined);
        }
      }

      if (anyRunning) {
        await this.store.updateSession(session.sessionID, { status: 'active' });
        this.sessions.add(session.sessionID);
        reconnected.push(session.sessionID);
      } else {
        await this.store.updateSession(session.sessionID, { status: 'orphaned' });
        orphaned.push(session.sessionID);
      }
    }

    return { reconnected, orphaned };
  }

  private agentDbId(sessionID: string, handleId: string): string {
    return `${sessionID}:${handleId}`;
  }

  private track(agentID: string, handle: AgentHandle, sessionID: string): void {
    const rec: AgentRecord = {
      handle,
      sessionID,
      pendingStdout: '',
      pendingStderr: '',
      exited: null,
      statusPersisted: false,
    };
    this.agents.set(agentID, rec);

    handle.on('log', (entry: LogEntry) => {
      if (entry.stream === 'stdout') rec.pendingStdout += `${entry.text}\n`;
      else rec.pendingStderr += `${entry.text}\n`;
    });
    handle.on('exit', (exit: { status: 'exited' | 'error'; exitCode: number | null }) => {
      rec.exited = exit;
    });
  }
}
