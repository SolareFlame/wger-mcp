/**
 * End-to-end test against a real wger instance, through the HTTP MCP server.
 * Skipped unless WGER_E2E_BASE_URL and WGER_API_KEY are set:
 *
 *   WGER_E2E_BASE_URL=https://gym.example WGER_API_KEY=... npm run test:e2e
 *
 * It writes to the account behind the key (one session with one log, one
 * routine) and deletes everything it created, even on failure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../../src/app.ts';
import { credentialsFromApiKey, isValidApiKey } from '../../src/auth/credentials.ts';
import { WgerApi, addDays } from '../../src/wger/api.ts';
import { WgerClient } from '../../src/wger/client.ts';

const baseUrl = process.env['WGER_E2E_BASE_URL'];
const apiKey = process.env['WGER_API_KEY'];
const enabled = Boolean(baseUrl && isValidApiKey(apiKey));
const TAG = 'wger-mcp e2e';

describe('e2e against a real wger', { skip: enabled ? false : 'WGER_E2E_BASE_URL / WGER_API_KEY not set' }, () => {
  const created = { sessionId: null as string | null, routineId: null as number | null };
  let server: Server;
  let mcp: Client;
  let api: WgerApi;
  let exerciseId: number;
  let logId: string;

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    assert.notEqual(result.isError, true, `${name} failed: ${text}`);
    return JSON.parse(text);
  };

  before(async () => {
    const config = { wgerBaseUrl: baseUrl as string, wgerTimeoutMs: 20_000, defaultLanguage: 'en' };
    api = new WgerApi(
      new WgerClient({
        baseUrl: config.wgerBaseUrl,
        timeoutMs: config.wgerTimeoutMs,
        credentials: credentialsFromApiKey(apiKey as string),
      }),
    );
    const app = createApp({ config, log: () => undefined });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    mcp = new Client({ name: 'e2e', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/${apiKey}/mcp`)));
  });

  after(async () => {
    // Cleanup first, then report what could not be removed.
    const leftovers: string[] = [];
    if (created.sessionId) {
      await api.deleteSession(created.sessionId).catch(() => leftovers.push(`session ${created.sessionId}`));
    }
    if (created.routineId !== null) {
      await api.deleteRoutine(created.routineId).catch(() => leftovers.push(`routine ${created.routineId}`));
    }
    await mcp?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    assert.deepEqual(leftovers, [], 'e2e data left on the instance');
  });

  it('search_exercises finds squat', async () => {
    const results = await call('search_exercises', { query: 'squat', limit: 5 });
    assert.ok(results.length > 0);
    const squat = results.find((e: { name: string }) => /squat/i.test(e.name));
    assert.ok(squat, JSON.stringify(results));
    exerciseId = squat.id;
  });

  it('log_sets logs one set into a dedicated session', async () => {
    // A dedicated session keeps cleanup from touching real data of the same day.
    const session = await api.createSession(new Date().toISOString(), TAG);
    created.sessionId = session.id;

    const result = await call('log_sets', {
      exercise_id: exerciseId,
      session_id: session.id,
      sets: [{ reps: 5, weight: 100, rir: 2 }],
    });
    assert.equal(result.logged, 1);
    assert.equal(result.session_id, session.id);
    const [set] = result.sets;
    assert.equal(set.reps, 5);
    assert.equal(set.weight, 100);
    assert.equal(set.weight_unit, 'kg');
    assert.equal(set.rir, 2);
    assert.equal(set.e1rm_kg, 123.3);
    logId = set.log_id;
  });

  it('get_history returns the logged set', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const history = await call('get_history', {
      exercise_id: exerciseId,
      from: addDays(today, -1),
      to: addDays(today, 1),
    });
    const sets = history.days.flatMap((d: { exercises: { sets: { log_id: string }[] }[] }) =>
      d.exercises.flatMap((e) => e.sets),
    );
    assert.ok(sets.some((s: { log_id: string }) => s.log_id === logId), JSON.stringify(history));
  });

  it('get_e1rm includes the logged set', async () => {
    const e1rm = await call('get_e1rm', { exercise_id: exerciseId, days: 2 });
    assert.ok(e1rm.sets_considered >= 1);
    assert.ok(e1rm.best.e1rm_kg >= 123.3);
    assert.ok(e1rm.training_max_kg > 0);
  });

  it('create_routine creates a readable routine', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const routine = await call('create_routine', {
      name: 'mcp-e2e',
      description: TAG,
      start: today,
      end: addDays(today, 27),
      days: [
        { name: 'Lower', exercises: [{ exercise_id: exerciseId, sets: 3, reps: 5, weight: 100, rir: 2 }] },
        { name: 'Rest', rest: true },
      ],
    });
    created.routineId = routine.id;
    assert.equal(routine.name, 'mcp-e2e');
    assert.equal(routine.fitInWeek, true);
    assert.deepEqual(
      routine.days.map((d: { name: string; isRest: boolean }) => [d.name, d.isRest]),
      [
        ['Lower', false],
        ['Rest', true],
      ],
    );
    const entry = routine.days[0].slots[0].entries[0];
    assert.equal(entry.exerciseId, exerciseId);
    assert.equal(entry.sets.value, 3);
    assert.equal(entry.reps.value, 5);
    assert.equal(entry.weight.value, 100);
    assert.equal(entry.rir.value, 2);

    const routines = await call('list_routines', {});
    assert.ok(routines.some((r: { id: number }) => r.id === routine.id));
    const fetched = await call('get_routine', { routine_id: routine.id });
    assert.deepEqual(fetched, routine);
  });
});
