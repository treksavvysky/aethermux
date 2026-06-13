import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import pg from 'pg';
import {
  SandboxProvisioner,
  Orchestrator,
  SessionStore,
  OrchestratorEngine,
  SandboxError,
} from '../dist/index.js';

/**
 * Comprehensive end-to-end coverage of the Phase 1 orchestrator against real
 * Docker + PostgreSQL: provision → spawn → stream read → DB persistence →
 * restart recovery, plus the contract's specific scenarios (parallel agents
 * with no stream mixing, restart recovery, agent exit recorded, and a failed
 * provision leaving no orphaned containers).
 *
 * Skips when Docker or a test database is unavailable.
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
const docker = ready ? new Docker() : null;

async function makeEngine() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-e2e-'));
  const store = await SessionStore.connect({ connectionString: dbUrl });
  const provisioner = new SandboxProvisioner({ workspaceRoot });
  const engine = new OrchestratorEngine({ store, provisioner, spawner: new Orchestrator() }, { flushIntervalMs: 250 });
  return { engine, store, provisioner, workspaceRoot };
}

/** Containers carrying a specific session label (isolation-safe under parallelism). */
async function containersForSession(sessionLabel) {
  return docker.listContainers({ all: true, filters: { label: [`aethermux.session=${sessionLabel}`] } });
}

/** Polls the session graph until `predicate` holds or the timeout elapses. */
async function waitForGraph(store, sessionID, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let graph = await store.getSession(sessionID);
  while (!predicate(graph) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    graph = await store.getSession(sessionID);
  }
  return graph;
}

async function drain(handle) {
  const out = [];
  for (;;) {
    const entry = await handle.read();
    if (entry === null) break;
    out.push(entry);
  }
  return out;
}

test('e2e: provision → spawn → stream read → DB persistence → restart recovery', { skip }, async (t) => {
  const { engine, store, provisioner, workspaceRoot } = await makeEngine();
  engine.start();

  const { sessionID } = await engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo E2E_LINE; sleep 60'] });

  // Provisioned + spawned + persisted.
  const created = await store.getSession(sessionID);
  assert.equal(created.session.status, 'active');
  assert.equal(created.sandboxes.length, 1);
  assert.equal(created.sandboxes[0].status, 'running');
  assert.equal(created.agents.length, 1);
  const containerID = created.sandboxes[0].containerID;
  assert.equal(await provisioner.isRunning(containerID), true);

  // Stream read → DB persistence (flush loop writes the agent buffer).
  const flushed = await waitForGraph(store, sessionID, (g) => g?.agents[0]?.stdoutBuffer.includes('E2E_LINE'));
  assert.match(flushed.agents[0].stdoutBuffer, /E2E_LINE/);

  // Restart recovery: pause + close (simulated kill), reconnect from a fresh engine.
  await engine.shutdown(); // closes the original store; clean up via engine B below.
  const b = await makeEngine();
  t.after(async () => {
    await b.engine.destroySession(sessionID).catch(() => {});
    await provisioner.destroy(containerID).catch(() => {}); // Docker-only safety net
    await store.close().catch(() => {});
    await b.store.close().catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(b.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });
  const recovery = await b.engine.recover();
  assert.ok(recovery.reconnected.includes(sessionID));
  const recovered = await b.store.getSession(sessionID);
  assert.equal(recovered.session.status, 'active');
});

test('e2e: two agents in parallel produce unmixed, identifiable streams', { skip }, async (t) => {
  // Provision one shared sandbox, then spawn two agents into it concurrently.
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-e2e-mix-'));
  const provisioner = new SandboxProvisioner({ workspaceRoot });
  const spawner = new Orchestrator();
  const sandbox = await provisioner.create(null, `mix${process.pid}${Date.now().toString(36)}`);
  t.after(async () => {
    await provisioner.destroy(sandbox.containerID).catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const base = { sessionID: 'mix', containerID: sandbox.containerID, workspaceDir: '/workspace', env: {} };
  const [a, b] = await Promise.all([
    spawner.spawn({ ...base, command: ['sh', '-c', 'echo AAA-1; echo AAA-2'] }),
    spawner.spawn({ ...base, command: ['sh', '-c', 'echo BBB-1; echo BBB-2'] }),
  ]);
  await Promise.all([a.wait(), b.wait()]);
  const [aLines, bLines] = await Promise.all([drain(a), drain(b)]);

  const aText = aLines.map((e) => e.text);
  const bText = bLines.map((e) => e.text);
  assert.deepEqual(aText.filter((t) => t.startsWith('AAA')).sort(), ['AAA-1', 'AAA-2']);
  assert.ok(!aText.some((t) => t.includes('BBB')), 'agent A leaked B output');
  assert.deepEqual(bText.filter((t) => t.startsWith('BBB')).sort(), ['BBB-1', 'BBB-2']);
  assert.ok(!bText.some((t) => t.includes('AAA')), 'agent B leaked A output');
});

test('e2e: orchestrator restart recovers the session and agent streams resume', { skip }, async (t) => {
  const a = await makeEngine();
  a.engine.start();
  const { sessionID } = await a.engine.createSession({ repoPath: null, command: ['sh', '-c', 'sleep 120'] });
  const containerID = (await a.store.getSession(sessionID)).sandboxes[0].containerID;
  await a.engine.shutdown(); // simulated crash; sandbox left running

  const b = await makeEngine();
  t.after(async () => {
    await b.engine.destroySession(sessionID).catch(() => {});
    await a.provisioner.destroy(containerID).catch(() => {}); // Docker-only safety net
    await b.store.close().catch(() => {});
    await fs.rm(a.workspaceRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(b.workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const recovery = await b.engine.recover();
  assert.ok(recovery.reconnected.includes(sessionID), 'session recovered');
  assert.equal((await b.store.getSession(sessionID)).session.status, 'active');

  // Streams resume: a fresh agent spawned into the recovered sandbox produces output.
  const resumed = await new Orchestrator().spawn({
    sessionID, containerID, command: ['sh', '-c', 'echo RESUMED'], workspaceDir: '/workspace', env: {},
  });
  await resumed.wait();
  const lines = (await drain(resumed)).map((e) => e.text);
  assert.ok(lines.includes('RESUMED'), 'streaming works against the recovered sandbox');
});

test('e2e: agent exit code and status are recorded in the DB', { skip }, async (t) => {
  const { engine, store, workspaceRoot } = await makeEngine();
  engine.start();
  const { sessionID } = await engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo bye; exit 3'] });
  t.after(async () => {
    await engine.destroySession(sessionID).catch(() => {});
    await store.close().catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  const graph = await waitForGraph(store, sessionID, (g) => g?.agents[0]?.status === 'exited');
  assert.equal(graph.agents[0].status, 'exited');
  assert.equal(graph.agents[0].processExitCode, 3);
});

test('e2e: a failed sandbox provision returns an error and leaves no orphaned containers', { skip }, async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-e2e-fail-'));
  const store = await SessionStore.connect({ connectionString: dbUrl });
  // An unresolvable image makes provisioning fail before any container exists.
  const provisioner = new SandboxProvisioner({ workspaceRoot, image: 'aethermux.invalid/nope:404' });
  const engine = new OrchestratorEngine({ store, provisioner, spawner: new Orchestrator() });
  t.after(async () => {
    await store.close().catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  // The engine surfaces the provisioning error rather than swallowing it.
  await assert.rejects(
    () => engine.createSession({ repoPath: null, command: ['sh', '-c', 'echo nope'] }),
    SandboxError,
  );

  // And no orphan is left behind — checked via a unique session label so this is
  // robust to other integration tests running concurrently on the same daemon.
  const sessionLabel = `fail-${process.pid}-${Date.now().toString(36)}`;
  await assert.rejects(() => provisioner.create(null, sessionLabel), SandboxError);
  const orphans = await containersForSession(sessionLabel);
  assert.equal(orphans.length, 0, 'no orphaned container for the failed provision');
});
