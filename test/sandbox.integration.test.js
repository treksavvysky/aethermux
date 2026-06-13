import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Docker from 'dockerode';
import { SandboxProvisioner } from '../dist/index.js';

/**
 * These tests exercise a real Docker daemon. When no daemon is reachable
 * (e.g. a constrained CI sandbox) they skip rather than fail, so the suite is
 * green everywhere while still providing real coverage wherever Docker exists.
 */
async function dockerReachable() {
  try {
    await new Docker().ping();
    return true;
  } catch {
    return false;
  }
}

/** Runs a command in the container and returns its combined output + exit code. */
async function execCapture(container, cmd) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: true });
  const stream = await exec.start({ Tty: true });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const info = await exec.inspect();
  return { out: Buffer.concat(chunks).toString('utf8'), exitCode: info.ExitCode };
}

const hasDocker = await dockerReachable();

test('sandbox lifecycle: provision → running → bind mount → destroy → gone', { skip: hasDocker ? false : 'Docker daemon not reachable' }, async (t) => {
  const sessionID = `it${process.pid}x${Date.now().toString(36)}`;
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aethermux-it-'));
  const docker = new Docker();
  const provisioner = new SandboxProvisioner(
    { workspaceRoot, cpus: 1, memoryBytes: 512 * 1024 * 1024 },
    docker,
  );

  let handle;
  t.after(async () => {
    if (handle) await provisioner.destroy(handle.containerID).catch(() => {});
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  });

  // Provision.
  handle = await provisioner.create(null, sessionID);
  assert.ok(handle.containerID, 'container id returned');
  assert.equal(handle.workspacePath, path.join(workspaceRoot, sessionID));

  // Verify running + configured isolation/limits applied.
  assert.equal(await provisioner.isRunning(handle.containerID), true, 'container should be running');
  const inspected = await docker.getContainer(handle.containerID).inspect();
  assert.equal(inspected.HostConfig.Memory, 512 * 1024 * 1024, 'memory limit applied');
  assert.equal(inspected.HostConfig.NanoCpus, 1_000_000_000, 'cpu limit applied');
  assert.equal(inspected.HostConfig.NetworkMode, 'bridge', 'bridge networking');
  assert.equal(inspected.HostConfig.Privileged, false, 'not privileged');

  // Bind-mount proof: a file written from inside the container appears on the host.
  const container = docker.getContainer(handle.containerID);
  const write = await execCapture(container, ['sh', '-c', 'echo aethermux-bind-ok > /workspace/proof.txt']);
  assert.equal(write.exitCode, 0, 'write inside container succeeded');
  const hostFile = path.join(handle.workspacePath, 'proof.txt');
  assert.equal((await fs.readFile(hostFile, 'utf8')).trim(), 'aethermux-bind-ok', 'host sees container write');

  // Managed container is discoverable via list().
  const listed = await provisioner.list();
  assert.ok(listed.some((c) => c.Id === handle.containerID), 'container appears in list()');

  // Destroy.
  await provisioner.destroy(handle.containerID);
  assert.equal(await provisioner.isRunning(handle.containerID), false, 'container should be gone');
  await assert.rejects(() => docker.getContainer(handle.containerID).inspect(), 'inspect should 404 after destroy');

  // Workspace contents survive the container lifecycle (bind mount, not volume).
  assert.equal((await fs.readFile(hostFile, 'utf8')).trim(), 'aethermux-bind-ok', 'workspace survives destroy');
  handle = undefined; // already destroyed; skip the after-hook destroy
});
