import { test, expect } from 'vitest';

import { TerminalRegistry } from '../src/registry';

function fakeSink() {
  const written: string[] = [];
  return { written, write: (d: string) => written.push(d), clear: () => (written.length = 0) };
}

test('routes stdout/stderr/exit to the matching terminal only (multiplexed)', () => {
  const reg = new TerminalRegistry();
  const a = fakeSink();
  const b = fakeSink();
  reg.register('s1', 'agent-01', a);
  reg.register('s1', 'agent-02', b);

  reg.route({ type: 'stdout', sessionId: 's1', agentId: 'agent-01', payload: 'hello' });
  reg.route({ type: 'stderr', sessionId: 's1', agentId: 'agent-02', payload: 'oops' });
  reg.route({ type: 'exit', sessionId: 's1', agentId: 'agent-01', payload: { status: 'exited', exitCode: 0 } });

  const aOut = a.written.join('');
  const bOut = b.written.join('');
  expect(aOut).toContain('hello');
  expect(aOut).toContain('exited');
  expect(aOut).not.toContain('oops');
  expect(bOut).toContain('oops');
  expect(bOut).not.toContain('hello');
});

test('drops messages for unknown targets and ignores error frames', () => {
  const reg = new TerminalRegistry();
  const a = fakeSink();
  reg.register('s1', 'agent-01', a);
  reg.route({ type: 'stdout', sessionId: 's1', agentId: 'ghost', payload: 'x' });
  reg.route({ type: 'error', payload: 'bad' });
  expect(a.written).toHaveLength(0);
});

test('hydrate clears the terminal then replays the persisted buffers', () => {
  const reg = new TerminalRegistry();
  const a = fakeSink();
  reg.register('s1', 'agent-01', a);
  a.write('stale-history');
  reg.hydrate('s1', 'agent-01', 'line1\nline2\n', 'warn\n');
  const out = a.written.join('');
  expect(out).not.toContain('stale-history');
  expect(out).toContain('line1\r\nline2');
  expect(out).toContain('warn');
});
