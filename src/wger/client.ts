import * as z from 'zod';
import type { WgerCredentials } from '../auth/credentials.ts';

/**
 * Typed HTTP client for the wger REST API (/api/v2/).
 * Knows transport concerns only (auth header, timeout, pagination, errors);
 * resource shapes live in api.ts.
 */

export type WgerErrorKind =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'network'
  | 'unexpected_response';

export class WgerError extends Error {
  readonly kind: WgerErrorKind;
  readonly status: number | null;
  /** Response body (validation errors) when wger sent one. Never contains credentials. */
  readonly details: unknown;

  constructor(kind: WgerErrorKind, message: string, status: number | null = null, details?: unknown) {
    super(message);
    this.name = 'WgerError';
    this.kind = kind;
    this.status = status;
    this.details = details;
  }
}

type QueryScalar = string | number | boolean;
export type Query = Record<string, QueryScalar | readonly QueryScalar[] | null | undefined>;

export interface WgerClientOptions {
  /** Instance root, without /api/v2 (e.g. http://wger-nginx-1). */
  baseUrl: string;
  credentials: WgerCredentials;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export interface Page<T> {
  count: number;
  results: T[];
}

export interface ListAllOptions {
  pageSize?: number;
  /** Hard cap on the number of items fetched, to bound latency and memory. */
  max?: number;
}

const ERROR_BODY_MAX_CHARS = 600;

export class WgerClient {
  readonly #apiRoot: string;
  readonly #authorization: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: WgerClientOptions) {
    this.#apiRoot = `${options.baseUrl.replace(/\/+$/, '')}/api/v2/`;
    this.#authorization = options.credentials.authorization;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get<T>(path: string, schema: z.ZodType<T>, query?: Query): Promise<T> {
    return this.#request('GET', path, schema, { query });
  }

  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.#request('POST', path, schema, { body });
  }

  async delete(path: string): Promise<void> {
    await this.#request('DELETE', path, null, {});
  }

  /** One page of a paginated list endpoint. */
  page<T>(path: string, itemSchema: z.ZodType<T>, query: Query = {}): Promise<Page<T>> {
    const schema = z.object({ count: z.number().int(), results: z.array(itemSchema) });
    return this.get(path, schema, query);
  }

  /**
   * Every item of a paginated list endpoint, walking limit/offset.
   * `next` links are ignored on purpose: wger builds them from the Host
   * header, which differs between the public and the internal URL.
   */
  async listAll<T>(
    path: string,
    itemSchema: z.ZodType<T>,
    query: Query = {},
    { pageSize = 100, max = 1000 }: ListAllOptions = {},
  ): Promise<T[]> {
    const items: T[] = [];
    for (let offset = 0; items.length < max; offset += pageSize) {
      const limit = Math.min(pageSize, max - items.length);
      const page = await this.page(path, itemSchema, { ...query, limit, offset });
      items.push(...page.results);
      if (page.results.length < limit || offset + page.results.length >= page.count) break;
    }
    return items;
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: z.ZodType<T> | null,
    { query, body }: { query?: Query | undefined; body?: unknown },
  ): Promise<T> {
    const url = this.#url(path, query);
    const label = `${method} ${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.#authorization,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new WgerError('timeout', `${label}: wger did not answer within ${this.#timeoutMs} ms`);
      }
      throw new WgerError('network', `${label}: wger is unreachable`);
    }

    const text = await response.text();
    if (!response.ok) throw httpError(label, response.status, text);
    if (schema === null) return undefined as T;

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new WgerError('unexpected_response', `${label}: response is not JSON`, response.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new WgerError(
        'unexpected_response',
        `${label}: response does not match the expected shape (${z.prettifyError(parsed.error)})`,
        response.status,
      );
    }
    return parsed.data;
  }

  #url(path: string, query?: Query): string {
    if (path.startsWith('/') || path.includes('://') || !path.endsWith('/')) {
      // Trailing slash is mandatory: Django redirects otherwise, and redirects are refused.
      throw new Error(`invalid wger path: ${path}`);
    }
    const url = new URL(path, this.#apiRoot);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      // django-filter "__in" lookups take comma separated values.
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url.toString();
  }
}

function httpError(label: string, status: number, body: string): WgerError {
  const details = parseJsonOrText(body);
  const summary = truncate(typeof details === 'string' ? details : JSON.stringify(details));
  const message = `${label}: HTTP ${status}${summary ? ` ${summary}` : ''}`;
  if (status === 401 || status === 403) return new WgerError('auth', message, status, details);
  if (status === 404) return new WgerError('not_found', message, status, details);
  if (status === 429) return new WgerError('rate_limited', message, status, details);
  if (status >= 500) return new WgerError('server', `${label}: HTTP ${status}`, status);
  return new WgerError('validation', message, status, details);
}

function parseJsonOrText(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body.trim();
  }
}

function truncate(value: string): string {
  return value.length > ERROR_BODY_MAX_CHARS ? `${value.slice(0, ERROR_BODY_MAX_CHARS)}…` : value;
}
