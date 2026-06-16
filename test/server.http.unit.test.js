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

const TOKEN = 'http-token'; // fail-closed auth: the API requires a shared token

let server;
let base;
let engine;

// Appends the shared token so requests pass the fail-closed auth middleware.
const authed = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`;

before(async () => {
  engine = makeFakeEngine();
  server = createApp(engine, { token: TOKEN }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); });

const post = (body) =>
  fetch(authed('/sessions'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('GET /healthz (open) and /openapi.json (authed)', async () => {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
  const spec = await (await fetch(authed('/openapi.json'))).json();
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
  assert.deepEqual(await (await fetch(authed('/sessions'))).json(), { sessions: [{ sessionID: 's-1' }] });

  assert.equal((await fetch(authed('/sessions/known'))).status, 200);
  assert.equal((await fetch(authed('/sessions/missing'))).status, 404);

  assert.equal((await fetch(authed('/sessions/known'), { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(authed('/sessions/missing'), { method: 'DELETE' })).status, 404);
});

test('HTTP API auth is fail-closed (healthz stays open)', async () => {
  // With a token configured: no/wrong token → 401; valid token (header or query) → 200.
  const secured = createApp(makeFakeEngine(), { token: 'secret' }).listen(0);
  await new Promise((r) => secured.once('listening', r));
  const b = `http://127.0.0.1:${secured.address().port}`;
  // With NO token configured: still fail-closed — every protected route is 401.
  const unconfigured = createApp(makeFakeEngine(), {}).listen(0);
  await new Promise((r) => unconfigured.once('listening', r));
  const u = `http://127.0.0.1:${unconfigured.address().port}`;
  try {
    assert.equal((await fetch(`${b}/healthz`)).status, 200); // probe always open
    assert.equal((await fetch(`${b}/sessions`)).status, 401); // no token → rejected
    assert.equal((await fetch(`${b}/sessions`, { headers: { authorization: 'Bearer secret' } })).status, 200);
    assert.equal((await fetch(`${b}/sessions?token=secret`)).status, 200); // query-param carrier
    assert.equal((await fetch(`${b}/sessions`, { headers: { authorization: 'Bearer nope' } })).status, 401);

    assert.equal((await fetch(`${u}/healthz`)).status, 200); // probe open
    assert.equal((await fetch(`${u}/sessions`)).status, 401); // fail-closed: no token configured
    assert.equal((await fetch(`${u}/sessions?token=secret`)).status, 401);
  } finally {
    secured.close();
    unconfigured.close();
  }
});
