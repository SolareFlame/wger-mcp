import * as z from 'zod';

export interface Config {
  port: number;
  /** wger root reachable from this server, without /api/v2 (e.g. http://wger-nginx-1). */
  wgerBaseUrl: string;
  wgerTimeoutMs: number;
  defaultLanguage: string;
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8000),
  WGER_BASE_URL: z.url({ protocol: /^https?$/ }),
  WGER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  DEFAULT_LANGUAGE: z.string().regex(/^[a-z]{2}$/).default('en'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return {
    port: parsed.data.PORT,
    wgerBaseUrl: parsed.data.WGER_BASE_URL,
    wgerTimeoutMs: parsed.data.WGER_TIMEOUT_MS,
    defaultLanguage: parsed.data.DEFAULT_LANGUAGE,
  };
}
