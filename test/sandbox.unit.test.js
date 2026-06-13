import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import {
  SandboxProvisioner,
  buildContainerCreateOptions,
  DEFAULT_SANDBOX_CONFIG,
  SandboxError,
  assertValidSessionID,
} from '../dist/index.js';

test('config defaults: partial overrides merge over sane defaults', () => {
  const p = new SandboxProvisioner({ cpus: 4 });
  assert.equal(p.config.cpus, 4);
  assert.equal(p.config.image, DEFAULT_SANDBOX_CONFIG.image);
  assert.equal(p.config.memoryBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(p.config.networkMode, 'bridge');
});

test('resolveWorkspacePath is deterministic and rooted under workspaceRoot', () => {
  const root = path.join(os.tmpdir(), 'aethermux-unit');
  const p = new SandboxProvisioner({ workspaceRoot: root });
  const a = p.resolveWorkspacePath('sess-1');
  const b = p.resolveWorkspacePath('sess-1');
  assert.equal(a, b);
  assert.equal(a, path.join(root, 'sess-1'));
  assert.ok(path.isAbsolute(a));
});

test('assertValidSessionID rejects unsafe ids (traversal, separators, empty)', () => {
  for (const bad of ['', '..', '../escape', 'a/b', 'has space', '-leading', '.hidden']) {
    assert.throws(() => assertValidSessionID(bad), SandboxError, `expected reject: ${bad}`);
  }
  for (const ok of ['sess1', 'repo.task-1', 'A_B.c-9']) {
    assert.doesNotThrow(() => assertValidSessionID(ok), `expected accept: ${ok}`);
  }
});

test('buildContainerCreateOptions maps config to Docker options (isolation + limits)', () => {
  const config = { ...DEFAULT_SANDBOX_CONFIG, cpus: 2, memoryBytes: 2 * 1024 ** 3, networkMode: 'bridge' };
  const opts = buildContainerCreateOptions(config, 'sess-9', '/host/ws/sess-9');

  assert.equal(opts.name, 'aethermux-sess-9');
  assert.equal(opts.Image, 'alpine:3.20');
  assert.deepEqual(opts.HostConfig.Binds, ['/host/ws/sess-9:/workspace']);
  assert.equal(opts.HostConfig.NetworkMode, 'bridge');
  assert.equal(opts.HostConfig.Memory, 2 * 1024 ** 3);
  assert.equal(opts.HostConfig.NanoCpus, 2_000_000_000);
  assert.equal(opts.HostConfig.AutoRemove, false);
  assert.equal(opts.Labels['aethermux.managed'], 'true');
  assert.equal(opts.Labels['aethermux.session'], 'sess-9');
});

// Graceful-cleanup contract: if container.start() fails, the half-built
// container must be force-removed so no orphan is left behind. Uses a fake
// Docker so no real daemon is required.
test('create() force-removes the container when start fails (no orphans)', async () => {
  const calls = { created: 0, started: 0, removed: 0 };

  const fakeContainer = {
    id: 'fake-container-id',
    start: async () => {
      calls.started += 1;
      throw new Error('simulated start failure');
    },
    remove: async (opts) => {
      calls.removed += 1;
      assert.equal(opts.force, true);
      assert.equal(opts.v, true);
    },
  };

  const fakeDocker = {
    getImage: () => ({ inspect: async () => ({}) }), // image already present
    createContainer: async () => {
      calls.created += 1;
      return fakeContainer;
    },
  };

  const root = path.join(os.tmpdir(), 'aethermux-unit-cleanup');
  const p = new SandboxProvisioner({ workspaceRoot: root }, fakeDocker);

  await assert.rejects(() => p.create(null, 'cleanup-sess'), SandboxError);
  assert.equal(calls.created, 1, 'container should have been created');
  assert.equal(calls.started, 1, 'start should have been attempted');
  assert.equal(calls.removed, 1, 'failed container must be force-removed');
});

test('destroy() is idempotent when the container is already gone (404)', async () => {
  const fakeDocker = {
    getContainer: () => ({
      remove: async () => {
        const err = new Error('no such container');
        err.statusCode = 404;
        throw err;
      },
    }),
  };
  const p = new SandboxProvisioner({}, fakeDocker);
  await assert.doesNotReject(() => p.destroy('missing-id'));
});
