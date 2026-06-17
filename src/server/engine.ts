import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { SandboxProvisioner } from '../sandbox/index.js';
import type { AgentHandle, LogEntry, Orchestrator } from '../orchestrator/index.js';
import type { AgentProcess, Session, SessionGraph, SessionStore } from '../persistence/index.js';
import {
  deriveAttentionState,
  type AttentionState,
  type CreateSessionRequest,
  type SessionSummary,
} from './api-types.js';

export type { CreateSessionRequest };

/** Emitted (event `agentLog`) for every captured line of agent output. */
export interface AgentLogEvent {
  sessionId: string;
  agentId: string;
  stream: 'stdout' | 'stderr';
  text: string;
  timestamp: string;
}

/** Emitted (event `agentExit`) when an agent process terminates. */
export interface AgentExitEvent {
  sessionId: string;
  agentId: string;
  status: 'exited' | 'error';
  exitCode: number | null;
}

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
  /** Grace period for SIGTERM before SIGKILL when terminating. Default 10 s. */
  terminateTimeoutSeconds?: number;
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
 *
 * Extends EventEmitter and emits `agentLog` ({@link AgentLogEvent}) and
 * `agentExit` ({@link AgentExitEvent}) as agents produce output / terminate, so
 * a real-time transport (the WebSocket layer) can fan them out without changing
 * the DB-persistence path.
 */
export class OrchestratorEngine extends EventEmitter {
  private readonly store: SessionStore;
  private readonly provisioner: SandboxProvisioner;
  private readonly spawner: Orchestrator;
  private readonly flushIntervalMs: number;
  private readonly workspaceDir: string;
  private readonly terminateTimeoutSeconds: number;

  private readonly agents = new Map<string, AgentRecord>();
  private readonly sessions = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(deps: EngineDeps, config: EngineConfig = {}) {
    super();
    this.store = deps.store;
    this.provisioner = deps.provisioner;
    this.spawner = deps.spawner;
    this.flushIntervalMs = config.flushIntervalMs ?? 1000;
    this.workspaceDir = config.workspaceDir ?? '/workspace';
    this.terminateTimeoutSeconds = config.terminateTimeoutSeconds ?? 10;
  }

  /**
   * Injects stdin into a live agent's process. Resolves once the data has been
   * written (the underlying write applies back-pressure when the pipe is full).
   * Throws if the agent is not a live, locally-tracked agent.
   */
  async sendStdin(sessionId: string, agentId: string, data: string): Promise<void> {
    const rec = this.agents.get(this.agentDbId(sessionId, agentId));
    if (!rec) {
      throw new Error(`No live agent ${sessionId}:${agentId}`);
    }
    await rec.handle.write(data);
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

  /** A console-facing summary of one session (or null if it does not exist). */
  async getSessionSummary(sessionID: string): Promise<SessionSummary | null> {
    const graph = await this.store.getSession(sessionID);
    if (!graph) return null;
    return this.toSummary(graph.session, graph.agents[0]);
  }

  /** Console-facing summaries of all active sessions, with attention state. */
  async listSessionSummaries(): Promise<SessionSummary[]> {
    const sessions = await this.store.listActiveSessions();
    const summaries: SessionSummary[] = [];
    for (const session of sessions) {
      const graph = await this.store.getSession(session.sessionID);
      summaries.push(this.toSummary(session, graph?.agents[0]));
    }
    return summaries;
  }

  /**
   * Terminates a session: closes the agent's stdin (EOF), gracefully stops each
   * sandbox container (Docker sends SIGTERM, then SIGKILL after the configured
   * timeout), removes the containers, and deletes the session rows. After this
   * the session no longer appears in {@link listSessionSummaries}. Returns false
   * if the session does not exist.
   */
  async terminateSession(sessionID: string): Promise<boolean> {
    const graph = await this.store.getSession(sessionID);
    if (!graph) return false;

    // Nudge stdin-blocked agents (e.g. `cat`) to exit cleanly on EOF first.
    for (const rec of this.agents.values()) {
      if (rec.sessionID === sessionID) {
        try {
          rec.handle.endInput();
        } catch {
          // ignore
        }
      }
    }
    // Graceful container stop (SIGTERM → SIGKILL after timeout), then remove.
    for (const sandbox of graph.sandboxes) {
      await this.provisioner
        .stop(sandbox.containerID, { timeoutSeconds: this.terminateTimeoutSeconds })
        .catch(() => undefined);
      await this.provisioner.destroy(sandbox.containerID).catch(() => undefined);
    }
    for (const [agentID, rec] of this.agents) {
      if (rec.sessionID === sessionID) this.agents.delete(agentID);
    }
    this.sessions.delete(sessionID);
    return this.store.destroySession(sessionID);
  }

  /** Destroys a session: force-removes its sandboxes and removes its rows. */
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

  /** Builds a console summary, preferring live attention over the DB snapshot. */
  private toSummary(session: Session, agent: AgentProcess | undefined): SessionSummary {
    const live = this.liveRecord(session.sessionID);
    let attentionState: AttentionState;
    if (live?.exited) {
      attentionState = deriveAttentionState(live.exited.status, live.exited.exitCode);
    } else if (live) {
      attentionState = 'running';
    } else {
      attentionState = deriveAttentionState(agent?.status, agent?.processExitCode ?? null);
    }
    const agentId = agent
      ? agent.agentID.slice(session.sessionID.length + 1)
      : live
        ? live.handle.id
        : null;
    return {
      sessionId: session.sessionID,
      agentId,
      status: session.status,
      attentionState,
      createdAt: session.createdAt.toISOString(),
      repoPath: session.repoPath,
    };
  }

  private liveRecord(sessionID: string): AgentRecord | undefined {
    for (const rec of this.agents.values()) {
      if (rec.sessionID === sessionID) return rec;
    }
    return undefined;
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
      // DB-persistence path (batched, flushed every flushIntervalMs).
      if (entry.stream === 'stdout') rec.pendingStdout += `${entry.text}\n`;
      else rec.pendingStderr += `${entry.text}\n`;
      // Real-time fan-out path (additive; emitted synchronously as lines arrive).
      const event: AgentLogEvent = {
        sessionId: sessionID,
        agentId: handle.id,
        stream: entry.stream,
        text: entry.text,
        timestamp: entry.timestamp,
      };
      this.emit('agentLog', event);
    });
    handle.on('exit', (exit: { status: 'exited' | 'error'; exitCode: number | null }) => {
      rec.exited = exit;
      const event: AgentExitEvent = { sessionId: sessionID, agentId: handle.id, status: exit.status, exitCode: exit.exitCode };
      this.emit('agentExit', event);
    });
    // Prevent an unhandled 'error' on the handle from crashing the process;
    // terminal state is captured via the 'exit' handler above.
    handle.on('error', () => undefined);
  }
}
