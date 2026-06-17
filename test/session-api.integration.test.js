import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import pg from 'pg';
import { SandboxProvisioner, Orchestrator, SessionStore, OrchestratorEngine, createApp } from '../dist/index.js';

/**
 * End-to-end coverage of the session-management HTTP API the console consumes
 * (AETHERMUX-13): create → list → terminate lifecycle, invalid payload (400),
 * and terminate-non-existent (404), against real Docker + Postgres.
 */
const dbUrl = process.env.AETHERMUX_TEST_DATABASE_URL;

async function dockerReachable() {
  try { await new Docker().ping(); return true; } catch { return false; }
}
async function dbReachable(connectionString) {
  if (!connectionString) return false;
  const pool = new pg.Pool({ connectionString, max: 1 });
  try { await pool.query('SELECT 1'); return true; } catch { return false; } finally { await pool.end().catch(() => {}); }
}

const ready = (await dockerReachable()) && (await dbReachable(dbUrl));
const skip = ready ? false : 'requires Docker + AETHERMUX_TEST_DATABASE_URL';
const TOKEN = 'session-api-token';

async function makeStack() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-sapi-it-'));
  const store = await SessionStore.connect({ connectionString: dbUrl });
  const provisioner = new SandboxProvisioner({ workspaceRoot });
  const engine = new OrchestratorEngine({ store, provisioner, spawner: new Orchestrator() }, { flushIntervalMs: 200, terminateTimeoutSeconds: 5 });
  engine.start();
  const server = createServer(createApp(engine, { token: TOKEN }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { workspaceRoot, store, provisioner, engine, server, base };
}

const authedFetch = (base, p, init) =>
  fetch(`${base}${p}`, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${TOKEN}` } });

test('create → list → terminate lifecycle; 400 on invalid; 404 on missing', { skip }, async (t) => {
  const s = await makeStack();
  let containerID;
  t.after(async () => {
    if (containerID) await s.provisioner.destroy(containerID).catch(() => {});
    s.server.close();
    await s.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  // --- create ---
  const createRes = await authedFetch(s.base, '/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repoPath: null, command: ['sh', '-c', 'echo HELLO; sleep 60'] }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.match(created.sessionId, /^s-/);
  assert.match(created.agentId, /^agent-\d+$/);
  assert.equal(created.status, 'active');
  assert.equal(created.attentionState, 'running');
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  const sessionId = created.sessionId;
  containerID = (await s.store.getSession(sessionId)).sandboxes[0].containerID;

  // --- list (bare array, includes our session with a typed attentionState) ---
  const list = await (await authedFetch(s.base, '/sessions')).json();
  assert.ok(Array.isArray(list));
  const mine = list.find((x) => x.sessionId === sessionId);
  assert.ok(mine, 'created session appears in GET /sessions');
  assert.ok(['running', 'awaiting-input', 'exited', 'error'].includes(mine.attentionState));
  assert.equal(mine.attentionState, 'running');

  // --- terminate (graceful; SIGTERM → SIGKILL after timeout) ---
  assert.equal(await s.provisioner.isRunning(containerID), true);
  const delRes = await authedFetch(s.base, `/sessions/${sessionId}`, { method: 'DELETE' });
  assert.equal(delRes.status, 200);
  assert.deepEqual(await delRes.json(), { terminated: true, sessionId });

  // The agent's sandbox is gone and the session is no longer listed.
  assert.equal(await s.provisioner.isRunning(containerID), false);
  const afterList = await (await authedFetch(s.base, '/sessions')).json();
  assert.ok(!afterList.some((x) => x.sessionId === sessionId), 'terminated session no longer listed');
  containerID = undefined; // already removed

  // --- 400: invalid payload ---
  const bad = await authedFetch(s.base, '/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: [] }),
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /command/);

  // --- 404: terminate a non-existent session ---
  const missing = await authedFetch(s.base, '/sessions/s-does-not-exist', { method: 'DELETE' });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'session not found' });
});

test('attentionState reflects a real agent exit (exited / error), never faked', { skip }, async (t) => {
  const s = await makeStack();
  const containers = [];
  t.after(async () => {
    // Destroy containers via the provisioner (Docker-only) BEFORE closing the
    // store, so cleanup never depends on a closed pool.
    for (const c of containers) await s.provisioner.destroy(c).catch(() => {});
    s.server.close();
    await s.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  // An agent that exits non-zero must surface attentionState 'error' (not green).
  const { sessionID } = await s.engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo bye; exit 7'] });
  containers.push((await s.store.getSession(sessionID)).sandboxes[0].containerID);

  const deadline = Date.now() + 6000;
  let summary;
  while (Date.now() < deadline) {
    summary = await s.engine.getSessionSummary(sessionID);
    if (summary.attentionState !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(summary.attentionState, 'error', 'non-zero exit → error, never a false green');

  // A clean exit (code 0) surfaces 'exited'.
  const ok = await s.engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo done; exit 0'] });
  containers.push((await s.store.getSession(ok.sessionID)).sandboxes[0].containerID);
  const d2 = Date.now() + 6000;
  let s2;
  while (Date.now() < d2) {
    s2 = await s.engine.getSessionSummary(ok.sessionID);
    if (s2.attentionState !== 'running') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(s2.attentionState, 'exited', 'clean exit → exited (green)');
});
