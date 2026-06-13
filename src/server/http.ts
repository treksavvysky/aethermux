import express, { type Express, type Request, type Response, type NextFunction } from 'express';

import type { OrchestratorEngine } from './engine.js';
import { OPENAPI_SPEC } from './openapi.js';

/** Wraps an async handler so rejections become a 500 instead of crashing. */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

/**
 * Builds the orchestrator's Express app over an {@link OrchestratorEngine}.
 * The caller owns `listen()` / lifecycle so the same app is testable on an
 * ephemeral port.
 */
export function createApp(engine: OrchestratorEngine): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(OPENAPI_SPEC);
  });

  app.post(
    '/sessions',
    asyncHandler(async (req, res) => {
      const body: unknown = req.body;
      const { repoPath, command, env } = (body ?? {}) as {
        repoPath?: unknown;
        command?: unknown;
        env?: unknown;
      };
      if (!isStringArray(command)) {
        res.status(400).json({ error: 'command must be a non-empty array of strings' });
        return;
      }
      if (repoPath !== undefined && repoPath !== null && typeof repoPath !== 'string') {
        res.status(400).json({ error: 'repoPath must be a string or null' });
        return;
      }
      if (env !== undefined && (typeof env !== 'object' || env === null)) {
        res.status(400).json({ error: 'env must be an object' });
        return;
      }
      const result = await engine.createSession({
        repoPath: (repoPath as string | null | undefined) ?? null,
        command,
        env: env as Record<string, string> | undefined,
      });
      res.status(201).json(result);
    }),
  );

  app.get(
    '/sessions',
    asyncHandler(async (_req, res) => {
      const sessions = await engine.listActiveSessions();
      res.json({ sessions });
    }),
  );

  app.get(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const graph = await engine.getSession(req.params.id);
      if (!graph) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      res.json(graph);
    }),
  );

  app.delete(
    '/sessions/:id',
    asyncHandler(async (req, res) => {
      const destroyed = await engine.destroySession(req.params.id);
      if (!destroyed) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      res.json({ destroyed: true });
    }),
  );

  return app;
}
