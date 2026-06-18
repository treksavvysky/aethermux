import { test, expect } from 'vitest';

import { ApiClient } from '../src/api';

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: 'x', json: async () => body } as unknown as Response;
}

test('listSessions sends the bearer token and returns the array', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return jsonResponse([{ sessionId: 's1' }]);
  }) as unknown as typeof fetch;

  const api = new ApiClient({ baseUrl: 'http://o', token: 'tok' }, fetchFn);
  const sessions = await api.listSessions();

  expect(sessions).toEqual([{ sessionId: 's1' }]);
  expect(calls[0].url).toBe('http://o/sessions');
  expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
});

test('createSession POSTs JSON and returns the summary; surfaces typed error bodies', async () => {
  const okFetch = (async () => jsonResponse({ sessionId: 's9', agentId: 'agent-01' })) as unknown as typeof fetch;
  const api = new ApiClient({ baseUrl: 'http://o', token: 't' }, okFetch);
  const created = await api.createSession({ command: ['echo', 'hi'] });
  expect(created.sessionId).toBe('s9');

  const errFetch = (async () => jsonResponse({ error: 'command must be a non-empty array' }, false, 400)) as unknown as typeof fetch;
  const api2 = new ApiClient({ baseUrl: 'http://o', token: 't' }, errFetch);
  await expect(api2.createSession({ command: [] })).rejects.toThrow(/non-empty array/);
});

test('terminateSession issues a DELETE', async () => {
  let method: string | undefined;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    method = init?.method;
    return jsonResponse(null);
  }) as unknown as typeof fetch;
  const api = new ApiClient({ baseUrl: 'http://o', token: 't' }, fetchFn);
  await api.terminateSession('s1');
  expect(method).toBe('DELETE');
});

test('the DEFAULT fetchFn calls the global fetch BARE (not as a method of the client)', async () => {
  // Regression guard for the "Illegal invocation" bug: the default must invoke
  // the global `fetch` without binding it to the ApiClient instance. We stub the
  // global and assert `this` inside it is never the client — which is exactly
  // what avoids the browser throw. A raw `fetchFn = fetch` default would make
  // `this` the instance here and fail.
  const original = globalThis.fetch;
  let receiver: unknown = 'unset';
  globalThis.fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve(jsonResponse([{ sessionId: 's-real' }]));
  } as unknown as typeof fetch;
  try {
    const api = new ApiClient({ baseUrl: 'http://o', token: 't' }); // default fetchFn
    expect(await api.listSessions()).toEqual([{ sessionId: 's-real' }]);
    expect(receiver).not.toBe(api);
  } finally {
    globalThis.fetch = original;
  }
});

test('getSessionGraph fetches the session graph', async () => {
  const fetchFn = (async (url: string) => {
    expect(url).toBe('http://o/sessions/s1');
    return jsonResponse({ session: { sessionID: 's1', status: 'active' }, sandboxes: [], agents: [] });
  }) as unknown as typeof fetch;
  const api = new ApiClient({ baseUrl: 'http://o', token: 't' }, fetchFn);
  const graph = await api.getSessionGraph('s1');
  expect(graph.session.sessionID).toBe('s1');
});
