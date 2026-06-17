// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';

// Avoid loading real xterm.js (needs a canvas jsdom lacks); the test injects a
// fake factory, so the real one is never used anyway.
vi.mock('../src/terminal', () => ({
  createXtermTerminal: () => {
    throw new Error('real terminal factory must not be used in tests');
  },
}));

import { App } from '../src/ui/App';
import { ConsoleStore } from '../src/store';
import { TerminalRegistry } from '../src/registry';
import type { ApiClient } from '../src/api';
import type { ReconnectingSocket } from '../src/socket';
import type { TerminalFactory, TerminalHandle } from '../src/terminal';
import type { SessionSummary } from '../src/protocol';

afterEach(() => cleanup());

type CapturedTerminal = TerminalHandle & { written: string[]; dataCb?: (d: string) => void };

function makeFactory() {
  const created: CapturedTerminal[] = [];
  const factory: TerminalFactory = () => {
    const written: string[] = [];
    const handle: CapturedTerminal = {
      written,
      write: (d) => written.push(d),
      clear: () => (written.length = 0),
      onData: (cb) => {
        handle.dataCb = cb;
      },
      fit: () => undefined,
      dispose: () => undefined,
    };
    created.push(handle);
    return handle;
  };
  return { factory, created };
}

const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  sessionId: 's1',
  agentId: 'agent-01',
  status: 'active',
  attentionState: 'running',
  createdAt: '2026-06-17T00:00:00.000Z',
  repoPath: '/repos/app',
  ...over,
});

test('renders tabs, routes WS output to the right terminal, sends stdin, creates and closes tabs without reload', async () => {
  const store = new ConsoleStore();
  store.setSessions([summary()]);
  const registry = new TerminalRegistry();
  const send = vi.fn(() => true);
  const socket = { send } as unknown as ReconnectingSocket;
  const api = {
    createSession: vi.fn(async () => summary({ sessionId: 's2' })),
    terminateSession: vi.fn(async () => undefined),
  } as unknown as ApiClient;
  const { factory, created } = makeFactory();

  const { container, getByTestId, queryByTestId, getByText } = render(
    <App store={store} api={api} registry={registry} socket={socket} factory={factory} />,
  );

  // criterion 1 + 2: one tab per session; its terminal is mounted & registered.
  expect(getByTestId('tab-s1/agent-01')).toBeTruthy();
  await waitFor(() => expect(created.length).toBe(1));

  // attention ring updates live from the store (fed by agentState WS frames).
  store.setAttention('s1', 'agent-01', 'awaiting-input');
  await waitFor(() => expect(getByTestId('tab-s1/agent-01').getAttribute('data-attention')).toBe('awaiting-input'));
  expect(getByTestId('tab-s1/agent-01').className).toContain('ring-awaiting-input');

  // criterion 2/6: a multiplexed WS frame routes to the correct xterm instance.
  registry.route({ type: 'stdout', sessionId: 's1', agentId: 'agent-01', payload: 'HELLO-WS' });
  expect(created[0].written.join('')).toContain('HELLO-WS');

  // criterion 3: characters typed in the terminal go out as stdin for that agent.
  created[0].dataCb?.('x');
  expect(send).toHaveBeenCalledWith({ type: 'stdin', sessionId: 's1', agentId: 'agent-01', data: 'x' });

  // criterion 4: create a session via the form; new tab appears without reload.
  fireEvent.click(getByTestId('new-session'));
  expect(getByTestId('create-overlay')).toBeTruthy();
  const cmd = container.querySelector('input[name="command"]') as HTMLInputElement;
  fireEvent.input(cmd, { target: { value: 'sh -c "echo hi"' } });
  fireEvent.submit(container.querySelector('form.create-form') as HTMLFormElement);
  await waitFor(() => expect(getByTestId('tab-s2/agent-01')).toBeTruthy());
  expect(api.createSession).toHaveBeenCalledWith({ command: ['sh', '-c', 'echo hi'], repoPath: null, env: undefined });

  // criterion 5: closing a tab terminates the session and removes the tab, no reload.
  fireEvent.click(getByTestId('close-s1'));
  await waitFor(() => expect(queryByTestId('tab-s1/agent-01')).toBeNull());
  expect(api.terminateSession).toHaveBeenCalledWith('s1');

  // sanity: the empty-state copy is not shown while a tab exists.
  expect(() => getByText('No active sessions — click ＋ New to start one.')).toThrow();
});
