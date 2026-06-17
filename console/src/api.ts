import type { CreateSessionRequest, SessionSummary, SessionGraphView } from './protocol';

/** Connection settings for {@link ApiClient}. */
export interface ApiConfig {
  baseUrl: string;
  token: string;
}

/**
 * Typed client for the orchestrator's session-management HTTP API. The fetch
 * implementation is injectable so it can be unit-tested without a network.
 */
export class ApiClient {
  constructor(
    private readonly cfg: ApiConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}`, ...extra };
  }

  /** GET /sessions → list of session summaries (with attentionState). */
  async listSessions(): Promise<SessionSummary[]> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/sessions`, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`GET /sessions failed: ${res.status}`);
    return (await res.json()) as SessionSummary[];
  }

  /** GET /sessions/:id → full graph (used to re-hydrate terminal buffers). */
  async getSessionGraph(sessionId: string): Promise<SessionGraphView> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`GET /sessions/${sessionId} failed: ${res.status}`);
    return (await res.json()) as SessionGraphView;
  }

  /** POST /sessions → the created session summary. */
  async createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/sessions`, {
      method: 'POST',
      headers: this.authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new Error(body.error ?? `POST /sessions failed: ${res.status}`);
    }
    return (await res.json()) as SessionSummary;
  }

  /** DELETE /sessions/:id → terminates the session. */
  async terminateSession(sessionId: string): Promise<void> {
    const res = await this.fetchFn(`${this.cfg.baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`DELETE /sessions/${sessionId} failed: ${res.status}`);
  }
}
