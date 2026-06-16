import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Shared API authentication for both the HTTP API and the WebSocket upgrade, so
 * the two use exactly one mechanism (AETHERMUX_API_TOKEN). When no token is
 * configured the API is open (local dev); when a token is set, every request —
 * HTTP or WS — must present it, so there is no open relay.
 */

/**
 * Extracts an API token from a request: the `Authorization` header (`Bearer
 * <token>` or the raw value), the `x-api-token` header, or a `?token=` query
 * parameter. Browsers cannot set headers on a WebSocket handshake, so the query
 * parameter is the WS-friendly carrier for the same token value.
 */
export function extractRequestToken(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.length > 0) {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    return bearer ? bearer[1] : auth;
  }
  const apiToken = req.headers['x-api-token'];
  if (typeof apiToken === 'string' && apiToken.length > 0) return apiToken;
  if (req.url) {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    if (token) return token;
  }
  return undefined;
}

/**
 * True if the request is authorized. With no configured token the API is open;
 * otherwise the request must present the exact token (constant-time compared).
 */
export function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const provided = extractRequestToken(req);
  return provided !== undefined && constantTimeEqual(provided, token);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
