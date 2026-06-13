import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';

import { AgentLogBuffer } from './log-buffer.js';
import { SpawnError, type AgentStatus, type LogEntry, type StreamKind } from './types.js';

/** Resolution value of {@link AgentHandle.wait}. */
export interface AgentExit {
  status: AgentStatus;
  exitCode: number | null;
}

interface AgentHandleOptions {
  id: string;
  sessionID: string;
  containerID: string;
  /** The hijacked duplex stream: writes go to the agent's stdin. */
  stdin: Duplex;
  capacity?: number;
}

/**
 * A handle to one spawned agent process. Output is captured into a per-agent
 * {@link AgentLogBuffer}; {@link read} streams it back in order, and {@link write}
 * injects stdin for interactive agents.
 *
 * Emits: `log` (per {@link LogEntry}), `exit` ({@link AgentExit}), `error` (Error).
 *
 * The `_`-prefixed methods are internal wiring used by the orchestrator and are
 * not part of the consumer API.
 */
export class AgentHandle extends EventEmitter {
  readonly id: string;
  readonly sessionID: string;
  readonly containerID: string;

  private _status: AgentStatus = 'running';
  private _exitCode: number | null = null;
  private sequence = 0;
  private cursor = 0;
  private readonly buffer: AgentLogBuffer;
  private readonly stdin: Duplex;
  private exitWaiters: Array<(exit: AgentExit) => void> = [];

  constructor(opts: AgentHandleOptions) {
    super();
    this.id = opts.id;
    this.sessionID = opts.sessionID;
    this.containerID = opts.containerID;
    this.stdin = opts.stdin;
    this.buffer = new AgentLogBuffer(opts.capacity);
  }

  /** Current lifecycle state: `running`, `exited`, or `error`. */
  get status(): AgentStatus {
    return this._status;
  }

  /** Process exit code once exited; `null` while running or on stream error. */
  get exitCode(): number | null {
    return this._exitCode;
  }

  /**
   * Returns the next log entry for this agent in arrival order, awaiting one if
   * none is buffered yet, and `null` once the process has exited and all output
   * has been consumed.
   */
  async read(): Promise<LogEntry | null> {
    const { entry, next } = await this.buffer.readFrom(this.cursor);
    this.cursor = next;
    return entry;
  }

  /** A snapshot of all currently retained log entries (does not advance read). */
  snapshot(): LogEntry[] {
    return this.buffer.snapshot();
  }

  /** Writes `input` to the agent's stdin. Rejects if the agent is not running. */
  async write(input: string | Buffer): Promise<void> {
    if (this._status !== 'running') {
      throw new SpawnError(`Cannot write to agent ${this.id}: status is ${this._status}`);
    }
    await new Promise<void>((resolve, reject) => {
      this.stdin.write(input, (err) => {
        if (err) reject(new SpawnError(`Write to agent ${this.id} failed`, err));
        else resolve();
      });
    });
  }

  /** Signals end-of-input by closing stdin (e.g. so a filter like `cat` exits). */
  endInput(): void {
    this.stdin.end();
  }

  /** Resolves when the agent leaves the `running` state. */
  wait(): Promise<AgentExit> {
    if (this._status !== 'running') {
      return Promise.resolve({ status: this._status, exitCode: this._exitCode });
    }
    return new Promise((resolve) => this.exitWaiters.push(resolve));
  }

  /** @internal Ingest one captured line from a stream. */
  _ingest(stream: StreamKind, text: string): void {
    const entry: LogEntry = {
      agentId: this.id,
      stream,
      timestamp: new Date().toISOString(),
      sequence: this.sequence++,
      text,
    };
    this.buffer.push(entry);
    this.emit('log', entry);
  }

  /** @internal Transition to a terminal state and wake readers/waiters. */
  _finalize(status: AgentStatus, exitCode: number | null): void {
    if (this._status !== 'running') return;
    this._status = status;
    this._exitCode = exitCode;
    this.buffer.finish();
    const exit: AgentExit = { status, exitCode };
    this.emit('exit', exit);
    const pending = this.exitWaiters;
    this.exitWaiters = [];
    for (const resolve of pending) resolve(exit);
  }
}
