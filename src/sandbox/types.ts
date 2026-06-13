import os from 'node:os';
import path from 'node:path';

/**
 * Configuration for the sandbox provisioner. Every field has a sane default
 * (see {@link DEFAULT_SANDBOX_CONFIG}); callers override only what they need.
 */
export interface SandboxConfig {
  /** Base image for sandboxes. Minimal by design (Alpine). */
  image: string;
  /** Host directory under which per-session workspace dirs are created. */
  workspaceRoot: string;
  /** Mount point for the workspace inside the container. */
  containerWorkdir: string;
  /** CPU limit, in whole/fractional cores (mapped to Docker NanoCpus). */
  cpus: number;
  /** Memory limit in bytes (mapped to Docker HostConfig.Memory). */
  memoryBytes: number;
  /** Docker network mode. Standard bridge networking for Phase 1. */
  networkMode: string;
  /** Label namespace used to tag and later discover managed containers. */
  labelNamespace: string;
}

/** Sane defaults: a minimal Alpine sandbox with 2 CPU / 2 GiB on bridge net. */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  image: 'alpine:3.20',
  workspaceRoot: path.join(os.tmpdir(), 'aethermux', 'workspaces'),
  containerWorkdir: '/workspace',
  cpus: 2,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  networkMode: 'bridge',
  labelNamespace: 'aethermux',
};

/** Handle returned by {@link SandboxProvisioner.create}. */
export interface SandboxHandle {
  /** Docker container id of the running sandbox. */
  containerID: string;
  /** Absolute host path of the bind-mounted workspace directory. */
  workspacePath: string;
  /** The session this sandbox belongs to. */
  sessionID: string;
}

/** Error raised for all sandbox provisioning failures. */
export class SandboxError extends Error {
  override readonly name = 'SandboxError';
  /** The underlying error, when this wraps a lower-level failure. */
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/**
 * Session ids become container names and the trailing path segment of a host
 * workspace directory, so they must be filesystem- and Docker-name-safe. We
 * reject anything outside this set rather than silently rewriting it (a rewrite
 * could collapse two distinct sessions onto one workspace).
 */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;

/** Throws {@link SandboxError} if `sessionID` is not safe to use. */
export function assertValidSessionID(sessionID: string): void {
  if (!SESSION_ID_PATTERN.test(sessionID)) {
    throw new SandboxError(
      `Invalid sessionID ${JSON.stringify(sessionID)}: must match ${SESSION_ID_PATTERN}`,
    );
  }
}
