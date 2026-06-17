/**
 * The HTTP session-management API contract, shared between the orchestrator and
 * the browser console (the frontend imports these types so the wire shapes
 * cannot drift). Field names are camelCase — the console's convention and the
 * same convention as the WebSocket protocol.
 *
 * Endpoints:
 *   POST   /sessions          → CreateSessionResponse (201)
 *   GET    /sessions          → SessionSummary[]      (200)
 *   GET    /sessions/:id      → SessionGraph          (200) | ErrorResponse (404)
 *   DELETE /sessions/:id      → TerminateResponse     (200) | ErrorResponse (404)
 * All error responses use {@link ErrorResponse} ({ error: string }).
 */

/**
 * Attention-ring state for a session, derived from **real** agent lifecycle
 * (never heuristics — the "no false greens" invariant extends to no false
 * signals of any colour):
 * - `running` — the agent is executing.
 * - `awaiting-input` — the agent is blocked waiting for stdin. Reserved for the
 *   real attention detector (AETHERMUX-15); it is never inferred here, so this
 *   layer never emits a false `awaiting-input`.
 * - `exited` — the agent finished successfully (exit code 0).
 * - `error` — the agent errored or exited non-zero.
 */
export type AttentionState = 'running' | 'awaiting-input' | 'exited' | 'error';

/** Request body for `POST /sessions`. */
export interface CreateSessionRequest {
  repoPath?: string | null;
  command: string[];
  env?: Record<string, string>;
}

/**
 * A session as the console consumes it — the `POST /sessions` response and each
 * element of the `GET /sessions` array.
 */
export interface SessionSummary {
  sessionId: string;
  /** The session's primary agent id (e.g. `agent-01`), or null if none yet. */
  agentId: string | null;
  /** Session lifecycle status (`active` | `paused` | `orphaned` | …). */
  status: string;
  /** Ring state derived from real agent lifecycle. */
  attentionState: AttentionState;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  repoPath: string | null;
}

/** `POST /sessions` success response. */
export type CreateSessionResponse = SessionSummary;

/** `DELETE /sessions/:id` success response. */
export interface TerminateResponse {
  terminated: true;
  sessionId: string;
}

/** Uniform error body returned by every endpoint on failure. */
export interface ErrorResponse {
  error: string;
}

/**
 * Derives the {@link AttentionState} from an agent's persisted lifecycle. Pure
 * and truthful: `exited` (green) only when the process really exited with code
 * 0; any error or non-zero exit is `error`. Never returns `awaiting-input`
 * (that requires the real attention detector wired in AETHERMUX-15).
 */
export function deriveAttentionState(status: string | undefined, exitCode: number | null): AttentionState {
  if (status === 'error') return 'error';
  if (status === 'exited') return exitCode === 0 ? 'exited' : 'error';
  return 'running';
}
