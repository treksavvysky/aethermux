import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../dist/index.js';

/**
 * Exercises the HTTP layer over a fake engine — no Docker/Postgres needed — so
 * the request validation and 404/error branches are always covered.
 */
function makeFakeEngine(overrides = {}) {
  return {
    created: [],
    createSession: async function (req) { this.created.push(req); return { sessionID: 's-fake' }; },
    getSession: async (id) => (id === 'known' ? { session: { sessionID: 'known' }, sandboxes: [], agents: [] } : null),
    listActiveSessions: async () => [{ sessionID: 's-1' }],
    destroySession: async (id) => id === 'known',
    ...overrides,
  };
}

let server;
let base;
let engine;

before(async () => {
  engine = makeFakeEngine();
  server = createApp(engine).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

const post = (body) =>
  fetch(`${base}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /healthz and /openapi.json', async () => {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(spec.openapi, '3.0.3');
  assert.ok(spec.paths['/sessions']);
});

test('POST /sessions validates the body', async () => {
  assert.equal((await post({})).status, 400); // missing command
  assert.equal((await post({ command: [] })).status, 400); // empty command
  assert.equal((await post({ command: ['x'], repoPath: 5 })).status, 400); // bad repoPath
  assert.equal((await post({ command: ['x'], env: 'nope' })).status, 400); // bad env
});

test('POST /sessions creates and returns a session id', async () => {
  const res = await post({ command: ['echo', 'hi'], repoPath: null, env: { A: '1' } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { sessionID: 's-fake' });
  assert.deepEqual(engine.created.at(-1).command, ['echo', 'hi']);
});

test('GET /sessions lists, GET/DELETE /sessions/:id handle found and missing', async () => {
  assert.deepEqual(await (await fetch(`${base}/sessions`)).json(), { sessions: [{ sessionID: 's-1' }] });

  assert.equal((await fetch(`${base}/sessions/known`)).status, 200);
  assert.equal((await fetch(`${base}/sessions/missing`)).status, 404);

  assert.equal((await fetch(`${base}/sessions/known`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/sessions/missing`, { method: 'DELETE' })).status, 404);
});
