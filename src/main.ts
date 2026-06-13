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
import { OrchestratorEngine, createApp } from './server/index.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const connectionString = process.env.DATABASE_URL ?? process.env.AETHERMUX_TEST_DATABASE_URL;

  const store = await SessionStore.connect({ connectionString });
  const engine = new OrchestratorEngine({
    store,
    provisioner: new SandboxProvisioner(),
    spawner: new Orchestrator(),
  });

  const recovery = await engine.recover();
  console.log(
    `[aethermux] recovery: ${recovery.reconnected.length} reconnected, ${recovery.orphaned.length} orphaned`,
  );
  engine.start();

  const server = createServer(createApp(engine));
  server.listen(port, () => console.log(`[aethermux] orchestrator listening on :${port}`));

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[aethermux] ${signal} received, shutting down gracefully`);
    server.close();
    void engine.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[aethermux] fatal:', err);
  process.exit(1);
});
