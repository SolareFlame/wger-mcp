import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type ErrorRequestHandler, type RequestHandler, type Response } from 'express';
import { MCP_ROUTE, credentialsFromRequest, type WgerCredentials } from './auth/credentials.ts';
import type { Config } from './config.ts';
import { registerTools } from './tools/index.ts';
import { WgerApi } from './wger/api.ts';
import { WgerClient } from './wger/client.ts';

export const SERVER_NAME = 'wger-mcp';
export const SERVER_VERSION = '0.1.0';

export interface AppOptions {
  config: Omit<Config, 'port'>;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

export function createMcpServer(credentials: WgerCredentials, options: AppOptions): McpServer {
  const client = new WgerClient({
    baseUrl: options.config.wgerBaseUrl,
    timeoutMs: options.config.wgerTimeoutMs,
    credentials,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, new WgerApi(client), {
    defaultLanguage: options.config.defaultLanguage,
    ...(options.now ? { now: options.now } : {}),
  });
  return server;
}

/**
 * Stateless Streamable HTTP: one McpServer + transport per POST, nothing kept
 * between requests. Only POST /<key>/mcp is served; an invalid key is a 404,
 * indistinguishable from an unknown path.
 *
 * Logs never contain the request URL (it holds the key): only the route
 * template, the status and the duration.
 */
export function createApp(options: AppOptions): express.Express {
  const log = options.log ?? ((line: string) => console.log(line));
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      // Route template ("/:apiKey/mcp"), never the actual path.
      const template: unknown = req.route?.path;
      const route = typeof template === 'string' ? template : '<unmatched>';
      log(`${req.method} ${route} ${res.statusCode} ${Math.round(performance.now() - started)}ms`);
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const requireCredentials: RequestHandler = (req, res, next) => {
    const credentials = credentialsFromRequest(req);
    if (!credentials) {
      res.status(404).end();
      return;
    }
    res.locals['credentials'] = credentials;
    next();
  };

  app.post(MCP_ROUTE, requireCredentials, express.json({ limit: '1mb' }), async (req, res) => {
    const credentials = res.locals['credentials'] as WgerCredentials;
    const server = createMcpServer(credentials, options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`mcp request failed: ${error instanceof Error ? error.name : typeof error}`);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  });

  // Stateless server: no SSE stream to open (GET) nor session to close (DELETE).
  app.all(MCP_ROUTE, requireCredentials, (_req, res) => {
    res.setHeader('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed');
  });

  app.use((_req, res) => {
    res.status(404).end();
  });

  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status =
      typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
        ? error.status
        : 500;
    log(`request error: ${error instanceof Error ? error.name : typeof error} (${status})`);
    if (res.headersSent) return;
    if (status >= 400 && status < 500) jsonRpcError(res, status, -32700, 'Invalid request body');
    else jsonRpcError(res, 500, -32603, 'Internal server error');
  };
  app.use(onError);

  return app;
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}
