import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import { SandboxProvisioner, Orchestrator, formatLogEntry } from '../dist/index.js';

/**
 * Real-Docker exercise of the spawn contract: agents run inside a provisioned
 * sandbox and their streams must stay isolated. Skips when no daemon is
 * reachable so the suite is green in constrained environments.
 */
async function dockerReachable() {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

/** Reads every log entry from a handle until the process has exited. */
async function drain(handle) {
  const out = [];
  for (;;) {
    const entry = await handle.read();
    if (entry === null) break;
    out.push(entry);
  }
  return out;
}

const hasDocker = await dockerReachable();

test('two agents in one sandbox keep isolated stdout/stderr; stdin works', { skip: hasDocker ? false : 'Docker daemon not reachable' }, async (t) => {
  const sessionID = `it${process.pid}o${Date.now().toString(36)}`;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-orch-it-'));
  const docker = new Docker();
  const provisioner = new SandboxProvisioner({ workspaceRoot }, docker);
  const orch = new Orchestrator(docker);

  let sandbox;
  t.after(async () => {
    if (sandbox) await provisioner.destroy(sandbox.containerID).catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  sandbox = await provisioner.create(null, sessionID);
  const base = { sessionID, containerID: sandbox.containerID, workspaceDir: '/workspace', env: {} };

  // Two different commands in the SAME sandbox container.
  const a = await orch.spawn({ ...base, command: ['sh', '-c', 'echo A-OUT; echo A-ERR 1>&2'] });
  const b = await orch.spawn({ ...base, command: ['sh', '-c', 'echo B-OUT'] });

  assert.notEqual(a.id, b.id, 'agents get distinct ids');

  await Promise.all([a.wait(), b.wait()]);
  const aEntries = await drain(a);
  const bEntries = await drain(b);

  const tag = (e) => `${e.stream}:${e.text}`;
  const aTags = aEntries.map(tag);
  const bTags = bEntries.map(tag);

  // Agent A sees its own stdout AND stderr, correctly separated...
  assert.ok(aTags.includes('stdout:A-OUT'), `A stdout missing: ${JSON.stringify(aTags)}`);
  assert.ok(aTags.includes('stderr:A-ERR'), `A stderr missing: ${JSON.stringify(aTags)}`);
  // ...and never B's output (streams are not mixed).
  assert.ok(!aEntries.some((e) => e.text.includes('B-OUT')), 'A leaked B output');
  assert.ok(bTags.includes('stdout:B-OUT'), `B stdout missing: ${JSON.stringify(bTags)}`);
  assert.ok(!bEntries.some((e) => e.text.includes('A-OUT') || e.text.includes('A-ERR')), 'B leaked A output');

  // Lifecycle reaches a clean exit.
  assert.equal(a.status, 'exited');
  assert.equal(a.exitCode, 0);
  assert.equal(b.exitCode, 0);

  // Log formatting is attributed and tagged.
  const aOut = aEntries.find((e) => e.text === 'A-OUT');
  assert.equal(formatLogEntry(aOut, { withTimestamp: false }), `[${a.id}] stdout: A-OUT`);
  assert.match(aOut.timestamp, /^\d{4}-\d{2}-\d{2}T/);

  // stdin injection: `cat` echoes what we write, then exits at end-of-input.
  const c = await orch.spawn({ ...base, command: ['cat'] });
  await c.write('hello-stdin\n');
  c.endInput();
  await c.wait();
  const cEntries = await drain(c);
  assert.ok(cEntries.some((e) => e.stream === 'stdout' && e.text === 'hello-stdin'), `cat did not echo stdin: ${JSON.stringify(cEntries.map(tag))}`);
  assert.equal(c.exitCode, 0);
});
