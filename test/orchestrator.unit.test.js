import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  Orchestrator,
  AgentLogBuffer,
  SpawnError,
  formatLogEntry,
  formatAgentId,
  toEnvArray,
  validateSpawnContract,
} from '../dist/index.js';

const validContract = () => ({
  sessionID: 's1',
  containerID: 'c1',
  command: ['echo', 'hi'],
  workspaceDir: '/workspace',
  env: {},
});

test('formatAgentId zero-pads and grows past two digits', () => {
  assert.equal(formatAgentId(1), 'agent-01');
  assert.equal(formatAgentId(12), 'agent-12');
  assert.equal(formatAgentId(105), 'agent-105');
});

test('toEnvArray renders KEY=VALUE pairs', () => {
  assert.deepEqual(toEnvArray({ A: '1', B: '2' }), ['A=1', 'B=2']);
  assert.deepEqual(toEnvArray({}), []);
});

test('formatLogEntry is timestamped and agent-tagged', () => {
  const e = {
    agentId: 'agent-01',
    stream: 'stdout',
    timestamp: '2026-06-13T00:00:00.000Z',
    sequence: 0,
    text: 'hello world',
  };
  assert.equal(formatLogEntry(e), '2026-06-13T00:00:00.000Z [agent-01] stdout: hello world');
  assert.equal(formatLogEntry(e, { withTimestamp: false }), '[agent-01] stdout: hello world');
});

test('validateSpawnContract accepts a good contract and rejects bad fields', () => {
  assert.doesNotThrow(() => validateSpawnContract(validContract()));
  const mutations = [
    (o) => (o.sessionID = ''),
    (o) => (o.containerID = ''),
    (o) => (o.command = []),
    (o) => (o.command = 'echo hi'),
    (o) => (o.workspaceDir = ''),
    (o) => (o.env = null),
  ];
  for (const mutate of mutations) {
    const o = validContract();
    mutate(o);
    assert.throws(() => validateSpawnContract(o), SpawnError);
  }
});

test('AgentLogBuffer: ordered reads, blocking, ring-drop, and finish', async () => {
  const mk = (i) => ({ agentId: 'agent-01', stream: 'stdout', timestamp: 't', sequence: i, text: `l${i}` });
  const buf = new AgentLogBuffer(3);

  buf.push(mk(0));
  buf.push(mk(1));
  let r = await buf.readFrom(0);
  assert.equal(r.entry.text, 'l0');
  r = await buf.readFrom(r.next);
  assert.equal(r.entry.text, 'l1');

  // Blocking read resolves when the next entry is pushed.
  const pending = buf.readFrom(2);
  buf.push(mk(2));
  r = await pending;
  assert.equal(r.entry.text, 'l2');

  // Capacity is 3; pushing a 4th drops the oldest retained entry.
  buf.push(mk(3));
  assert.equal(buf.dropped, 1);
  assert.equal(buf.length, 3);
  r = await buf.readFrom(0); // stale cursor fast-forwards to oldest retained
  assert.equal(r.entry.text, 'l1');

  // After finish, reads past the end resolve to null.
  buf.finish();
  r = await buf.readFrom(99);
  assert.equal(r.entry, null);
});

// A fake Docker exec whose hijacked stream we drive directly — exercises the
// spawn → demux → line-split → buffer → lifecycle wiring without a real daemon.
function makeFakeDocker({ exitCode = 0 } = {}) {
  const execStream = new PassThrough();
  const calls = {};
  const exec = {
    start: async () => execStream,
    inspect: async () => ({ Running: false, ExitCode: exitCode }),
  };
  const container = {
    exec: async (args) => {
      calls.execArgs = args;
      return exec;
    },
  };
  const modem = {
    demuxStream: (src, stdout) => {
      // Treat all fake output as stdout; orchestrator ends the channels on EOF.
      src.on('data', (chunk) => stdout.write(chunk));
    },
  };
  return { docker: { getContainer: () => container, modem }, execStream, calls };
}

test('Orchestrator.spawn: maps the contract, captures output, tracks lifecycle', async () => {
  const { docker, execStream, calls } = makeFakeDocker({ exitCode: 0 });
  const orch = new Orchestrator(docker);

  const handle = await orch.spawn({
    sessionID: 's1',
    containerID: 'c1',
    command: ['echo', 'hi'],
    workspaceDir: '/workspace',
    env: { FOO: 'bar' },
  });

  assert.equal(handle.id, 'agent-01');
  assert.equal(handle.status, 'running');
  assert.deepEqual(calls.execArgs.Cmd, ['echo', 'hi']);
  assert.deepEqual(calls.execArgs.Env, ['FOO=bar']);
  assert.equal(calls.execArgs.WorkingDir, '/workspace');
  assert.equal(calls.execArgs.Tty, false);

  execStream.write('line one\nline two\n');
  execStream.end();

  const exit = await handle.wait();
  assert.equal(exit.status, 'exited');
  assert.equal(exit.exitCode, 0);
  assert.equal(handle.status, 'exited');

  const a = await handle.read();
  assert.equal(a.text, 'line one');
  assert.equal(a.stream, 'stdout');
  assert.equal(a.agentId, 'agent-01');
  assert.equal(a.sequence, 0);
  const b = await handle.read();
  assert.equal(b.text, 'line two');
  assert.equal(await handle.read(), null); // drained + finished
});

test('Orchestrator: sequential agent ids, get(), and list()', async () => {
  const container = {
    exec: async () => {
      const s = new PassThrough();
      queueMicrotask(() => s.end());
      return { start: async () => s, inspect: async () => ({ ExitCode: 0 }) };
    },
  };
  const docker = { getContainer: () => container, modem: { demuxStream: (src, out) => src.on('data', (c) => out.write(c)) } };
  const orch = new Orchestrator(docker);

  const h1 = await orch.spawn({ sessionID: 's', containerID: 'c', command: ['true'], workspaceDir: '/w', env: {} });
  const h2 = await orch.spawn({ sessionID: 's', containerID: 'c', command: ['true'], workspaceDir: '/w', env: {} });
  assert.equal(h1.id, 'agent-01');
  assert.equal(h2.id, 'agent-02');
  assert.deepEqual(orch.list().map((h) => h.id), ['agent-01', 'agent-02']);
  assert.equal(orch.get('agent-02'), h2);
  await Promise.all([h1.wait(), h2.wait()]);
});

test('AgentHandle.write injects stdin while running and refuses once exited', async () => {
  const { docker, execStream } = makeFakeDocker();
  const written = [];
  execStream.write = (chunk, cb) => {
    written.push(chunk.toString());
    if (typeof cb === 'function') cb();
    return true;
  };
  const orch = new Orchestrator(docker);
  const handle = await orch.spawn(validContract());

  await handle.write('hello\n');
  assert.deepEqual(written, ['hello\n']);

  handle._finalize('exited', 0);
  await assert.rejects(() => handle.write('again'), SpawnError);
});

test('spawn rejects an invalid contract before touching Docker', async () => {
  let touched = false;
  const docker = { getContainer: () => { touched = true; return {}; }, modem: { demuxStream: () => {} } };
  const orch = new Orchestrator(docker);
  await assert.rejects(() => orch.spawn({ ...validContract(), command: [] }), SpawnError);
  assert.equal(touched, false, 'Docker must not be touched for an invalid contract');
});
