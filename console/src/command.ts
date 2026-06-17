/**
 * Splits a command line into argv, honouring single and double quotes (so e.g.
 * `sh -c "echo hi"` → ['sh','-c','echo hi']). Minimal — no escapes or env
 * expansion; the orchestrator runs argv directly (no shell) unless the user
 * types one.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/**
 * Parses `KEY=value` lines into an env object, ignoring blanks. Returns
 * undefined when empty so the request omits `env`.
 */
export function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return Object.keys(env).length ? env : undefined;
}
