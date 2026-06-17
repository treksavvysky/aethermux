import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import pg from 'pg';
import { WebSocket } from 'ws';
import { SandboxProvisioner, Orchestrator, SessionStore, OrchestratorEngine, createApp, OrchestratorSocket, WS_PATH } from '../dist/index.js';

/**
 * End-to-end attention-ring state machine over real Docker + Postgres + WS,
 * using scripted stub agents. Covers the full path (running → awaiting-input →
 * stdin → exited) and the no-false-green invariant (non-zero exit → error).
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
const TOKEN = 'attn-token';

async function makeStack() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-attn-it-'));
  const store = await SessionStore.connect({ connectionString: dbUrl });
  const provisioner = new SandboxProvisioner({ workspaceRoot });
  const engine = new OrchestratorEngine({ store, provisioner, spawner: new Orchestrator() }, { flushIntervalMs: 200 });
  engine.start();
  const server = createServer(createApp(engine, { token: TOKEN }));
  const socket = new OrchestratorSocket(engine, server, { token: TOKEN });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { workspaceRoot, store, provisioner, engine, server, socket, base, wsUrl: `ws://127.0.0.1:${server.address().port}${WS_PATH}?token=${TOKEN}` };
}

function connect(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, predicate, timeoutMs = 12000) {
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

function collectStates(ws, into) {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'agentState') into.push(msg.state);
  });
}

const listSessions = async (base) => (await fetch(`${base}/sessions`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();

test('full path: running → awaiting-input (blue) → stdin → exited 0 (green); GET /sessions reflects it', { skip }, async (t) => {
  const s = await makeStack();
  const ws = await connect(s.wsUrl);
  const states = [];
  collectStates(ws, states);
  let containerID;
  t.after(async () => {
    if (containerID) await s.provisioner.destroy(containerID).catch(() => {});
    ws.close();
    await s.socket.close();
    s.server.close();
    await s.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const awaitingP = waitFor(ws, (m) => m.type === 'agentState' && m.state === 'awaiting-input');
  const { sessionID } = await s.engine.createSession({
    repoPath: null,
    command: ['sh', '-c', 'echo "Continue? [y/N]"; read ans; echo "got:$ans"; exit 0'],
  });
  containerID = (await s.store.getSession(sessionID)).sandboxes[0].containerID;

  const awaiting = await awaitingP;
  const agentId = awaiting.agentId;
  assert.equal(awaiting.sessionId, sessionID);

  // GET /sessions reflects the live state machine (awaiting-input).
  const list1 = await listSessions(s.base);
  assert.equal(list1.find((x) => x.sessionId === sessionID).attentionState, 'awaiting-input');

  // The operator answers over the WS; the agent resumes and exits 0 → green.
  const terminalP = waitFor(ws, (m) => m.type === 'agentState' && (m.state === 'exited' || m.state === 'error'));
  ws.send(JSON.stringify({ type: 'stdin', sessionId: sessionID, agentId, data: 'y\n' }));
  const terminal = await terminalP;
  assert.equal(terminal.state, 'exited');

  // The broadcast sequence carried the real transitions.
  assert.ok(states.includes('running'), 'initial running broadcast');
  assert.ok(states.includes('awaiting-input'), 'awaiting-input broadcast');
  assert.equal(states.at(-1), 'exited', 'ends green');

  const list2 = await listSessions(s.base);
  assert.equal(list2.find((x) => x.sessionId === sessionID).attentionState, 'exited');
});

test('no false green: an agent that exits non-zero shows error, never exited', { skip }, async (t) => {
  const s = await makeStack();
  const ws = await connect(s.wsUrl);
  const states = [];
  collectStates(ws, states);
  let containerID;
  t.after(async () => {
    if (containerID) await s.provisioner.destroy(containerID).catch(() => {});
    ws.close();
    await s.socket.close();
    s.server.close();
    await s.store.close().catch(() => {});
    await fs.rm(s.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const terminalP = waitFor(ws, (m) => m.type === 'agentState' && (m.state === 'exited' || m.state === 'error'));
  const { sessionID } = await s.engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo bye; exit 3'] });
  containerID = (await s.store.getSession(sessionID)).sandboxes[0].containerID;

  const terminal = await terminalP;
  assert.equal(terminal.state, 'error', 'non-zero exit must surface as error');
  assert.ok(!states.includes('exited'), 'must never broadcast exited (green) for a non-zero exit');

  const list = await listSessions(s.base);
  assert.equal(list.find((x) => x.sessionId === sessionID).attentionState, 'error');
});
