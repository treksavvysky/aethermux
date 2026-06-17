import { promises as fs } from 'node:fs';
import path from 'node:path';

import Docker from 'dockerode';

import {
  DEFAULT_SANDBOX_CONFIG,
  SandboxError,
  assertValidSessionID,
  type SandboxConfig,
  type SandboxHandle,
} from './types.js';

/** Label key marking a container as managed by AetherMux. */
const managedLabelKey = (ns: string): string => `${ns}.managed`;
/** Label key recording the owning session id. */
const sessionLabelKey = (ns: string): string => `${ns}.session`;

/**
 * Builds the Docker container-create options for a sandbox. Pure and
 * deterministic — no Docker calls, no I/O — so it can be unit-tested directly.
 */
export function buildContainerCreateOptions(
  config: SandboxConfig,
  sessionID: string,
  workspacePath: string,
): Docker.ContainerCreateOptions {
  return {
    name: `aethermux-${sessionID}`,
    Image: config.image,
    // Keep the sandbox alive with no work of its own; agents are exec'd in later.
    Cmd: ['tail', '-f', '/dev/null'],
    WorkingDir: config.containerWorkdir,
    Tty: false,
    Labels: {
      [managedLabelKey(config.labelNamespace)]: 'true',
      [sessionLabelKey(config.labelNamespace)]: sessionID,
    },
    HostConfig: {
      Binds: [`${workspacePath}:${config.containerWorkdir}`],
      NetworkMode: config.networkMode,
      Memory: config.memoryBytes,
      // Docker expresses CPU limits in billionths of a core.
      NanoCpus: Math.round(config.cpus * 1e9),
      AutoRemove: false,
    },
  };
}

/**
 * Provisions and tears down isolated Docker sandboxes — one per repo/task
 * session. Each sandbox is a container with a deterministic, bind-mounted host
 * workspace, configurable resource limits, and standard bridge networking. No
 * privileged features are used.
 *
 * The workspace directory is the only durable state: {@link destroy} removes
 * the container and its anonymous volumes but deliberately leaves the host
 * workspace intact so sessions survive a sandbox's lifecycle.
 */
export class SandboxProvisioner {
  readonly config: SandboxConfig;
  private readonly docker: Docker;

  constructor(config: Partial<SandboxConfig> = {}, docker?: Docker) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.docker = docker ?? new Docker();
  }

  /** Deterministic absolute host workspace path for a session. */
  resolveWorkspacePath(sessionID: string): string {
    assertValidSessionID(sessionID);
    return path.resolve(this.config.workspaceRoot, sessionID);
  }

  /**
   * Provisions a sandbox for `sessionID`. Creates the host workspace directory
   * (seeding it from `repoPath` when provided), ensures the base image is
   * present, then creates and starts the container.
   *
   * If anything fails after the container is created, the half-built container
   * is force-removed before the error propagates, so no orphan is left behind.
   */
  async create(repoPath: string | null, sessionID: string): Promise<SandboxHandle> {
    assertValidSessionID(sessionID);
    const workspacePath = this.resolveWorkspacePath(sessionID);

    await fs.mkdir(workspacePath, { recursive: true });
    if (repoPath) {
      await this.seedWorkspace(repoPath, workspacePath);
    }

    await this.ensureImage(this.config.image);

    const options = buildContainerCreateOptions(this.config, sessionID, workspacePath);

    let container: Docker.Container | undefined;
    try {
      container = await this.docker.createContainer(options);
      await container.start();
    } catch (err) {
      if (container) {
        // Graceful cleanup: never leave an orphaned container behind.
        await container.remove({ force: true, v: true }).catch(() => undefined);
      }
      throw new SandboxError(`Failed to provision sandbox for session ${sessionID}`, err);
    }

    return { containerID: container.id, workspacePath, sessionID };
  }

  /**
   * Destroys a sandbox container and its anonymous volumes. The host workspace
   * directory is intentionally preserved (sessions survive infrastructure).
   */
  async destroy(containerID: string): Promise<void> {
    try {
      await this.docker.getContainer(containerID).remove({ force: true, v: true });
    } catch (err) {
      if (isNotFound(err)) {
        // Already gone — destroy is idempotent.
        return;
      }
      throw new SandboxError(`Failed to destroy sandbox ${containerID}`, err);
    }
  }

  /**
   * Gracefully stops a sandbox container: Docker sends SIGTERM to its main
   * process, then SIGKILL after `timeoutSeconds` (default 10). Idempotent — a
   * missing (404) or already-stopped (304) container is a no-op.
   */
  async stop(containerID: string, opts: { timeoutSeconds?: number } = {}): Promise<void> {
    try {
      await this.docker.getContainer(containerID).stop({ t: opts.timeoutSeconds ?? 10 });
    } catch (err) {
      if (isNotFound(err) || isNotModified(err)) {
        return;
      }
      throw new SandboxError(`Failed to stop sandbox ${containerID}`, err);
    }
  }

  /** Returns true if the container exists and is currently running. */
  async isRunning(containerID: string): Promise<boolean> {
    try {
      const info = await this.docker.getContainer(containerID).inspect();
      return info.State?.Running === true;
    } catch (err) {
      if (isNotFound(err)) {
        return false;
      }
      throw new SandboxError(`Failed to inspect sandbox ${containerID}`, err);
    }
  }

  /** Lists all AetherMux-managed containers (running or stopped). */
  async list(): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`${managedLabelKey(this.config.labelNamespace)}=true`] },
    });
  }

  /** Copies the contents of `repoPath` into the workspace directory. */
  private async seedWorkspace(repoPath: string, workspacePath: string): Promise<void> {
    try {
      const stat = await fs.stat(repoPath);
      if (!stat.isDirectory()) {
        throw new SandboxError(`repoPath ${repoPath} is not a directory`);
      }
    } catch (err) {
      if (err instanceof SandboxError) throw err;
      throw new SandboxError(`repoPath ${repoPath} is not accessible`, err);
    }
    await fs.cp(repoPath, workspacePath, { recursive: true });
  }

  /**
   * Ensures `image` is available locally, pulling it if necessary. Idempotent.
   */
  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (err) {
      if (!isNotFound(err)) {
        throw new SandboxError(`Failed to inspect image ${image}`, err);
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, {}, (pullErr: Error | null, stream: NodeJS.ReadableStream | undefined) => {
        if (pullErr || !stream) {
          reject(new SandboxError(`Failed to pull image ${image}`, pullErr));
          return;
        }
        this.docker.modem.followProgress(stream, (progressErr: Error | null) => {
          if (progressErr) {
            reject(new SandboxError(`Failed to pull image ${image}`, progressErr));
          } else {
            resolve();
          }
        });
      });
    });
  }
}

/** True if a Docker error represents a 404 (no such container/image). */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 404;
}

/** True if a Docker error represents a 304 (container already stopped). */
function isNotModified(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { statusCode?: number }).statusCode === 304;
}
