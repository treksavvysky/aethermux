import { test, expect } from 'vitest';

import { ReconnectingSocket, defaultBackoff } from '../src/socket';
import type { SocketLike } from '../src/socket';

function fakeSocket(): SocketLike & { sent: string[]; closed: boolean } {
  const s = {
    sent: [] as string[],
    closed: false,
    onopen: null as ((ev?: unknown) => void) | null,
    onclose: null as ((ev?: unknown) => void) | null,
    onerror: null as ((ev?: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    send: (d: string) => s.sent.push(d),
    close: () => {
      s.closed = true;
    },
  };
  return s;
}

test('defaultBackoff is exponential and capped at 10s', () => {
  expect(defaultBackoff(0)).toBe(500);
  expect(defaultBackoff(1)).toBe(1000);
  expect(defaultBackoff(2)).toBe(2000);
  expect(defaultBackoff(5)).toBe(10_000); // 500*32 = 16000 → capped
});

test('reconnects with exponential back-off, flags reconnects, and resets on open', () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const timers: { cb: () => void; ms: number }[] = [];
  const opens: boolean[] = [];

  const rs = new ReconnectingSocket({
    url: 'ws://x/ws',
    createSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    setTimeoutFn: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length;
    },
    clearTimeoutFn: () => undefined,
    onOpen: (info) => opens.push(info.reconnect),
  });

  rs.connect();
  expect(sockets).toHaveLength(1);

  sockets[0].onopen?.(); // first open
  expect(opens).toEqual([false]);

  sockets[0].onclose?.(); // unexpected drop → schedule reconnect (attempt 0)
  expect(timers).toHaveLength(1);
  expect(timers[0].ms).toBe(500);

  timers[0].cb(); // fire reconnect → second socket created
  expect(sockets).toHaveLength(2);

  sockets[1].onclose?.(); // drops again before opening → attempt 1
  expect(timers[1].ms).toBe(1000);

  timers[1].cb();
  sockets[2].onopen?.(); // reconnected
  expect(opens).toEqual([false, true]); // second open flagged as reconnect

  sockets[2].onclose?.(); // back-off counter reset by the open → attempt 0 again
  expect(timers[2].ms).toBe(500);
});

test('send serialises a stdin frame when open and reports closed when not', () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const rs = new ReconnectingSocket({
    url: 'ws://x/ws',
    createSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
  });
  expect(rs.send({ type: 'stdin', sessionId: 's1', agentId: 'agent-01', data: 'x' })).toBe(false);
  rs.connect();
  sockets[0].onopen?.();
  expect(rs.send({ type: 'stdin', sessionId: 's1', agentId: 'agent-01', data: 'ls\n' })).toBe(true);
  expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'stdin', sessionId: 's1', agentId: 'agent-01', data: 'ls\n' });
});

test('parses inbound server frames and forwards them to onMessage', () => {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const got: unknown[] = [];
  const rs = new ReconnectingSocket({
    url: 'ws://x/ws',
    createSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    onMessage: (m) => got.push(m),
  });
  rs.connect();
  sockets[0].onopen?.();
  sockets[0].onmessage?.({ data: JSON.stringify({ type: 'stdout', sessionId: 's1', agentId: 'agent-01', payload: 'hi' }) });
  sockets[0].onmessage?.({ data: 'not json' }); // ignored
  expect(got).toEqual([{ type: 'stdout', sessionId: 's1', agentId: 'agent-01', payload: 'hi' }]);
});
