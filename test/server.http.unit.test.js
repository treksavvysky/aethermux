import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../dist/index.js';

/**
 * Exercises the HTTP layer over a fake engine — no Docker/Postgres needed — so
 * the request validation and 404/error branches are always covered.
 */
const SUMMARY = {
  sessionId: 's-fake',
  agentId: 'agent-01',
  status: 'active',
  attentionState: 'running',
  createdAt: '2026-06-17T00:00:00.000Z',
  repoPath: null,
};

function makeFakeEngine(overrides = {}) {
  return {
    created: [],
    terminated: [],
    createSession: async function (req) { this.created.push(req); return { sessionID: 's-fake' }; },
    getSessionSummary: async (id) => (id === 's-fake' ? SUMMARY : null),
    listSessionSummaries: async () => [SUMMARY],
    getSession: async (id) => (id === 'known' ? { session: { sessionID: 'known' }, sandboxes: [], agents: [] } : null),
    terminateSession: async function (id) { this.terminated.push(id); return id === 'known'; },
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

test('POST /sessions returns a SessionSummary { sessionId, agentId, status, createdAt, ... }', async () => {
  const res = await post({ command: ['echo', 'hi'], repoPath: null, env: { A: '1' } });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.sessionId, 's-fake');
  assert.equal(body.agentId, 'agent-01');
  assert.equal(body.status, 'active');
  assert.equal(body.attentionState, 'running');
  assert.match(body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(engine.created.at(-1).command, ['echo', 'hi']);
});

test('GET /sessions returns a bare array of summaries with attentionState', async () => {
  const body = await (await fetch(authed('/sessions'))).json();
  assert.ok(Array.isArray(body), 'GET /sessions is a bare array');
  assert.equal(body[0].sessionId, 's-fake');
  assert.ok(['running', 'awaiting-input', 'exited', 'error'].includes(body[0].attentionState));
});

test('DELETE /sessions/:id terminates (200) or 404; uses graceful terminateSession', async () => {
  const ok = await fetch(authed('/sessions/known'), { method: 'DELETE' });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { terminated: true, sessionId: 'known' });
  assert.ok(engine.terminated.includes('known'));

  const missing = await fetch(authed('/sessions/missing'), { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'session not found' });

  // GET /sessions/:id still 200/404 (graph endpoint retained).
  assert.equal((await fetch(authed('/sessions/known'))).status, 200);
  assert.equal((await fetch(authed('/sessions/missing'))).status, 404);
});

test('consoleDir: the SPA is served publicly at / while API stays fail-closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-console-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>AetherMux Console</title><div id="app"></div>');
  await fs.writeFile(path.join(dir, 'app.js'), 'console.log("hi")');
  const server = createApp(makeFakeEngine(), { token: 'secret', consoleDir: dir }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const b = `http://127.0.0.1:${server.address().port}`;
  try {
    // SPA index + assets load with no token (public).
    const index = await fetch(`${b}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /AetherMux Console/);
    assert.equal((await fetch(`${b}/app.js`)).status, 200);
    // API routes still require the token (fail-closed) — static serving doesn't shadow them.
    assert.equal((await fetch(`${b}/sessions`)).status, 401);
    assert.equal((await fetch(`${b}/sessions?token=secret`)).status, 200);
    assert.equal((await fetch(`${b}/healthz`)).status, 200);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('CORS: preflight is answered without auth; responses carry CORS headers', async () => {
  // A preflight OPTIONS carries no token and must still be answered (204).
  const pre = await fetch(`${base}/sessions`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
  assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
  // Normal responses also carry the allow-origin header.
  assert.equal((await fetch(`${base}/healthz`)).headers.get('access-control-allow-origin'), '*');
});

test('uncaught handler errors return a typed { error } 500, not HTML', async () => {
  const boom = createApp(
    makeFakeEngine({ listSessionSummaries: async () => { throw new Error('kaboom'); } }),
    { token: TOKEN },
  ).listen(0);
  await new Promise((r) => boom.once('listening', r));
  const b = `http://127.0.0.1:${boom.address().port}`;
  try {
    const res = await fetch(`${b}/sessions?token=${TOKEN}`);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true);
    assert.deepEqual(await res.json(), { error: 'kaboom' });
  } finally {
    boom.close();
  }
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
