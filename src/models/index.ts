/**
 * Domain models — session and workspace state (PostgreSQL-backed).
 *
 * Stores only ephemeral coordination state: session-to-workspace mappings,
 * platform routes, and attention states. Anything reconstructable from Git plus
 * a fresh container does not belong here.
 *
 * Intentionally empty: this commit establishes structure only.
 */

export {};
