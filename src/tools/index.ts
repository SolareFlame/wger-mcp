import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';
import {
  DEFAULT_ROUNDING_KG,
  DEFAULT_TM_RATIO,
  loadsForPercentages,
  summarizeE1rm,
  trainingMax,
  type E1rmPoint,
} from '../domain/strength.ts';
import type { NewRoutine, SetResult } from '../domain/types.ts';
import { addDays, type WgerApi } from '../wger/api.ts';
import { WgerError } from '../wger/client.ts';
import { formatSet, groupHistory, round1 } from './format.ts';

export interface ToolOptions {
  /** Language of exercise names when the caller does not give one. */
  defaultLanguage: string;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

// ------------------------------------------------------------ input atoms

const exerciseId = z.number().int().positive().describe('wger exercise id, from search_exercises');
const isoDate = z.iso.date().describe('YYYY-MM-DD');
const language = (fallback: string) =>
  z
    .string()
    .regex(/^[a-z]{2}(,[a-z]{2})*$/)
    .default(fallback)
    .describe('ISO 639-1 language code(s), comma separated, e.g. "fr" or "fr,en"');
const weightKg = z.number().min(0).max(999.99).describe('kg');
const reps = z.number().positive().max(999);
const rir = z.number().min(0).max(9.9).describe('Reps in reserve (0 = failure)');

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export function registerTools(server: McpServer, api: WgerApi, options: ToolOptions): void {
  const now = options.now ?? (() => new Date());
  const lang = () => language(options.defaultLanguage);
  const today = () => now().toISOString().slice(0, 10);

  server.registerTool(
    'search_exercises',
    {
      title: 'Search exercises',
      description:
        'Search the wger exercise database by name. Matches names in the given language only. ' +
        'Returns the exercise ids expected by the other tools.',
      inputSchema: {
        query: z.string().trim().min(2).max(100),
        language: lang(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ,
    },
    async ({ query, language, limit }) =>
      run(async () => {
        const exercises = await api.searchExercises(query, language, limit);
        return exercises.map((e) => ({
          id: e.id,
          name: e.name,
          category: e.category,
          muscles: e.muscles,
          muscles_secondary: e.musclesSecondary,
          equipment: e.equipment,
        }));
      }),
  );

  server.registerTool(
    'list_routines',
    {
      title: 'List routines',
      description: "List the user's routines (templates excluded), most recent start date first.",
      inputSchema: {},
      annotations: READ,
    },
    async () =>
      run(async () =>
        (await api.listRoutines()).map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          start: r.start,
          end: r.end,
          fit_in_week: r.fitInWeek,
        })),
      ),
  );

  server.registerTool(
    'get_routine',
    {
      title: 'Get routine',
      description:
        'Full structure of a routine: days, slots (several entries = superset) and, per exercise, ' +
        'planned sets / reps / weight / RIR / rest with their base value, optional max (range) ' +
        'and progression rules over iterations (weeks/cycles).',
      inputSchema: { routine_id: z.number().int().positive(), language: lang() },
      annotations: READ,
    },
    async ({ routine_id, language }) => run(() => api.getRoutine(routine_id, language)),
  );

  server.registerTool(
    'log_sets',
    {
      title: 'Log sets',
      description:
        'Log performed sets of one exercise (weight in kg). Without session_id, wger attaches the ' +
        'sets to the session of that day, creating it if needed. Sets are created in order; if one ' +
        'fails, the already logged ones are reported and kept.',
      inputSchema: {
        exercise_id: exerciseId,
        sets: z.array(z.object({ reps, weight: weightKg, rir: rir.optional() })).min(1).max(30),
        date: z
          .union([z.iso.date(), z.iso.datetime({ offset: true, local: true })])
          .optional()
          .describe('YYYY-MM-DD or ISO date-time; defaults to now'),
        session_id: z.uuid().optional().describe('Existing wger session to attach the sets to'),
        routine_id: z.number().int().positive().optional(),
        notes: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    async ({ exercise_id, sets, date, session_id, routine_id, notes }) =>
      run(async () => {
        const logged: SetResult[] = [];
        for (const [index, set] of sets.entries()) {
          try {
            // Sequential on purpose: parallel creation could create duplicate day sessions.
            logged.push(
              await api.logSet(exercise_id, set, {
                date,
                sessionId: session_id,
                routineId: routine_id,
                notes,
              }),
            );
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new PartialFailure(
              `Set ${index + 1}/${sets.length} failed: ${reason}`,
              { logged: logged.length, sets: logged.map(formatSet) },
            );
          }
        }
        return {
          logged: logged.length,
          session_id: logged[0]?.sessionId ?? null,
          date: logged[0]?.date ?? null,
          sets: logged.map(formatSet),
        };
      }),
  );

  server.registerTool(
    'get_history',
    {
      title: 'Get history',
      description:
        'Logged sets grouped by day (most recent first) then exercise, with the e1RM of each set ' +
        '(Epley adjusted for RIR, null above 12 effective reps). Dates are inclusive.',
      inputSchema: {
        exercise_id: exerciseId.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        limit: z.number().int().min(1).max(500).default(100).describe('Max number of sets'),
        language: lang(),
      },
      annotations: READ,
    },
    async ({ exercise_id, from, to, limit, language }) =>
      run(async () => {
        const sets = await api.listSets({ exerciseId: exercise_id, from, to, limit });
        const exercises = await api.getExercises(sets.map((s) => s.exerciseId), language);
        const names = new Map([...exercises].map(([id, e]) => [id, e.name] as const));
        return { sets: sets.length, truncated: sets.length === limit, days: groupHistory(sets, names) };
      }),
  );

  server.registerTool(
    'get_e1rm',
    {
      title: 'Get e1RM',
      description:
        'Estimated 1RM of an exercise over the last `days` days: best set, latest day, and the ' +
        'training max (tm_ratio of the best e1RM, rounded). Only sets in kg/lb counted in ' +
        'repetitions with reps + RIR <= 12 qualify.',
      inputSchema: {
        exercise_id: exerciseId,
        days: z.number().int().min(1).max(3650).default(90),
        tm_ratio: z.number().min(0.5).max(1).default(DEFAULT_TM_RATIO),
        rounding: z.number().positive().max(10).default(DEFAULT_ROUNDING_KG).describe('kg'),
        language: lang(),
      },
      annotations: READ,
    },
    async ({ exercise_id, days, tm_ratio, rounding, language }) =>
      run(async () => {
        const to = today();
        const from = addDays(to, -days);
        const [sets, exercises] = await Promise.all([
          api.listSets({ exerciseId: exercise_id, from, to, limit: 1000 }),
          api.getExercises([exercise_id], language),
        ]);
        const summary = summarizeE1rm(sets);
        const point = (p: E1rmPoint | null) =>
          p && {
            e1rm_kg: round1(p.e1rm),
            date: p.set.date,
            weight: p.set.weight,
            weight_unit: p.set.weightUnit,
            reps: p.set.reps,
            rir: p.set.rir,
          };
        return {
          exercise_id,
          name: exercises.get(exercise_id)?.name ?? null,
          window: { from, to },
          sets_found: sets.length,
          sets_considered: summary.considered,
          best: point(summary.best),
          latest: point(summary.latest),
          training_max_kg: summary.best ? trainingMax(summary.best.e1rm, tm_ratio, rounding) : null,
        };
      }),
  );

  server.registerTool(
    'compute_loads',
    {
      title: 'Compute loads',
      description:
        'Loads for percentages of a training max (default: tm_ratio x one_rep_max) or of the ' +
        'one-rep max itself, rounded to `rounding` kg. Pure computation, no wger call.',
      inputSchema: {
        one_rep_max: z.number().positive().max(1000).describe('kg, e.g. from get_e1rm'),
        percentages: z.array(z.number().positive().max(150)).min(1).max(30),
        basis: z.enum(['training_max', 'one_rep_max']).default('training_max'),
        tm_ratio: z.number().min(0.5).max(1).default(DEFAULT_TM_RATIO),
        rounding: z.number().positive().max(10).default(DEFAULT_ROUNDING_KG).describe('kg'),
      },
      annotations: READ,
    },
    async ({ one_rep_max, percentages, basis, tm_ratio, rounding }) =>
      run(async () => {
        const tm = trainingMax(one_rep_max, tm_ratio, rounding);
        const base = basis === 'training_max' ? tm : one_rep_max;
        return {
          basis,
          base_kg: base,
          training_max_kg: tm,
          loads: loadsForPercentages(base, percentages, rounding).map((l) => ({
            percent: l.percent,
            load_kg: l.load,
          })),
        };
      }),
  );

  server.registerTool(
    'create_routine',
    {
      title: 'Create routine',
      description:
        'Create a routine: days in cycle order (rest days allowed), each with exercises and their ' +
        'sets x reps (optional weight in kg and RIR). With fit_in_week (default), each cycle is ' +
        'padded with rest days to last exactly one week, starting on `start`. No progression rules. ' +
        'All or nothing: on failure, the partial routine is deleted.',
      inputSchema: {
        name: z.string().trim().min(1).max(25),
        description: z.string().max(1000).optional(),
        start: isoDate,
        end: isoDate,
        fit_in_week: z.boolean().default(true),
        days: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(20),
              rest: z.boolean().default(false),
              exercises: z
                .array(
                  z.object({
                    exercise_id: exerciseId,
                    sets: z.number().int().min(1).max(50),
                    reps,
                    weight: weightKg.optional(),
                    rir: rir.optional(),
                  }),
                )
                .max(20)
                .default([]),
            }),
          )
          .min(1)
          .max(14),
        language: lang(),
      },
      annotations: WRITE,
    },
    async (input) =>
      run(async () => {
        if (input.end < input.start) throw new InputError('end must be on or after start');
        const restWithExercises = input.days.find((d) => d.rest && d.exercises.length > 0);
        if (restWithExercises) throw new InputError(`rest day "${restWithExercises.name}" has exercises`);
        const workDays = input.days.filter((d) => !d.rest);
        if (workDays.length === 0 || workDays.some((d) => d.exercises.length === 0)) {
          throw new InputError('every non-rest day needs at least one exercise');
        }
        const spec: NewRoutine = {
          name: input.name,
          description: input.description,
          start: input.start,
          end: input.end,
          fitInWeek: input.fit_in_week,
          days: input.days.map((d) => ({
            name: d.name,
            isRest: d.rest,
            exercises: d.exercises.map((e) => ({
              exerciseId: e.exercise_id,
              sets: e.sets,
              reps: e.reps,
              weight: e.weight,
              rir: e.rir,
            })),
          })),
        };
        const routineId = await api.createRoutine(spec);
        return api.getRoutine(routineId, input.language);
      }),
  );
}

// ---------------------------------------------------------------- results

class InputError extends Error {}

class PartialFailure extends Error {
  readonly partial: unknown;
  constructor(message: string, partial: unknown) {
    super(message);
    this.partial = partial;
  }
}

async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn()) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: describeError(error) }] };
  }
}

function describeError(error: unknown): string {
  if (error instanceof InputError) return `Invalid input: ${error.message}`;
  if (error instanceof PartialFailure) return `${error.message}\n${JSON.stringify(error.partial)}`;
  if (error instanceof WgerError) {
    if (error.kind === 'auth') {
      return 'wger rejected the API key of this connector. Check the key in the connector URL.';
    }
    return `wger error (${error.kind}): ${error.message}`;
  }
  // Unknown failure: no internals in the answer.
  console.error('tool failure:', error instanceof Error ? error.name : typeof error);
  return 'Internal error while calling wger.';
}
