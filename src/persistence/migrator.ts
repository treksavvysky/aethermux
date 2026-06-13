import type { Pool } from 'pg';

import { MIGRATIONS } from './schema.js';
import { PersistenceError } from './types.js';

/**
 * Applies any unapplied migrations in order, recording each in
 * `schema_migrations`. Idempotent: already-applied migrations are skipped, so
 * this is safe to run on every orchestrator startup.
 */
export async function runMigrations(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id          TEXT PRIMARY KEY,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    for (const migration of MIGRATIONS) {
      const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
      if (existing.rowCount && existing.rowCount > 0) continue;
      await pool.query(migration.sql);
      await pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      applied.push(migration.id);
    }
  } catch (err) {
    throw new PersistenceError('Migration failed', err);
  }
  return applied;
}
