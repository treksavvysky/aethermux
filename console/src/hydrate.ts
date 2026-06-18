import type { ApiClient } from './api';
import type { TerminalRegistry } from './registry';
import type { Tab } from './store';

/**
 * Re-hydrates one tab's terminal from the persisted DB buffers via
 * `GET /sessions/:id`. Used both when a terminal first mounts (so a session
 * already parked at a prompt shows its history, not a blank pane) and after a
 * WebSocket reconnect (so the gap is filled). A no-op if the fetch fails or the
 * terminal isn't registered yet.
 */
export async function hydrateTab(api: ApiClient, registry: TerminalRegistry, tab: Tab): Promise<void> {
  let graph;
  try {
    graph = await api.getSessionGraph(tab.sessionId);
  } catch {
    return; // network error (or no graph endpoint) — leave the terminal as-is
  }
  if (!graph) return;
  const agent =
    graph.agents.find((a) => a.agentID === `${tab.sessionId}:${tab.agentId}` || a.agentID.endsWith(`:${tab.agentId}`)) ??
    graph.agents[0];
  if (agent) registry.hydrate(tab.sessionId, tab.agentId, agent.stdoutBuffer, agent.stderrBuffer);
}

/**
 * Re-hydrates every tab's terminal. Used after a WebSocket reconnect so history
 * isn't lost. A per-tab failure is isolated (the rest still hydrate).
 */
export async function rehydrate(api: ApiClient, registry: TerminalRegistry, tabs: readonly Tab[]): Promise<void> {
  for (const tab of tabs) await hydrateTab(api, registry, tab);
}
