/**
 * Sandbox provisioning — the Docker integration layer that creates and tears
 * down isolated, bind-mounted containers for agent execution (AETHERMUX-3).
 */

export {
  SandboxProvisioner,
  buildContainerCreateOptions,
} from './provisioner.js';

export {
  DEFAULT_SANDBOX_CONFIG,
  SandboxError,
  assertValidSessionID,
  type SandboxConfig,
  type SandboxHandle,
} from './types.js';
