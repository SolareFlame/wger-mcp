import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as z from 'zod';
import { WgerClient, WgerError } from '../../src/wger/client.ts';

interface Call {
  url: URL;
  init: RequestInit;
}

function fakeFetch(respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const client = (fetch: typeof globalThis.fetch, timeoutMs = 1000) =>
  new WgerClient({
    baseUrl: 'http://wger.test/',
    credentials: { authorization: 'Token secret' },
    timeoutMs,
    fetch,
  });

const item = z.object({ id: z.number() });

describe('WgerClient', () => {
  it('sends the auth header and builds /api/v2/ URLs with query params', async () => {
    const { fetch, calls } = fakeFetch(() => json({ id: 1 }));
    await client(fetch).get('workoutlog/', item, { exercise: 615, ids: [1, 2], skip: undefined, b: false });
    const [call] = calls;
    assert.ok(call);
    assert.equal(`${call.url.origin}${call.url.pathname}`, 'http://wger.test/api/v2/workoutlog/');
    assert.equal(call.url.searchParams.get('exercise'), '615');
    assert.equal(call.url.searchParams.get('ids'), '1,2');
    assert.equal(call.url.searchParams.get('b'), 'false');
    assert.equal(call.url.searchParams.has('skip'), false);
    assert.equal((call.init.headers as Record<string, string>)['Authorization'], 'Token secret');
  });

  it('refuses paths without trailing slash or absolute URLs', async () => {
    const { fetch } = fakeFetch(() => json({}));
    await assert.rejects(client(fetch).get('workoutlog', item), /invalid wger path/);
    await assert.rejects(client(fetch).get('http://evil/', item), /invalid wger path/);
  });

  it('walks pages with limit/offset until count is reached', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const { fetch, calls } = fakeFetch((url) => {
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      return json({ count: all.length, next: 'http://ignored/', results: all.slice(offset, offset + limit) });
    });
    const items = await client(fetch).listAll('routine/', item, {}, { pageSize: 2 });
    assert.deepEqual(items, all);
    assert.equal(calls.length, 3);
  });

  it('stops at max items', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      json({ count: 1000, results: Array.from({ length: Number(url.searchParams.get('limit')) }, () => ({ id: 1 })) }),
    );
    const items = await client(fetch).listAll('workoutlog/', item, {}, { pageSize: 100, max: 150 });
    assert.equal(items.length, 150);
    assert.deepEqual(
      calls.map((c) => c.url.searchParams.get('limit')),
      ['100', '50'],
    );
  });

  it('maps HTTP errors to typed WgerError', async () => {
    const cases: [number, string][] = [
      [403, 'auth'],
      [401, 'auth'],
      [404, 'not_found'],
      [400, 'validation'],
      [429, 'rate_limited'],
      [502, 'server'],
    ];
    for (const [status, kind] of cases) {
      const { fetch } = fakeFetch(() => json({ detail: 'nope' }, status));
      await assert.rejects(client(fetch).get('routine/', item), (error: unknown) => {
        assert.ok(error instanceof WgerError);
        assert.equal(error.kind, kind);
        assert.equal(error.status, status);
        return true;
      });
    }
  });

  it('keeps validation details from wger', async () => {
    const body = { rir: ['Ensure that there are no more than 1 digits before the decimal point.'] };
    const { fetch } = fakeFetch(() => json(body, 400));
    await assert.rejects(client(fetch).post('workoutlog/', {}, item), (error: unknown) => {
      assert.ok(error instanceof WgerError);
      assert.deepEqual(error.details, body);
      assert.match(error.message, /no more than 1 digits/);
      return true;
    });
  });

  it('reports shape drift as unexpected_response', async () => {
    const { fetch } = fakeFetch(() => json({ id: 'not-a-number' }));
    await assert.rejects(client(fetch).get('routine/1/', item), { kind: 'unexpected_response' });
  });

  it('times out', async () => {
    const { fetch } = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    // AbortSignal.timeout() is unref'd: keep the event loop alive meanwhile.
    const keepAlive = setTimeout(() => undefined, 5000);
    try {
      await assert.rejects(client(fetch, 20).get('routine/', item), { kind: 'timeout' });
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('reports network failures without leaking the URL', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed http://wger.test/api/v2/routine/');
    });
    await assert.rejects(client(fetch).get('routine/', item), (error: unknown) => {
      assert.ok(error instanceof WgerError);
      assert.equal(error.kind, 'network');
      assert.doesNotMatch(error.message, /wger\.test/);
      return true;
    });
  });

  it('returns nothing on 204 delete', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    await client(fetch).delete('routine/1/');
    assert.equal(calls[0]?.init.method, 'DELETE');
  });
});
