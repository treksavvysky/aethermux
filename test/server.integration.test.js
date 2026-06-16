import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import pg from 'pg';
import { SandboxProvisioner, Orchestrator, SessionStore, OrchestratorEngine, createApp } from '../dist/index.js';

/**
 * End-to-end exercise of the orchestrator main loop against real Docker and
 * PostgreSQL. Requires both AETHERMUX_TEST_DATABASE_URL and a reachable Docker
 * daemon; otherwise skips so the suite stays green elsewhere.
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

async function makeEngine(extra = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-eng-it-'));
  const store = await SessionStore.connect({ connectionString: dbUrl });
  const provisioner = new SandboxProvisioner({ workspaceRoot });
  const spawner = new Orchestrator();
  const engine = new OrchestratorEngine({ store, provisioner, spawner }, { flushIntervalMs: 300, ...extra });
  return { engine, store, provisioner, workspaceRoot };
}

const TOKEN = 'srv-it-token'; // fail-closed auth: the API requires a shared token
const get = async (base, p) => (await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=${TOKEN}`)).json();

test('HTTP: create a session, persist the graph, and flush agent output to the DB', { skip }, async (t) => {
  const { engine, store, provisioner, workspaceRoot } = await makeEngine();
  engine.start();
  const server = createApp(engine, { token: TOKEN }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let sessionID;
  t.after(async () => {
    if (sessionID) await engine.destroySession(sessionID).catch(() => {});
    server.close();
    await store.close().catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  // Liveness.
  assert.deepEqual(await get(base, '/healthz'), { status: 'ok' });

  // CreateSession accepts (repoPath, command, env) and returns a sessionID.
  const createRes = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ repoPath: null, command: ['sh', '-c', 'echo STARTED; sleep 30'], env: { FOO: 'bar' } }),
  });
  assert.equal(createRes.status, 201);
  sessionID = (await createRes.json()).sessionID;
  assert.match(sessionID, /^s-/);

  // Provisioned + spawned + persisted: the graph is queryable.
  const graph = await get(base, `/sessions/${sessionID}`);
  assert.equal(graph.session.status, 'active');
  assert.equal(graph.sandboxes.length, 1);
  assert.equal(graph.sandboxes[0].status, 'running');
  assert.equal(graph.agents.length, 1);
  assert.deepEqual(graph.agents[0].command, ['sh', '-c', 'echo STARTED; sleep 30']);

  // The flush loop writes agent output to the DB within ~1s.
  let buffered = '';
  for (let i = 0; i < 20 && !buffered.includes('STARTED'); i++) {
    await new Promise((r) => setTimeout(r, 200));
    const g = await get(base, `/sessions/${sessionID}`);
    buffered = g.agents[0].stdoutBuffer;
  }
  assert.match(buffered, /STARTED/, 'agent stdout was flushed to the DB');

  // Sandbox is genuinely running.
  assert.equal(await provisioner.isRunning(graph.sandboxes[0].containerID), true);
});

test('recovery: create → graceful shutdown (paused) → restart → reconnect', { skip }, async (t) => {
  const a = await makeEngine();
  a.engine.start();
  const { sessionID } = await a.engine.createSession({ repoPath: null, command: ['sh', '-c', 'sleep 60'] });
  const graphA = await a.store.getSession(sessionID);
  const containerID = graphA.sandboxes[0].containerID;

  // Graceful shutdown pauses the session and closes the store, but leaves the
  // sandbox container running (simulating an orchestrator restart).
  await a.engine.shutdown();
  assert.equal(await a.provisioner.isRunning(containerID), true, 'sandbox survives shutdown');

  // A fresh orchestrator instance recovers from the database alone.
  const b = await makeEngine();
  t.after(async () => {
    await b.engine.destroySession(sessionID).catch(() => {});
    await b.store.close().catch(() => {});
    await fs.rm(a.workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(b.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const result = await b.engine.recover();
  assert.ok(result.reconnected.includes(sessionID), 'paused session with a live sandbox is reconnected');
  const graphB = await b.store.getSession(sessionID);
  assert.equal(graphB.session.status, 'active', 'recovered session is active again');
  assert.equal(graphB.sandboxes[0].status, 'running');
});

test('recovery: a paused session whose sandbox is gone is marked orphaned', { skip }, async (t) => {
  const { engine, store, provisioner, workspaceRoot } = await makeEngine();
  engine.start();
  const { sessionID } = await engine.createSession({ repoPath: null, command: ['sh', '-c', 'sleep 60'] });
  const graph = await store.getSession(sessionID);
  const containerID = graph.sandboxes[0].containerID;

  t.after(async () => {
    await engine.destroySession(sessionID).catch(() => {});
    await store.close().catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  // Pause the session, then remove its sandbox out from under it.
  await store.updateSession(sessionID, { status: 'paused' });
  await provisioner.destroy(containerID);
  assert.equal(await provisioner.isRunning(containerID), false);

  const result = await engine.recover();
  assert.ok(result.orphaned.includes(sessionID), 'session with no live sandbox is orphaned');
  assert.ok(!result.reconnected.includes(sessionID));
  const after = await store.getSession(sessionID);
  assert.equal(after.session.status, 'orphaned');
});
