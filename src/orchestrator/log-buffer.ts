import type { LogEntry } from './types.js';

/**
 * A bounded, per-agent buffer of log entries with blocking reads.
 *
 * Entries are appended in arrival order (stdout and stderr interleaved, each
 * tagged) and retained up to `capacity`; once full, the oldest entry is dropped
 * (a ring buffer). Reads use an absolute cursor so a slow reader that falls
 * behind the retained window simply fast-forwards to the oldest entry still
 * held, rather than blocking forever or returning stale data.
 *
 * Each agent owns its own buffer, which is what keeps concurrent agents in one
 * sandbox from corrupting each other's output.
 */
export class AgentLogBuffer {
  private readonly entries: LogEntry[] = [];
  /** Absolute index of `entries[0]`; equals the number of dropped entries. */
  private baseIndex = 0;
  private finished = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly capacity = 10_000) {}

  /** Number of entries currently retained. */
  get length(): number {
    return this.entries.length;
  }

  /** Number of entries dropped from the front due to the capacity bound. */
  get dropped(): number {
    return this.baseIndex;
  }

  /** True once {@link finish} has been called; no further entries will arrive. */
  get isFinished(): boolean {
    return this.finished;
  }

  /** Appends an entry and wakes any blocked readers. No-op once finished. */
  push(entry: LogEntry): void {
    if (this.finished) return;
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.shift();
      this.baseIndex += 1;
    }
    this.notify();
  }

  /** Marks the stream complete; pending and future reads resolve to `null`. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.notify();
  }

  /** A shallow copy of the currently retained entries (for inspection/tests). */
  snapshot(): LogEntry[] {
    return [...this.entries];
  }

  /**
   * Reads the entry at absolute `cursor`, blocking until one is available or the
   * buffer is finished. Returns the entry (or `null` at end) and the next cursor
   * to use. If `cursor` precedes the retained window it is advanced to the
   * oldest retained entry.
   */
  async readFrom(cursor: number): Promise<{ entry: LogEntry | null; next: number }> {
    let c = Math.max(cursor, this.baseIndex);
    for (;;) {
      if (c < this.baseIndex + this.entries.length) {
        return { entry: this.entries[c - this.baseIndex], next: c + 1 };
      }
      if (this.finished) {
        return { entry: null, next: c };
      }
      await this.wait();
      c = Math.max(c, this.baseIndex);
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private notify(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const resolve of pending) resolve();
  }
}
