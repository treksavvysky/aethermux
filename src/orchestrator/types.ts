/**
 * The generic, agent-agnostic spawn contract and its supporting types.
 *
 * Every CLI agent (Aider, Claude Code, Gemini CLI, a bare shell command, …) is
 * started through one {@link SpawnContract}. No agent gets a privileged API —
 * "agnosticism first".
 */

/** The single contract used to start any CLI agent inside a sandbox. */
export interface SpawnContract {
  /** The session this agent belongs to. */
  sessionID: string;
  /** Id of the sandbox container (from the sandbox provisioner) to exec into. */
  containerID: string;
  /** argv to execute; `command[0]` is the executable. Not shell-interpreted. */
  command: string[];
  /** Working directory inside the container (typically the workspace mount). */
  workspaceDir: string;
  /** Environment variables for the agent process. */
  env: Record<string, string>;
}

/** Which standard stream a {@link LogEntry} came from. */
export type StreamKind = 'stdout' | 'stderr';

/** Lifecycle state of an agent process. */
export type AgentStatus = 'running' | 'exited' | 'error';

/** One line of agent output, attributed and timestamped. */
export interface LogEntry {
  /** The agent that produced this line (e.g. `agent-01`). */
  agentId: string;
  /** Originating stream. */
  stream: StreamKind;
  /** ISO-8601 timestamp captured when the line was read. */
  timestamp: string;
  /** Per-agent monotonic sequence number. */
  sequence: number;
  /** The line text, with the trailing newline stripped. */
  text: string;
}

/** Error raised for all spawn/stream failures. */
export class SpawnError extends Error {
  override readonly name = 'SpawnError';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** Formats a monotonic counter into a stable, zero-padded agent id. */
export function formatAgentId(n: number): string {
  return `agent-${String(n).padStart(2, '0')}`;
}

/** Converts an env map into Docker's `KEY=VALUE` array form. */
export function toEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

/**
 * Renders a log entry as a line-oriented string with a metadata prefix, e.g.
 * `2026-06-13T03:00:00.000Z [agent-01] stdout: hello`. Set `withTimestamp:false`
 * for the bare `[agent-01] stdout: hello` form.
 */
export function formatLogEntry(entry: LogEntry, opts: { withTimestamp?: boolean } = {}): string {
  const tag = `[${entry.agentId}] ${entry.stream}: ${entry.text}`;
  return opts.withTimestamp === false ? tag : `${entry.timestamp} ${tag}`;
}

/** Validates a spawn contract, throwing {@link SpawnError} on the first problem. */
export function validateSpawnContract(contract: SpawnContract): void {
  const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (!nonEmpty(contract.sessionID)) {
    throw new SpawnError('SpawnContract.sessionID must be a non-empty string');
  }
  if (!nonEmpty(contract.containerID)) {
    throw new SpawnError('SpawnContract.containerID must be a non-empty string');
  }
  if (!Array.isArray(contract.command) || contract.command.length === 0 || !contract.command.every(nonEmpty)) {
    throw new SpawnError('SpawnContract.command must be a non-empty string[] (argv)');
  }
  if (!nonEmpty(contract.workspaceDir)) {
    throw new SpawnError('SpawnContract.workspaceDir must be a non-empty string');
  }
  if (typeof contract.env !== 'object' || contract.env === null) {
    throw new SpawnError('SpawnContract.env must be an object');
  }
}
