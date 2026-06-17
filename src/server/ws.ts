import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import { isAuthorized } from './auth.js';
import type { AgentExitEvent, AgentLogEvent, AgentStateEvent, OrchestratorEngine } from './engine.js';
import { WS_PATH, parseClientMessage, type ServerMessage } from './ws-protocol.js';

/** Options for {@link OrchestratorSocket}. */
export interface WebSocketOptions {
  /** Shared API token; when set, the WS upgrade requires it (same as HTTP). */
  token?: string;
  /** Path to mount on; defaults to {@link WS_PATH} (`/ws`). */
  path?: string;
}

/**
 * The orchestrator's real-time transport. Attaches a `ws` server to the
 * existing HTTP server (no new port), authenticates the upgrade with the same
 * token mechanism as the HTTP API, fans every agent's stdout/stderr/exit out to
 * all connected clients (multiplexed by session+agent), and routes inbound
 * `stdin` frames to the right agent process.
 *
 * This is purely additive: the engine still flushes output to Postgres on its
 * own loop. The WebSocket is a parallel fan-out, emitted synchronously as lines
 * arrive (no batching), so clients see output well within the 100 ms target.
 */
export class OrchestratorSocket {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private readonly path: string;
  private readonly onLog: (event: AgentLogEvent) => void;
  private readonly onExit: (event: AgentExitEvent) => void;
  private readonly onState: (event: AgentStateEvent) => void;
  private readonly onUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

  constructor(
    private readonly engine: OrchestratorEngine,
    private readonly server: HttpServer,
    opts: WebSocketOptions = {},
  ) {
    this.path = opts.path ?? WS_PATH;
    this.wss = new WebSocketServer({ noServer: true });

    this.onUpgrade = (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== this.path) return; // not our path — leave it alone
      if (!isAuthorized(req, opts.token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    };
    server.on('upgrade', this.onUpgrade);
    this.wss.on('connection', (ws: WebSocket) => this.handleConnection(ws));

    this.onLog = (event) =>
      this.broadcast({ type: event.stream, sessionId: event.sessionId, agentId: event.agentId, payload: event.text });
    this.onExit = (event) =>
      this.broadcast({
        type: 'exit',
        sessionId: event.sessionId,
        agentId: event.agentId,
        payload: { status: event.status, exitCode: event.exitCode },
      });
    this.onState = (event) =>
      this.broadcast({ type: 'agentState', sessionId: event.sessionId, agentId: event.agentId, state: event.state });
    engine.on('agentLog', this.onLog);
    engine.on('agentExit', this.onExit);
    engine.on('agentState', this.onState);
  }

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('message', (raw: Buffer | string) => {
      void this.handleMessage(ws, raw.toString());
    });
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) {
      this.send(ws, { type: 'error', payload: 'invalid message' });
      return;
    }
    // Only `stdin` is currently accepted from clients.
    try {
      await this.engine.sendStdin(message.sessionId, message.agentId, message.data);
    } catch (err) {
      this.send(ws, {
        type: 'error',
        sessionId: message.sessionId,
        agentId: message.agentId,
        payload: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  /** Detaches engine/server listeners and closes all client connections. */
  async close(): Promise<void> {
    this.engine.off('agentLog', this.onLog);
    this.engine.off('agentExit', this.onExit);
    this.engine.off('agentState', this.onState);
    this.server.off('upgrade', this.onUpgrade);
    for (const ws of this.clients) ws.close();
    this.clients.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
