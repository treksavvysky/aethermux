/**
 * The WebSocket multiplexing protocol shared between the orchestrator and the
 * (future) browser console. Every frame carries `sessionId` + `agentId` so a
 * single connection can be demultiplexed across any number of agents.
 *
 * This file is the source of truth for the wire format — the frontend child
 * imports these types so client and server cannot drift.
 */

/** The path the WebSocket server is mounted on, on the shared HTTP server. */
export const WS_PATH = '/ws';

/** A line of agent stdout pushed to clients. */
export interface StdoutMessage {
  type: 'stdout';
  sessionId: string;
  agentId: string;
  payload: string;
}

/** A line of agent stderr pushed to clients. */
export interface StderrMessage {
  type: 'stderr';
  sessionId: string;
  agentId: string;
  payload: string;
}

/** An agent process terminating. */
export interface ExitMessage {
  type: 'exit';
  sessionId: string;
  agentId: string;
  payload: { status: string; exitCode: number | null };
}

/** A server-side error relating to a prior client message. */
export interface ErrorMessage {
  type: 'error';
  sessionId?: string;
  agentId?: string;
  payload: string;
}

/** Anything the server pushes to a client. Discriminated on `type`. */
export type ServerMessage = StdoutMessage | StderrMessage | ExitMessage | ErrorMessage;

/** Stdin a client injects, routed to the named agent's process. */
export interface StdinMessage {
  type: 'stdin';
  sessionId: string;
  agentId: string;
  data: string;
}

/** Anything a client sends to the server. */
export type ClientMessage = StdinMessage;

/** Parses and validates a raw client frame, returning null if it is malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (
    o.type === 'stdin' &&
    typeof o.sessionId === 'string' &&
    typeof o.agentId === 'string' &&
    typeof o.data === 'string'
  ) {
    return { type: 'stdin', sessionId: o.sessionId, agentId: o.agentId, data: o.data };
  }
  return null;
}
