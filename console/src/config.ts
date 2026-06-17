import { WS_PATH } from './protocol';

/** Resolved runtime configuration for the console. */
export interface ConsoleConfig {
  /** HTTP origin of the orchestrator API. */
  baseUrl: string;
  /** WebSocket URL for the multiplexed transport (includes the token). */
  wsUrl: string;
  /** Shared API token (fail-closed auth). */
  token: string;
}

/**
 * Reads config from the page URL. `?api=` overrides the orchestrator origin
 * (defaults to the page origin); `?token=` supplies the fail-closed API token.
 * Pure — pass a fake location to unit-test.
 */
export function readConfig(loc: { origin: string; search: string }): ConsoleConfig {
  const params = new URLSearchParams(loc.search);
  const baseUrl = (params.get('api') ?? loc.origin).replace(/\/$/, '');
  const token = params.get('token') ?? '';
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return { baseUrl, token, wsUrl: `${wsBase}${WS_PATH}${query}` };
}
