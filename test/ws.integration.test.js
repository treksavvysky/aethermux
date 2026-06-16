import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import pg from 'pg';
import { WebSocket } from 'ws';
import {
  SandboxProvisioner,
  Orchestrator,
  SessionStore,
  OrchestratorEngine,
  OrchestratorSocket,
  createApp,
  WS_PATH,
} from '../dist/index.js';

/**
 * Real-Docker + Postgres exercise of the WebSocket transport: real-time push,
 * stdin to a real agent process, and the Postgres persistence/recovery invariant
 * with the WS layer attached. Skips when infra is unavailable.
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

async function makeStack({ flushIntervalMs = 250 } = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-ws-it-'));
  const store = await SessionStore.connect({ connectionString: dbUrl });
  const provisioner = new SandboxProvisioner({ workspaceRoot });
  const engine = new OrchestratorEngine({ store, provisioner, spawner: new Orchestrator() }, { flushIntervalMs });
  engine.start();
  const server = createServer(createApp(engine));
  const socket = new OrchestratorSocket(engine, server);
  await new Promise((r) => server.listen(0, r));
  const wsUrl = `ws://127.0.0.1:${server.address().port}${WS_PATH}`;
  return { workspaceRoot, store, provisioner, engine, server, socket, wsUrl };
}

function connect(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for WS message')); }, timeoutMs);
    const onMsg = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) { cleanup(); resolve(msg); }
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMsg); };
    ws.on('message', onMsg);
  });
}

async function firstAgentId(store, sessionID) {
  const graph = await store.getSession(sessionID);
  return graph.agents[0].agentID.slice(sessionID.length + 1);
}

test('WS pushes stdout/stderr in real time — before the DB flush', { skip }, async (t) => {
  // Huge flush interval so output reaches the WS well before it ever hits the DB.
  const s = await makeStack({ flushIntervalMs: 60_000 });
  const ws = await connect(s.wsUrl);
  let sessionID, containerID;
  t.after(async () => {
    ws.close();
    if (containerID) await s.provisioner.destroy(containerID).catch(() => {});
    await s.socket.close();
    s.server.close();
    await s.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const outP = waitFor(ws, (m) => m.type === 'stdout' && m.payload === 'WS_OUT');
  const errP = waitFor(ws, (m) => m.type === 'stderr' && m.payload === 'WS_ERR');
  ({ sessionID } = await s.engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo WS_OUT; echo WS_ERR 1>&2; sleep 60'] }));
  containerID = (await s.store.getSession(sessionID)).sandboxes[0].containerID;

  const out = await outP;
  await errP;
  assert.equal(out.sessionId, sessionID);
  assert.equal(out.agentId, await firstAgentId(s.store, sessionID));

  // The DB buffer is still empty — proof the WS push is real-time, not the 1s
  // flush loop (which here won't fire for 60s).
  const beforeFlush = await s.store.getSession(sessionID);
  assert.equal(beforeFlush.agents[0].stdoutBuffer, '', 'WS delivered before any DB flush');

  // The DB-persistence path still works when explicitly flushed.
  await s.engine.flushBuffers();
  const afterFlush = await s.store.getSession(sessionID);
  assert.match(afterFlush.agents[0].stdoutBuffer, /WS_OUT/);
  assert.match(afterFlush.agents[0].stderrBuffer, /WS_ERR/);
});

test('WS stdin reaches the real agent process and echoes back over WS', { skip }, async (t) => {
  const s = await makeStack();
  const ws = await connect(s.wsUrl);
  let containerID;
  t.after(async () => {
    ws.close();
    if (containerID) await s.provisioner.destroy(containerID).catch(() => {});
    await s.socket.close();
    s.server.close();
    await s.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const { sessionID } = await s.engine.createSession({ repoPath: null, command: ['cat'] });
  containerID = (await s.store.getSession(sessionID)).sandboxes[0].containerID;
  const agentId = await firstAgentId(s.store, sessionID);

  const echoP = waitFor(ws, (m) => m.type === 'stdout' && m.payload === 'PING-OVER-WS');
  const t0 = Date.now();
  ws.send(JSON.stringify({ type: 'stdin', sessionId: sessionID, agentId, data: 'PING-OVER-WS\n' }));
  const echo = await echoP;
  const latency = Date.now() - t0;

  assert.equal(echo.sessionId, sessionID);
  assert.equal(echo.agentId, agentId);
  assert.ok(latency < 2000, `stdin→echo round-trip ${latency}ms`);
});

test('persistence + recovery unbroken with WS attached (restart mid-stream)', { skip }, async (t) => {
  const s = await makeStack({ flushIntervalMs: 200 });
  const ws = await connect(s.wsUrl);

  const { sessionID } = await s.engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo PERSIST_ME; sleep 60'] });
  const containerID = (await s.store.getSession(sessionID)).sandboxes[0].containerID;

  // Mid-stream: the line is delivered live over WS...
  await waitFor(ws, (m) => m.type === 'stdout' && m.payload === 'PERSIST_ME');
  // ...and the flush loop still persists it to Postgres.
  const deadline = Date.now() + 5000;
  let persisted = false;
  while (Date.now() < deadline && !persisted) {
    const g = await s.store.getSession(sessionID);
    persisted = g.agents[0].stdoutBuffer.includes('PERSIST_ME');
    if (!persisted) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(persisted, 'output flushed to Postgres while streaming over WS');

  // Simulate orchestrator restart.
  ws.close();
  await s.socket.close();
  s.server.close();
  await s.engine.shutdown(); // pauses session, closes store, leaves sandbox running

  // A fresh orchestrator recovers from the DB; the buffered output is intact.
  const b = await makeStack();
  t.after(async () => {
    await b.engine.destroySession(sessionID).catch(() => {});
    await s.provisioner.destroy(containerID).catch(() => {});
    await b.socket.close();
    b.server.close();
    await b.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(b.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const recovery = await b.engine.recover();
  assert.ok(recovery.reconnected.includes(sessionID), 'session recovered after restart');
  const recovered = await b.store.getSession(sessionID);
  assert.equal(recovered.session.status, 'active');
  assert.match(recovered.agents[0].stdoutBuffer, /PERSIST_ME/, 'buffered output recoverable from DB');
});
