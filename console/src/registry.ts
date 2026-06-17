import type { ServerMessage } from './protocol';

/** A write target for one agent's terminal (an xterm.js instance, or a fake). */
export interface TerminalSink {
  write(data: string): void;
  clear(): void;
}

/** Stable key multiplexing a single WebSocket across many agents. */
export function termKey(sessionId: string, agentId: string): string {
  return `${sessionId}/${agentId}`;
}

/**
 * Routes multiplexed WebSocket frames to the correct terminal instance, keyed by
 * session + agent. There is **no per-agent special-casing** — every agent's
 * output flows through this one path; stderr is simply rendered red and exit is
 * a dim marker line (per-stream, not per-agent).
 */
export class TerminalRegistry {
  private readonly sinks = new Map<string, TerminalSink>();

  register(sessionId: string, agentId: string, sink: TerminalSink): void {
    this.sinks.set(termKey(sessionId, agentId), sink);
  }

  unregister(sessionId: string, agentId: string): void {
    this.sinks.delete(termKey(sessionId, agentId));
  }

  has(sessionId: string, agentId: string): boolean {
    return this.sinks.has(termKey(sessionId, agentId));
  }

  /** Writes a server frame to its terminal. Unknown targets are dropped. */
  route(msg: ServerMessage): void {
    if (msg.type === 'error') return;
    const sink = this.sinks.get(termKey(msg.sessionId, msg.agentId));
    if (!sink) return;
    if (msg.type === 'stdout') {
      sink.write(`${msg.payload}\r\n`);
    } else if (msg.type === 'stderr') {
      sink.write(`\x1b[31m${msg.payload}\x1b[0m\r\n`);
    } else {
      const code = msg.payload.exitCode !== null ? ` code ${msg.payload.exitCode}` : '';
      sink.write(`\r\n\x1b[2m[${msg.payload.status}${code}]\x1b[0m\r\n`);
    }
  }

  /** Re-hydrates a terminal from persisted buffers: clear, then replay. */
  hydrate(sessionId: string, agentId: string, stdoutBuffer: string, stderrBuffer: string): void {
    const sink = this.sinks.get(termKey(sessionId, agentId));
    if (!sink) return;
    sink.clear();
    if (stdoutBuffer) sink.write(toCrlf(stdoutBuffer));
    if (stderrBuffer) sink.write(`\x1b[31m${toCrlf(stderrBuffer)}\x1b[0m`);
  }
}

function toCrlf(s: string): string {
  return s.replace(/\r?\n/g, '\r\n');
}
