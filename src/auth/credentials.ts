import type { Request } from 'express';

/**
 * The only module that knows where authentication comes from.
 *
 * Today: the user's wger API key is the first path segment of the connector
 * URL (`/<key>/mcp`). Swapping to OAuth later means changing this module and
 * the route declared in app.ts, nothing else: the rest of the code only sees
 * an opaque `WgerCredentials`.
 */

/** Opaque credentials, ready to be sent to wger. */
export interface WgerCredentials {
  /** Value of the HTTP Authorization header expected by wger. */
  readonly authorization: string;
}

/** Route path holding the credentials. */
export const MCP_ROUTE = '/:apiKey/mcp';

/** wger API keys are DRF tokens: 40 hexadecimal characters. */
const API_KEY_PATTERN = /^[0-9a-f]{40}$/i;

export function isValidApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_PATTERN.test(value);
}

export function credentialsFromApiKey(apiKey: string): WgerCredentials {
  if (!isValidApiKey(apiKey)) throw new Error('invalid wger API key format');
  return { authorization: `Token ${apiKey}` };
}

/** Credentials of an incoming MCP request, or null when absent or malformed. */
export function credentialsFromRequest(req: Request): WgerCredentials | null {
  const apiKey = req.params['apiKey'];
  return isValidApiKey(apiKey) ? credentialsFromApiKey(apiKey) : null;
}
