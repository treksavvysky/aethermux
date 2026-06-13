import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { OrchestratorEngine } from '../dist/index.js';

/** A fake SessionStore that records calls and returns canned data. */
function makeStore(overrides = {}) {
  const calls = {
    createSession: [],
    upsertSandbox: [],
    upsertAgent: [],
    appendAgentOutput: [],
    updateAgentStatus: [],
    updateSession: [],
    destroySession: [],
    close: 0,
  };
  const store = {
    calls,
    createSession: async (input) => { calls.createSession.push(input); return { ...input }; },
    upsertSandbox: async (input) => { calls.upsertSandbox.push(input); return { ...input }; },
    upsertAgent: async (input) => { calls.upsertAgent.push(input); return { ...input }; },
    appendAgentOutput: async (agentID, stream, text) => { calls.appendAgentOutput.push({ agentID, stream, text }); },
    updateAgentStatus: async (agentID, status, exitCode) => { calls.updateAgentStatus.push({ agentID, status, exitCode }); },
    updateSession: async (sessionID, patch) => { calls.updateSession.push({ sessionID, patch }); return { sessionID, ...patch }; },
    getSession: async () => null,
    listActiveSessions: async () => [],
    listSessionsByStatus: async () => [],
    destroySession: async (sessionID) => { calls.destroySession.push(sessionID); return true; },
    close: async () => { calls.close += 1; },
    ...overrides,
  };
  return store;
}

function makeProvisioner(overrides = {}) {
  const calls = { create: [], destroy: [], isRunning: [] };
  return {
    calls,
    create: async (repoPath, sessionID) => {
      calls.create.push({ repoPath, sessionID });
      return { containerID: 'cont-1', workspacePath: '/ws/' + sessionID, sessionID };
    },
    destroy: async (containerID) => { calls.destroy.push(containerID); },
    isRunning: async (containerID) => { calls.isRunning.push(containerID); return true; },
    ...overrides,
  };
}

function makeHandle(id) {
  const h = new EventEmitter();
  h.id = id;
  return h;
}

function makeSpawner(handle, overrides = {}) {
  const calls = { spawn: [] };
  return {
    calls,
    spawn: async (contract) => { calls.spawn.push(contract); return handle; },
    ...overrides,
  };
}

test('createSession: provisions, spawns, and persists in order; returns a session id', async () => {
  const store = makeStore();
  const provisioner = makeProvisioner();
  const handle = makeHandle('agent-01');
  const spawner = makeSpawner(handle);
  const engine = new OrchestratorEngine({ store, provisioner, spawner });

  const { sessionID } = await engine.createSession({ repoPath: '/repo', command: ['echo', 'hi'], env: { A: '1' } });

  assert.match(sessionID, /^s-/);
  assert.equal(store.calls.createSession[0].repoPath, '/repo');
  assert.equal(store.calls.createSession[0].status, 'active');
  assert.deepEqual(provisioner.calls.create[0], { repoPath: '/repo', sessionID });
  assert.equal(store.calls.upsertSandbox[0].containerID, 'cont-1');
  const spawn = spawner.calls.spawn[0];
  assert.deepEqual(spawn.command, ['echo', 'hi']);
  assert.equal(spawn.containerID, 'cont-1');
  assert.equal(spawn.workspaceDir, '/workspace');
  assert.deepEqual(spawn.env, { A: '1' });
  assert.equal(store.calls.upsertAgent[0].agentID, `${sessionID}:agent-01`);
});

test('createSession: a spawn failure tears the sandbox back down (no live leftover)', async () => {
  const store = makeStore();
  const provisioner = makeProvisioner();
  const handle = makeHandle('agent-01');
  const spawner = makeSpawner(handle, { spawn: async () => { throw new Error('spawn boom'); } });
  const engine = new OrchestratorEngine({ store, provisioner, spawner });

  await assert.rejects(() => engine.createSession({ command: ['true'] }), /spawn boom/);
  assert.equal(provisioner.calls.destroy[0], 'cont-1', 'sandbox destroyed on failure');
  assert.equal(store.calls.destroySession.length, 1, 'session row removed on failure');
});

test('flushBuffers: streams agent output to the DB and persists terminal status', async () => {
  const store = makeStore();
  const handle = makeHandle('agent-01');
  const engine = new OrchestratorEngine({ store, provisioner: makeProvisioner(), spawner: makeSpawner(handle) });
  const { sessionID } = await engine.createSession({ command: ['x'] });
  const agentID = `${sessionID}:agent-01`;

  handle.emit('log', { agentId: 'agent-01', stream: 'stdout', text: 'hello', timestamp: 't', sequence: 0 });
  handle.emit('log', { agentId: 'agent-01', stream: 'stderr', text: 'warn', timestamp: 't', sequence: 1 });
  await engine.flushBuffers();

  assert.deepEqual(store.calls.appendAgentOutput, [
    { agentID, stream: 'stdout', text: 'hello\n' },
    { agentID, stream: 'stderr', text: 'warn\n' },
  ]);

  handle.emit('exit', { status: 'exited', exitCode: 0 });
  await engine.flushBuffers();
  assert.deepEqual(store.calls.updateAgentStatus, [{ agentID, status: 'exited', exitCode: 0 }]);

  // Nothing pending → no duplicate writes on a subsequent flush.
  await engine.flushBuffers();
  assert.equal(store.calls.appendAgentOutput.length, 2);
  assert.equal(store.calls.updateAgentStatus.length, 1);
});

test('recover: reconnect when a sandbox is running, orphan when it is gone', async () => {
  const paused = [{ sessionID: 's-a' }, { sessionID: 's-b' }];
  const graphs = {
    's-a': { session: paused[0], sandboxes: [{ containerID: 'c-a', workspacePath: '/wa' }], agents: [] },
    's-b': { session: paused[1], sandboxes: [{ containerID: 'c-b', workspacePath: '/wb' }], agents: [] },
  };
  const store = makeStore({
    listSessionsByStatus: async (s) => (s === 'paused' ? paused : []),
    getSession: async (id) => graphs[id],
  });
  const provisioner = makeProvisioner({ isRunning: async (id) => id === 'c-a' });
  const engine = new OrchestratorEngine({ store, provisioner, spawner: makeSpawner(makeHandle('a')) });

  const result = await engine.recover();
  assert.deepEqual(result.reconnected, ['s-a']);
  assert.deepEqual(result.orphaned, ['s-b']);
  assert.deepEqual(store.calls.updateSession, [
    { sessionID: 's-a', patch: { status: 'active' } },
    { sessionID: 's-b', patch: { status: 'orphaned' } },
  ]);
});

test('shutdown: pauses owned sessions and closes the store', async () => {
  const store = makeStore();
  const handle = makeHandle('agent-01');
  const engine = new OrchestratorEngine({ store, provisioner: makeProvisioner(), spawner: makeSpawner(handle) });
  const { sessionID } = await engine.createSession({ command: ['x'] });
  engine.start();

  await engine.shutdown();
  assert.deepEqual(store.calls.updateSession, [{ sessionID, patch: { status: 'paused' } }]);
  assert.equal(store.calls.close, 1);
});
