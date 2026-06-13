import { test } from 'node:test';
import assert from 'node:assert/strict';

import pg from 'pg';
import { SessionStore, TRUNCATION_MARKER } from '../dist/index.js';

/**
 * Real-PostgreSQL exercise of the persistence layer. Runs when
 * AETHERMUX_TEST_DATABASE_URL points at a reachable database; otherwise skips so
 * the suite stays green in environments without Postgres.
 */
const url = process.env.AETHERMUX_TEST_DATABASE_URL;

async function canConnect(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const reachable = url ? await canConnect(url) : false;
const skip = reachable ? false : 'AETHERMUX_TEST_DATABASE_URL not set or unreachable';

const uid = (label) => `${label}-${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

test('connection pool handles concurrent queries', { skip }, async (t) => {
  const store = await SessionStore.connect({ connectionString: url, poolMax: 10 });
  t.after(() => store.close());
  const results = await Promise.all(Array.from({ length: 25 }, () => store.healthcheck()));
  assert.ok(results.every((ok) => ok === true), 'all concurrent health checks succeed');
});

test('state survives an orchestrator restart (create → close → reconnect → recover)', { skip }, async (t) => {
  const sessionID = uid('sess');
  const containerID = uid('cont');
  const agentID = uid('agent');

  // --- orchestrator instance A: write the full graph ---
  const storeA = await SessionStore.connect({ connectionString: url });
  await storeA.createSession({ sessionID, repoPath: '/repos/app' });
  await storeA.upsertSandbox({ containerID, sessionID, workspacePath: `/workspace/${sessionID}` });
  await storeA.upsertAgent({ agentID, sandboxID: containerID, sessionID, command: ['aider', '--model', 'gpt'], status: 'running' });
  await storeA.appendAgentOutput(agentID, 'stdout', 'hello from agent\n');
  await storeA.appendAgentOutput(agentID, 'stderr', 'a warning\n');
  await storeA.updateAgentStatus(agentID, 'exited', 0);
  assert.equal(await storeA.healthcheck(), true);
  await storeA.close(); // simulate orchestrator restart (drop all connections)

  // --- orchestrator instance B: recover from the database alone ---
  const storeB = await SessionStore.connect({ connectionString: url });
  t.after(async () => {
    await storeB.destroySession(sessionID).catch(() => {});
    await storeB.close();
  });

  const graph = await storeB.getSession(sessionID);
  assert.ok(graph, 'session recovered');
  assert.equal(graph.session.sessionID, sessionID);
  assert.equal(graph.session.repoPath, '/repos/app');
  assert.equal(graph.session.status, 'active');

  assert.equal(graph.sandboxes.length, 1);
  assert.equal(graph.sandboxes[0].containerID, containerID);
  assert.equal(graph.sandboxes[0].workspacePath, `/workspace/${sessionID}`);

  assert.equal(graph.agents.length, 1);
  const agent = graph.agents[0];
  assert.equal(agent.agentID, agentID);
  assert.equal(agent.sandboxID, containerID);
  assert.deepEqual(agent.command, ['aider', '--model', 'gpt']);
  assert.equal(agent.status, 'exited');
  assert.equal(agent.processExitCode, 0);
  assert.match(agent.stdoutBuffer, /hello from agent/);
  assert.match(agent.stderrBuffer, /a warning/);

  // The recovered session shows up among active sessions.
  const active = await storeB.listActiveSessions();
  assert.ok(active.some((s) => s.sessionID === sessionID), 'recovered session is listed active');

  // Destroy cascades to sandboxes and agents.
  assert.equal(await storeB.destroySession(sessionID), true);
  assert.equal(await storeB.getSession(sessionID), null);
});

test('heartbeat freshness: stale sessions are marked for cleanup', { skip }, async (t) => {
  const store = await SessionStore.connect({ connectionString: url });
  const fresh = uid('fresh');
  const old = uid('old');
  t.after(async () => {
    await store.destroySession(fresh).catch(() => {});
    await store.destroySession(old).catch(() => {});
    await store.close();
  });

  await store.createSession({ sessionID: fresh });
  await store.createSession({ sessionID: old });
  // Backdate one session's heartbeat past the 5-minute threshold.
  await store.updateSession(old, { lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000) });

  const marked = await store.markStaleSessions(5 * 60 * 1000);
  assert.ok(marked.includes(old), 'stale session was marked');
  assert.ok(!marked.includes(fresh), 'fresh session was not marked');

  const oldGraph = await store.getSession(old);
  assert.equal(oldGraph.session.status, 'stale');
  const active = await store.listActiveSessions();
  assert.ok(active.some((s) => s.sessionID === fresh), 'fresh session still active');
  assert.ok(!active.some((s) => s.sessionID === old), 'stale session no longer active');

  // A fresh heartbeat updates the timestamp.
  const before = oldGraph.session.lastHeartbeat.getTime();
  await store.recordHeartbeat(fresh);
  const freshGraph = await store.getSession(fresh);
  assert.ok(freshGraph.session.lastHeartbeat.getTime() >= before);
});

test('per-agent output buffer is capped and marks truncation; small writes are verbatim', { skip }, async (t) => {
  const cap = 64;
  const owner = await SessionStore.connect({ connectionString: url });
  // A second store sharing the same pool but with a small buffer cap.
  const capped = new SessionStore({ pool: owner.pool, maxBufferBytes: cap });
  const sessionID = uid('buf');
  const containerID = uid('cont');
  const bigAgent = uid('big');
  const smallAgent = uid('small');
  t.after(async () => {
    await owner.destroySession(sessionID).catch(() => {});
    await owner.close();
  });

  await capped.createSession({ sessionID });
  await capped.upsertSandbox({ containerID, sessionID, workspacePath: `/workspace/${sessionID}` });
  await capped.upsertAgent({ agentID: bigAgent, sandboxID: containerID, sessionID, command: ['cat'] });
  await capped.upsertAgent({ agentID: smallAgent, sandboxID: containerID, sessionID, command: ['cat'] });

  // Append well beyond the cap: the buffer must end up at/under the cap, carry
  // the truncation marker, and retain the most-recent output.
  await capped.appendAgentOutput(bigAgent, 'stdout', 'A'.repeat(200));
  await capped.appendAgentOutput(bigAgent, 'stdout', 'NEWEST-OUTPUT-END');

  const graph = await capped.getSession(sessionID);
  const big = graph.agents.find((a) => a.agentID === bigAgent).stdoutBuffer;
  assert.ok(big.length <= cap, `buffer ${big.length} must be <= cap ${cap}`);
  assert.ok(big.startsWith(TRUNCATION_MARKER), 'truncated buffer carries the truncation marker');
  assert.ok(big.endsWith('NEWEST-OUTPUT-END'), 'most-recent output retained at the tail');

  // A write that stays under the cap is stored verbatim, with no marker.
  await capped.appendAgentOutput(smallAgent, 'stdout', 'short line\n');
  const graph2 = await capped.getSession(sessionID);
  const small = graph2.agents.find((a) => a.agentID === smallAgent).stdoutBuffer;
  assert.equal(small, 'short line\n', 'sub-cap output stored verbatim');
  assert.ok(!small.includes(TRUNCATION_MARKER), 'no marker when under the cap');
});
