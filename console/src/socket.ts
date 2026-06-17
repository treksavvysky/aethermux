import type { ServerMessage, StdinMessage } from './protocol';

/** The subset of the WebSocket API this client depends on (so it can be faked). */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketStatus = 'connecting' | 'open' | 'closed';

export interface ReconnectingSocketOptions {
  url: string;
  /** Factory for the underlying socket. Defaults to `new WebSocket(url)`. */
  createSocket?: (url: string) => SocketLike;
  /** Back-off delay (ms) for reconnect attempt `n` (0-based). */
  backoffMs?: (attempt: number) => number;
  setTimeoutFn?: (cb: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  onMessage?: (msg: ServerMessage) => void;
  /** Fired on every successful open; `reconnect` is true for opens after the first. */
  onOpen?: (info: { reconnect: boolean }) => void;
  onStatus?: (status: SocketStatus) => void;
}

/** Exponential back-off: 0.5s, 1s, 2s, 4s, 8s, capped at 10s. */
export function defaultBackoff(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}

/**
 * A WebSocket wrapper that reconnects automatically with exponential back-off
 * after an unexpected close, distinguishing the first open from reconnects (so
 * callers can re-hydrate terminal history on reconnect). All side-effecting
 * dependencies (socket factory, timers) are injectable for deterministic tests.
 */
export class ReconnectingSocket {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private opened = false;
  private stopped = false;
  private timer: unknown = null;

  constructor(private readonly opts: ReconnectingSocketOptions) {}

  /** Number of reconnect attempts scheduled since the last successful open. */
  get reconnectAttempts(): number {
    return this.attempt;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  /** Sends a stdin frame. Returns false if the socket is not currently open. */
  send(msg: StdinMessage): boolean {
    if (!this.socket) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  /** Permanently closes the socket and cancels any pending reconnect. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      (this.opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private open(): void {
    this.opts.onStatus?.('connecting');
    const create = this.opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    const sock = create(this.opts.url);
    this.socket = sock;

    sock.onopen = () => {
      const reconnect = this.opened;
      this.opened = true;
      this.attempt = 0;
      this.opts.onStatus?.('open');
      this.opts.onOpen?.({ reconnect });
    };
    sock.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && 'type' in (msg as Record<string, unknown>)) {
        this.opts.onMessage?.(msg as ServerMessage);
      }
    };
    sock.onclose = () => {
      this.socket = null;
      this.opts.onStatus?.('closed');
      if (!this.stopped) this.scheduleReconnect();
    };
    sock.onerror = () => {
      /* a close event follows; reconnect is handled there */
    };
  }

  private scheduleReconnect(): void {
    const delay = (this.opts.backoffMs ?? defaultBackoff)(this.attempt);
    this.attempt += 1;
    const setT = this.opts.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = setT(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, delay);
  }
}
