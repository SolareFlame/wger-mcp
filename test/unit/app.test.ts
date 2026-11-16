import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';

const KEY = '0123456789abcdef0123456789abcdef01234567';

/** Minimal in-memory wger answering the endpoints used by the tools under test. */
class FakeWger {
  requests: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  failOn: string | null = null;
  #nextId = 1;

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const path = url.pathname.replace('/api/v2/', '');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const auth = (init.headers as Record<string, string>)['Authorization'] ?? null;
    this.requests.push({ method, path, body, auth });
    const reply = (data: unknown, status = 200) =>
      new Response(data === null ? null : JSON.stringify(data), { status });

    if (this.failOn === `${method} ${path}`) return reply({ exercise: ['Invalid pk'] }, 400);
    if (method === 'DELETE') return reply(null, 204);
    if (method === 'POST' && path === 'workoutlog/') {
      return reply(
        {
          id: `00000000-0000-7000-8000-00000000000${this.#nextId++}`,
          date: body.date ?? '2026-11-16T10:00:00+01:00',
          session: '00000000-0000-7000-8000-0000000000aa',
          routine: body.routine ?? null,
          exercise: body.exercise,
          repetitions_unit: body.repetitions_unit,
          repetitions: body.repetitions.toFixed(2),
          weight_unit: body.weight_unit,
          weight: body.weight.toFixed(2),
          rir: body.rir === undefined ? null : body.rir.toFixed(1),
          notes: null,
        },
        201,
      );
    }
    if (method === 'POST') return reply({ id: this.#nextId++ }, 201);
    if (path === 'language/') return reply({ count: 1, results: [{ id: 2, short_name: 'en' }] });
    return reply({ count: 0, results: [] });
  }) as typeof globalThis.fetch;
}

describe('HTTP app', () => {
  const wger = new FakeWger();
  const logs: string[] = [];
  let server: Server;
  let base: string;

  before(async () => {
    const app = createApp({
      config: { wgerBaseUrl: 'http://wger.test', wgerTimeoutMs: 1000, defaultLanguage: 'en' },
      fetch: wger.fetch,
      log: (line) => logs.push(line),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    wger.requests = [];
    wger.failOn = null;
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/${KEY}/mcp`)));
    return client;
  }

  it('answers 404 for a malformed key, an unknown path, and GET with a bad key', async () => {
    for (const [method, path] of [
      ['POST', '/not-a-key/mcp'],
      ['POST', `/${KEY.slice(1)}/mcp`],
      ['POST', '/mcp'],
      ['GET', '/nope'],
      ['GET', '/bad/mcp'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method, body: method === 'POST' ? '{}' : null });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });

  it('answers 405 to GET/DELETE with a valid key (stateless, no SSE)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/${KEY}/mcp`, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
    }
  });

  it('serves the health check', async () => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });

  it('lists the tools', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'compute_loads',
      'create_routine',
      'get_e1rm',
      'get_history',
      'get_routine',
      'list_routines',
      'log_sets',
      'search_exercises',
    ]);
    await client.close();
  });

  it('log_sets posts verified wger fields with the user key, one set at a time', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'log_sets',
      arguments: { exercise_id: 615, date: '2026-11-15', sets: [{ reps: 5, weight: 100.004, rir: 2 }, { reps: 3, weight: 107.5 }] },
    });
    assert.equal(result.isError, undefined);
    const posts = wger.requests.filter((r) => r.method === 'POST');
    assert.deepEqual(posts.map((r) => r.body), [
      { exercise: 615, repetitions: 5, repetitions_unit: 1, weight: 100, weight_unit: 1, rir: 2, date: '2026-11-15' },
      { exercise: 615, repetitions: 3, repetitions_unit: 1, weight: 107.5, weight_unit: 1, date: '2026-11-15' },
    ]);
    assert.ok(posts.every((r) => r.auth === `Token ${KEY}`));
    const payload = JSON.parse((result.content as { text: string }[])[0]?.text ?? '');
    assert.equal(payload.logged, 2);
    assert.equal(payload.sets[0].e1rm_kg, 123.3);
    await client.close();
  });

  it('create_routine rolls back when a step fails', async () => {
    wger.failOn = 'POST slot-entry/';
    const client = await connect();
    const result = await client.callTool({
      name: 'create_routine',
      arguments: {
        name: 'Test',
        start: '2026-11-16',
        end: '2026-12-31',
        days: [{ name: 'A', exercises: [{ exercise_id: 615, sets: 3, reps: 5 }] }],
      },
    });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0]?.text ?? '', /partially created routine was deleted/);
    const routinePost = wger.requests.find((r) => r.path === 'routine/');
    assert.deepEqual(routinePost?.body, {
      name: 'Test',
      description: '',
      start: '2026-11-16',
      end: '2026-12-31',
      fit_in_week: true,
    });
    assert.ok(wger.requests.some((r) => r.method === 'DELETE' && /^routine\/\d+\/$/.test(r.path)));
    await client.close();
  });

  it('create_routine validates before calling wger', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'create_routine',
      arguments: { name: 'Test', start: '2026-12-31', end: '2026-11-16', days: [{ name: 'A', rest: true }] },
    });
    assert.equal(result.isError, true);
    assert.equal(wger.requests.length, 0);
    await client.close();
  });

  it('never logs the key', () => {
    assert.ok(logs.length > 0);
    assert.ok(logs.every((line) => !line.includes(KEY)), logs.join('\n'));
    assert.ok(logs.some((line) => line.startsWith('POST /:apiKey/mcp 200')));
  });
});
