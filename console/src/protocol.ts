/**
 * The wire contract, re-exported from the orchestrator's source so client and
 * server cannot drift (no duplication). Both server modules are dependency-free
 * and browser-safe, so importing them here pulls no Node-only code.
 */
export * from '../../src/server/ws-protocol';
export * from '../../src/server/api-types';

/**
 * Minimal view of `GET /sessions/:id` used only to re-hydrate terminal history
 * from the persisted buffers. Declared locally so the console never imports the
 * pg-typed persistence types.
 */
export interface AgentBufferView {
  agentID: string;
  sessionID: string;
  status: string;
  stdoutBuffer: string;
  stderrBuffer: string;
}

export interface SessionGraphView {
  session: { sessionID: string; status: string };
  sandboxes: unknown[];
  agents: AgentBufferView[];
}
