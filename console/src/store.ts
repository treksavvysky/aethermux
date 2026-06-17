import type { AttentionState, SessionSummary } from './protocol';

/** One dashboard tab — a session's primary agent. */
export interface Tab {
  sessionId: string;
  agentId: string;
  label: string;
  status: string;
  /** Drives the attention ring colour (blue/green/error/neutral). */
  attentionState: AttentionState;
}

/** Stable identity for a tab (matches the terminal registry key). */
export function tabKey(t: { sessionId: string; agentId: string }): string {
  return `${t.sessionId}/${t.agentId}`;
}

function labelFor(s: SessionSummary): string {
  const repo = s.repoPath ? (s.repoPath.split('/').pop() ?? s.repoPath) : null;
  const head = repo ?? s.sessionId.slice(0, 8);
  return s.agentId ? `${head} · ${s.agentId}` : head;
}

function tabFromSummary(s: SessionSummary): Tab {
  return {
    sessionId: s.sessionId,
    agentId: s.agentId ?? 'agent',
    label: labelFor(s),
    status: s.status,
    attentionState: s.attentionState,
  };
}

/**
 * Observable tab/session state for the dashboard. Framework-agnostic (a plain
 * observable) so it is unit-testable and the view layer is a thin subscriber.
 */
export class ConsoleStore {
  private _tabs: Tab[] = [];
  private _activeKey: string | null = null;
  private readonly listeners = new Set<() => void>();

  get tabs(): readonly Tab[] {
    return this._tabs;
  }

  get activeKey(): string | null {
    return this._activeKey;
  }

  /** Replaces the tab set from a session listing (initial load / refresh). */
  setSessions(sessions: SessionSummary[]): void {
    this._tabs = sessions.map(tabFromSummary);
    if ((this._activeKey === null || !this._tabs.some((t) => tabKey(t) === this._activeKey)) && this._tabs.length) {
      this._activeKey = tabKey(this._tabs[0]);
    }
    this.notify();
  }

  /** Adds (or focuses) a tab for a newly created session and activates it. */
  addSession(session: SessionSummary): void {
    const tab = tabFromSummary(session);
    if (!this._tabs.some((t) => tabKey(t) === tabKey(tab))) {
      this._tabs = [...this._tabs, tab];
    }
    this._activeKey = tabKey(tab);
    this.notify();
  }

  /** Removes every tab for a session; re-points the active tab if needed. */
  removeSession(sessionId: string): void {
    this._tabs = this._tabs.filter((t) => t.sessionId !== sessionId);
    if (this._activeKey !== null && !this._tabs.some((t) => tabKey(t) === this._activeKey)) {
      this._activeKey = this._tabs.length ? tabKey(this._tabs[0]) : null;
    }
    this.notify();
  }

  setActive(key: string): void {
    if (this._tabs.some((t) => tabKey(t) === key)) {
      this._activeKey = key;
      this.notify();
    }
  }

  /** Updates a tab's attention state (driven by `agentState` WS frames). */
  setAttention(sessionId: string, agentId: string, state: AttentionState): void {
    let changed = false;
    this._tabs = this._tabs.map((t) => {
      if (t.sessionId === sessionId && t.agentId === agentId && t.attentionState !== state) {
        changed = true;
        return { ...t, attentionState: state };
      }
      return t;
    });
    if (changed) this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
