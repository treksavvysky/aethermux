import type { Pool } from 'pg';

import { MIGRATIONS } from './schema.js';
import { PersistenceError } from './types.js';

/** Stable key for the migration advisory lock (any fixed bigint). */
const MIGRATION_LOCK_KEY = 472_839;

/**
 * Applies any unapplied migrations in order, recording each in
 * `schema_migrations`. Idempotent: already-applied migrations are skipped, so
 * this is safe to run on every orchestrator startup.
 *
 * Migrations run under a PostgreSQL advisory lock held on a single pooled
 * connection, so concurrent startups (parallel tests, multiple orchestrator
 * instances) are serialised and never race on DDL — the first runs the
 * migrations, the rest wait and then see them already applied.
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           id          TEXT PRIMARY KEY,
           applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );

      for (const migration of MIGRATIONS) {
        const existing = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
        if (existing.rowCount && existing.rowCount > 0) continue;
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
          migration.id,
        ]);
        applied.push(migration.id);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  } catch (err) {
    throw new PersistenceError('Migration failed', err);
  } finally {
    client.release();
  }
  return applied;
}
