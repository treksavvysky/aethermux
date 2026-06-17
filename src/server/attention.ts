import type { AttentionState } from './api-types.js';

/**
 * Default stdout prompt patterns that signal an agent is **awaiting input**.
 * Matched against newline-terminated stdout lines (the orchestrator's stream is
 * line-buffered). Includes generic question/continuation prompts plus the
 * confirmation phrasings used by common CLI agents (Claude Code, Aider). The
 * console renders the ring purely from the resulting state — no per-agent code.
 *
 * Detection is a **real signal** (the agent actually printed a prompt), never a
 * timeout/heuristic. Known limitation: a prompt printed without a trailing
 * newline stays in the line buffer and is not matched until a newline arrives —
 * a PTY-based enhancement is deferred to a later phase.
 */
export const DEFAULT_PROMPT_PATTERNS: readonly RegExp[] = [
  /\?\s*$/, // "...?" question prompt
  />\s*$/, // "> " prompt
  /\(y\/n\)\s*$/i, // (y/n)
  /\[y\/n\]\s*$/i, // [y/N]
  /press enter/i, // "press enter to continue"
  /do you want to (proceed|continue)/i, // Claude Code / Aider confirmations
  /allow this/i,
];

/**
 * The authoritative per-agent attention state machine. States:
 * `running` → `awaiting-input` (real prompt detected) → `running` (stdin given),
 * and from any non-terminal state to the terminal `exited` (exit code 0) or
 * `error` (non-zero exit, or a stream/spawn error).
 *
 * **No false greens:** `exited` (green) is reachable *only* via {@link onExit}
 * with exit code 0 — never inferred from output, prompts, or timeouts.
 */
export class AgentStateMachine {
  private _state: AttentionState = 'running';
  private readonly patterns: readonly RegExp[];

  constructor(patterns: readonly RegExp[] = DEFAULT_PROMPT_PATTERNS) {
    this.patterns = patterns;
  }

  get state(): AttentionState {
    return this._state;
  }

  /** True if a line looks like an input prompt. */
  matchesPrompt(line: string): boolean {
    return this.patterns.some((p) => p.test(line));
  }

  /**
   * Feed one captured output line. Enters `awaiting-input` if (and only if) a
   * `running` agent prints a recognised stdout prompt. Returns true on change.
   */
  onOutput(stream: 'stdout' | 'stderr', line: string): boolean {
    if (this._state !== 'running') return false; // terminal/awaiting unaffected
    if (stream === 'stdout' && this.matchesPrompt(line)) return this.transition('awaiting-input');
    return false;
  }

  /** Stdin was injected (the operator answered) — resume `running`. */
  onStdin(): boolean {
    if (this._state === 'awaiting-input') return this.transition('running');
    return false;
  }

  /**
   * The agent process actually exited. Green (`exited`) only on code 0; any
   * non-zero exit or error status is `error`. This is the single source of the
   * terminal states.
   */
  onExit(status: 'exited' | 'error', exitCode: number | null): boolean {
    if (status === 'error') return this.transition('error');
    return this.transition(exitCode === 0 ? 'exited' : 'error');
  }

  private transition(next: AttentionState): boolean {
    if (this._state === next) return false;
    this._state = next;
    return true;
  }
}
