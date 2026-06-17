import { test, expect } from 'vitest';

import { rehydrate } from '../src/hydrate';
import { TerminalRegistry } from '../src/registry';
import type { ApiClient } from '../src/api';
import type { Tab } from '../src/store';

function fakeSink() {
  const written: string[] = [];
  return { written, write: (d: string) => written.push(d), clear: () => (written.length = 0) };
}

test('rehydrate replays each tab buffer from GET /sessions/:id', async () => {
  const reg = new TerminalRegistry();
  const sink = fakeSink();
  reg.register('s1', 'agent-01', sink);
  sink.write('stale');

  const api = {
    getSessionGraph: async (id: string) => ({
      session: { sessionID: id, status: 'active' },
      sandboxes: [],
      agents: [{ agentID: `${id}:agent-01`, sessionID: id, status: 'running', stdoutBuffer: 'OUT\n', stderrBuffer: 'ERR\n' }],
    }),
  } as unknown as ApiClient;

  const tabs: Tab[] = [{ sessionId: 's1', agentId: 'agent-01', label: 's1', status: 'active', attentionState: 'running' }];
  await rehydrate(api, reg, tabs);

  const out = sink.written.join('');
  expect(out).not.toContain('stale'); // cleared first
  expect(out).toContain('OUT');
  expect(out).toContain('ERR');
});

test('rehydrate isolates per-tab failures', async () => {
  const reg = new TerminalRegistry();
  const sink = fakeSink();
  reg.register('s2', 'agent-01', sink);
  const api = {
    getSessionGraph: async (id: string) => {
      if (id === 's1') throw new Error('boom');
      return {
        session: { sessionID: id, status: 'active' },
        sandboxes: [],
        agents: [{ agentID: `${id}:agent-01`, sessionID: id, status: 'running', stdoutBuffer: 'OK', stderrBuffer: '' }],
      };
    },
  } as unknown as ApiClient;
  const tabs: Tab[] = [
    { sessionId: 's1', agentId: 'agent-01', label: 's1', status: 'active', attentionState: 'running' },
    { sessionId: 's2', agentId: 'agent-01', label: 's2', status: 'active', attentionState: 'running' },
  ];
  await rehydrate(api, reg, tabs); // must not throw
  expect(sink.written.join('')).toContain('OK');
});
