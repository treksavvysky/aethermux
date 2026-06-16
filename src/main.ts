/**
 * AetherMux orchestrator entry point.
 *
 * Boots the single-process orchestrator: connects the session store (running
 * migrations), wires the sandbox provisioner and agent spawner into the engine,
 * recovers any paused sessions from a previous run, starts the flush loop, and
 * serves the HTTP API. SIGINT/SIGTERM trigger a graceful, recoverable shutdown.
 */
import { createServer } from 'node:http';

import { SandboxProvisioner } from './sandbox/index.js';
import { Orchestrator } from './orchestrator/index.js';
import { SessionStore } from './persistence/index.js';
import { OrchestratorEngine, OrchestratorSocket, createApp } from './server/index.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const connectionString = process.env.DATABASE_URL ?? process.env.AETHERMUX_TEST_DATABASE_URL;
  const token = process.env.AETHERMUX_API_TOKEN;

  // Build sandbox config only from env vars that are set, so unset vars keep
  // the provisioner's defaults rather than overriding them with undefined.
  const sandboxConfig: { workspaceRoot?: string; image?: string } = {};
  if (process.env.AETHERMUX_WORKSPACE_ROOT) sandboxConfig.workspaceRoot = process.env.AETHERMUX_WORKSPACE_ROOT;
  if (process.env.AETHERMUX_SANDBOX_IMAGE) sandboxConfig.image = process.env.AETHERMUX_SANDBOX_IMAGE;

  const store = await SessionStore.connect({ connectionString });
  const engine = new OrchestratorEngine({
    store,
    provisioner: new SandboxProvisioner(sandboxConfig),
    spawner: new Orchestrator(),
  });

  const recovery = await engine.recover();
  console.log(
    `[aethermux] recovery: ${recovery.reconnected.length} reconnected, ${recovery.orphaned.length} orphaned`,
  );
  engine.start();

  const server = createServer(createApp(engine, { token }));
  const socket = new OrchestratorSocket(engine, server, { token });
  server.listen(port, () => {
    console.log(`[aethermux] orchestrator listening on :${port} (HTTP + WebSocket /ws)`);
    console.log(`[aethermux] API auth: ${token ? 'token required' : 'OPEN (set AETHERMUX_API_TOKEN to secure)'}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[aethermux] ${signal} received, shutting down gracefully`);
    server.close();
    void socket
      .close()
      .then(() => engine.shutdown())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[aethermux] fatal:', err);
  process.exit(1);
});
