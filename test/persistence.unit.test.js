import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SessionStore,
  PersistenceError,
  resolvePoolConfig,
  isOutputStream,
  serializeCommand,
  parseCommand,
  mapSessionRow,
  mapSandboxRow,
  mapAgentRow,
  MIGRATIONS,
} from '../dist/index.js';

test('resolvePoolConfig clamps max into [10, 50] and floors min at 0', () => {
  assert.deepEqual(resolvePoolConfig({}), { connectionString: undefined, max: 10, min: 0 });
  assert.equal(resolvePoolConfig({ poolMax: 5 }).max, 10);
  assert.equal(resolvePoolConfig({ poolMax: 100 }).max, 50);
  assert.equal(resolvePoolConfig({ poolMax: 30 }).max, 30);
  assert.equal(resolvePoolConfig({ poolMin: -3 }).min, 0);
  assert.equal(resolvePoolConfig({ poolMin: 5 }).min, 5);
  assert.equal(resolvePoolConfig({ connectionString: 'postgres://x' }).connectionString, 'postgres://x');
});

test('isOutputStream guards the dynamic column name', () => {
  assert.equal(isOutputStream('stdout'), true);
  assert.equal(isOutputStream('stderr'), true);
  assert.equal(isOutputStream('stdin'), false);
  assert.equal(isOutputStream('; DROP TABLE'), false);
});

test('command (de)serialization round-trips and tolerates legacy text', () => {
  assert.equal(serializeCommand(['aider', '--model', 'x']), '["aider","--model","x"]');
  assert.deepEqual(parseCommand('["aider","--model","x"]'), ['aider', '--model', 'x']);
  assert.deepEqual(parseCommand('plain text'), ['plain text']);
  assert.deepEqual(parseCommand('123'), ['123']); // valid JSON but not string[]
});

test('row mappers convert snake_case rows to domain objects', () => {
  const d = new Date('2026-06-13T00:00:00.000Z');
  assert.deepEqual(mapSessionRow({ session_id: 's', created_at: d, last_heartbeat: d, repo_path: null, status: 'active' }), {
    sessionID: 's',
    createdAt: d,
    lastHeartbeat: d,
    repoPath: null,
    status: 'active',
  });
  assert.deepEqual(mapSandboxRow({ container_id: 'c', session_id: 's', created_at: d, workspace_path: '/ws', status: 'running' }), {
    containerID: 'c',
    sessionID: 's',
    createdAt: d,
    workspacePath: '/ws',
    status: 'running',
  });
  assert.deepEqual(
    mapAgentRow({
      agent_id: 'agent-01',
      sandbox_id: 'c',
      session_id: 's',
      command: '["echo","hi"]',
      status: 'exited',
      process_exit_code: null,
      stdout_buffer: 'out',
      stderr_buffer: 'err',
      created_at: d,
    }),
    {
      agentID: 'agent-01',
      sandboxID: 'c',
      sessionID: 's',
      command: ['echo', 'hi'],
      status: 'exited',
      processExitCode: null,
      stdoutBuffer: 'out',
      stderrBuffer: 'err',
      createdAt: d,
    },
  );
});

test('appendAgentOutput rejects an invalid stream before touching the pool', async () => {
  let queried = false;
  const fakePool = {
    query: async () => {
      queried = true;
      return { rows: [], rowCount: 0 };
    },
    end: async () => {},
  };
  const store = new SessionStore({ pool: fakePool });
  await assert.rejects(() => store.appendAgentOutput('agent-01', 'bogus', 'x'), PersistenceError);
  assert.equal(queried, false, 'a bad stream must never reach SQL');
});

test('MIGRATIONS contains the initial schema migration', () => {
  assert.ok(MIGRATIONS.length >= 1);
  assert.equal(MIGRATIONS[0].id, '0001_init');
  assert.match(MIGRATIONS[0].sql, /CREATE TABLE IF NOT EXISTS sessions/);
});
