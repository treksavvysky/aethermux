/**
 * Database schema for AetherMux's ephemeral coordination state.
 *
 * The database stores ONLY what cannot be reconstructed from Git plus a fresh
 * container: the session → sandbox → agent graph and its status. No files.
 *
 * Migrations are an ordered list applied by {@link runMigrations}; each is
 * idempotent (CREATE … IF NOT EXISTS) and recorded in `schema_migrations`.
 */

export interface Migration {
  id: string;
  sql: string;
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat  TIMESTAMPTZ NOT NULL DEFAULT now(),
  repo_path       TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS sandboxes (
  container_id    TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_path  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_session ON sandboxes(session_id);

CREATE TABLE IF NOT EXISTS agent_processes (
  agent_id          TEXT PRIMARY KEY,
  sandbox_id        TEXT NOT NULL REFERENCES sandboxes(container_id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  command           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'running',
  process_exit_code INTEGER,
  stdout_buffer     TEXT NOT NULL DEFAULT '',
  stderr_buffer     TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agents_session ON agent_processes(session_id);
CREATE INDEX IF NOT EXISTS idx_agents_sandbox ON agent_processes(sandbox_id);
`;

/** Ordered, idempotent migrations. Append new entries; never edit applied ones. */
export const MIGRATIONS: Migration[] = [{ id: '0001_init', sql: INIT_SQL }];
