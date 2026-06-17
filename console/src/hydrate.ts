import type { ApiClient } from './api';
import type { TerminalRegistry } from './registry';
import type { Tab } from './store';

/**
 * Re-hydrates each tab's terminal from the persisted DB buffers via
 * `GET /sessions/:id`, used after a WebSocket reconnect so history isn't lost.
 * A per-tab failure is isolated (the rest still hydrate).
 */
export async function rehydrate(api: ApiClient, registry: TerminalRegistry, tabs: readonly Tab[]): Promise<void> {
  for (const tab of tabs) {
    const graph = await api.getSessionGraph(tab.sessionId).catch(() => null);
    if (!graph) continue;
    const agent =
      graph.agents.find((a) => a.agentID === `${tab.sessionId}:${tab.agentId}` || a.agentID.endsWith(`:${tab.agentId}`)) ??
      graph.agents[0];
    if (agent) registry.hydrate(tab.sessionId, tab.agentId, agent.stdoutBuffer, agent.stderrBuffer);
  }
}
