import { test, expect } from 'vitest';

import { ConsoleStore } from '../src/store';
import type { SessionSummary } from '../src/protocol';

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: 's1',
  agentId: 'agent-01',
  status: 'active',
  attentionState: 'running',
  createdAt: '2026-06-17T00:00:00.000Z',
  repoPath: '/repos/app',
  ...over,
});

test('tab creation: setSessions populates tabs and defaults the active tab', () => {
  const store = new ConsoleStore();
  let notified = 0;
  store.subscribe(() => (notified += 1));

  store.setSessions([summary(), summary({ sessionId: 's2' })]);
  expect(store.tabs.map((t) => t.sessionId)).toEqual(['s1', 's2']);
  expect(store.activeKey).toBe('s1/agent-01');
  expect(notified).toBeGreaterThan(0);
});

test('tab creation: addSession appends a tab and focuses it (no reload semantics)', () => {
  const store = new ConsoleStore();
  store.setSessions([summary()]);
  store.addSession(summary({ sessionId: 's2' }));
  expect(store.tabs).toHaveLength(2);
  expect(store.activeKey).toBe('s2/agent-01');
  // idempotent: adding the same session again does not duplicate the tab.
  store.addSession(summary({ sessionId: 's2' }));
  expect(store.tabs).toHaveLength(2);
});

test('tab close: removeSession drops the tab and re-points the active tab', () => {
  const store = new ConsoleStore();
  store.setSessions([summary(), summary({ sessionId: 's2' })]);
  store.setActive('s2/agent-01');
  store.removeSession('s2');
  expect(store.tabs.map((t) => t.sessionId)).toEqual(['s1']);
  expect(store.activeKey).toBe('s1/agent-01');
  store.removeSession('s1');
  expect(store.tabs).toHaveLength(0);
  expect(store.activeKey).toBeNull();
});

test('setAttention updates a tab attention state, notifies only on change', () => {
  const store = new ConsoleStore();
  store.setSessions([summary()]); // attentionState defaults to 'running' from the summary
  expect(store.tabs[0].attentionState).toBe('running');
  let notified = 0;
  store.subscribe(() => (notified += 1));

  store.setAttention('s1', 'agent-01', 'awaiting-input');
  expect(store.tabs[0].attentionState).toBe('awaiting-input');
  expect(notified).toBe(1);

  store.setAttention('s1', 'agent-01', 'awaiting-input'); // no-op
  expect(notified).toBe(1);

  store.setAttention('s1', 'agent-01', 'error');
  expect(store.tabs[0].attentionState).toBe('error');
});
