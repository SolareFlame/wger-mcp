import * as z from 'zod';
import type {
  ExerciseSummary,
  NewRoutine,
  NewRoutineExercise,
  NewSet,
  RoutineDetail,
  RoutineSummary,
  SetResult,
} from '../domain/types.ts';
import { WgerError, type WgerClient } from './client.ts';
import {
  REPETITION_UNIT_REPS,
  WEIGHT_UNIT_KG,
  routineExerciseIds,
  toExerciseSummary,
  toRoutineDetail,
  toRoutineSummary,
  toSetResult,
} from './mapping.ts';

/**
 * wger resources. Every endpoint, filter and payload field name is here,
 * checked against wger-schema.json and real responses of wger 2.8.0-dev.5.
 *
 * Notable facts (2.8):
 * - workoutlog / workoutsession ids are UUID strings, not integers.
 * - workoutlog.exercise is the exercise id of /exerciseinfo/ (former "base").
 * - workoutlog.date is a date-time. Without `session`, wger reuses or creates
 *   the session of that calendar day. With `session` but no `date`, the date
 *   is "now", not the session's date.
 * - weight / repetitions / rir are decimals, serialized as strings; units
 *   default to 1 (kg / repetitions).
 * - workoutsession has datetime_start / datetime_end (no `date` anymore) and
 *   a nullable `routine`.
 * - /exercise/search/ is gone: search is /exerciseinfo/?name__search=,
 *   restricted to the translations of `language__code`.
 * - Routines are routine → day → slot → slot-entry → *-config;
 *   /routine/{id}/structure/ returns the whole tree in one call.
 * - Deleting a routine cascades to its days/slots/entries/configs; deleting
 *   a session cascades to its logs.
 */

// ---------------------------------------------------------------- schemas

const decimal = z.union([z.string(), z.number()]).nullable();
const idOnly = z.object({ id: z.number().int() });

export const workoutLogSchema = z.object({
  id: z.string(),
  date: z.string(),
  session: z.string().nullable(),
  routine: z.number().int().nullable(),
  exercise: z.number().int(),
  repetitions_unit: z.number().int().nullable(),
  repetitions: decimal,
  weight_unit: z.number().int().nullable(),
  weight: decimal,
  rir: decimal,
  notes: z.string().nullish(),
});
export type WgerWorkoutLog = z.infer<typeof workoutLogSchema>;

export const workoutSessionSchema = z.object({
  id: z.string(),
  routine: z.number().int().nullable(),
  day: z.number().int().nullable(),
  notes: z.string().nullish(),
  datetime_start: z.string(),
  datetime_end: z.string().nullable(),
});
export type WgerWorkoutSession = z.infer<typeof workoutSessionSchema>;

const namedSchema = z.object({ name: z.string() });

export const exerciseInfoSchema = z.object({
  id: z.number().int(),
  category: namedSchema.nullable(),
  muscles: z.array(z.object({ name: z.string(), name_en: z.string().nullish() })),
  muscles_secondary: z.array(z.object({ name: z.string(), name_en: z.string().nullish() })),
  equipment: z.array(namedSchema),
  translations: z.array(z.object({ language: z.number().int(), name: z.string() })),
});
export type WgerExerciseInfo = z.infer<typeof exerciseInfoSchema>;

const languageSchema = z.object({ id: z.number().int(), short_name: z.string() });

export const routineSchema = z.object({
  id: z.number().int(),
  name: z.string().optional(),
  description: z.string().optional(),
  start: z.string(),
  end: z.string(),
  fit_in_week: z.boolean().optional(),
});
export type WgerRoutine = z.infer<typeof routineSchema>;

export const configSchema = z.object({
  iteration: z.number().int(),
  value: z.union([z.string(), z.number()]),
  operation: z.enum(['+', '-', 'r']).optional(),
  step: z.enum(['na', 'abs', 'percent']).optional(),
  repeat: z.boolean().optional(),
});
export type WgerConfig = z.infer<typeof configSchema>;

const configs = z.array(configSchema);

export const slotEntryStructureSchema = z.object({
  id: z.number().int(),
  exercise: z.number().int(),
  order: z.number().int().optional(),
  comment: z.string().optional(),
  type: z.string().optional(),
  repetition_unit: z.number().int().nullable(),
  weight_unit: z.number().int().nullable(),
  set_nr_configs: configs,
  max_set_nr_configs: configs,
  repetitions_configs: configs,
  max_repetitions_configs: configs,
  weight_configs: configs,
  max_weight_configs: configs,
  rir_configs: configs,
  max_rir_configs: configs,
  rest_configs: configs,
  max_rest_configs: configs,
});
export type WgerSlotEntryStructure = z.infer<typeof slotEntryStructureSchema>;

export const routineStructureSchema = routineSchema.extend({
  days: z.array(
    z.object({
      id: z.number().int(),
      order: z.number().int().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      is_rest: z.boolean().optional(),
      slots: z.array(
        z.object({
          id: z.number().int(),
          order: z.number().int().optional(),
          comment: z.string().optional(),
          entries: z.array(slotEntryStructureSchema),
        }),
      ),
    }),
  ),
});
export type WgerRoutineStructure = z.infer<typeof routineStructureSchema>;

// ------------------------------------------------------------- operations

export interface LogSetOptions {
  /** YYYY-MM-DD or ISO date-time. Omitted: wger uses "now". */
  date?: string | undefined;
  sessionId?: string | undefined;
  routineId?: number | undefined;
  notes?: string | undefined;
}

export interface SetFilter {
  exerciseId?: number | undefined;
  /** Inclusive, YYYY-MM-DD (server time zone). */
  from?: string | undefined;
  /** Inclusive, YYYY-MM-DD (server time zone). */
  to?: string | undefined;
  limit: number;
}

export const FALLBACK_LANGUAGE = 'en';

export class WgerApi {
  readonly #client: WgerClient;
  #languages: Promise<Map<string, number>> | null = null;

  constructor(client: WgerClient) {
    this.#client = client;
  }

  // ---- exercises

  async searchExercises(term: string, languageCode: string, limit: number): Promise<ExerciseSummary[]> {
    const [page, names] = await Promise.all([
      this.#client.page('exerciseinfo/', exerciseInfoSchema, {
        name__search: term,
        language__code: languageCode,
        limit,
      }),
      this.#nameLanguages(languageCode),
    ]);
    return page.results.map((e) => toExerciseSummary(e, names.preferred, names.fallback));
  }

  async getExercises(ids: readonly number[], languageCode: string): Promise<Map<number, ExerciseSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const [exercises, names] = await Promise.all([
      this.#client.listAll('exerciseinfo/', exerciseInfoSchema, { id__in: unique }, { max: unique.length }),
      this.#nameLanguages(languageCode),
    ]);
    return new Map(
      exercises.map((e) => [e.id, toExerciseSummary(e, names.preferred, names.fallback)] as const),
    );
  }

  // ---- routines

  async listRoutines(): Promise<RoutineSummary[]> {
    const routines = await this.#client.listAll('routine/', routineSchema, {
      is_template: false,
      ordering: '-start',
    });
    return routines.map(toRoutineSummary);
  }

  async getRoutine(routineId: number, languageCode: string): Promise<RoutineDetail> {
    const structure = await this.#client.get(`routine/${routineId}/structure/`, routineStructureSchema);
    const exercises = await this.getExercises(routineExerciseIds(structure), languageCode);
    const names = new Map([...exercises].map(([id, e]) => [id, e.name] as const));
    return toRoutineDetail(structure, names);
  }

  /**
   * Creates routine → days → slots → entries → configs. wger has no
   * transactional endpoint: on any failure the routine is deleted, which
   * cascades to everything created under it.
   */
  async createRoutine(spec: NewRoutine): Promise<number> {
    const routine = await this.#client.post(
      'routine/',
      {
        name: spec.name,
        description: spec.description ?? '',
        start: spec.start,
        end: spec.end,
        fit_in_week: spec.fitInWeek,
      },
      idOnly,
    );
    try {
      for (const [dayIndex, day] of spec.days.entries()) {
        const created = await this.#client.post(
          'day/',
          { routine: routine.id, order: dayIndex + 1, name: day.name, is_rest: day.isRest },
          idOnly,
        );
        await settleAll(
          day.exercises.map((exercise, index) => this.#createEntry(created.id, index + 1, exercise)),
        );
      }
      return routine.id;
    } catch (error) {
      const rolledBack = await this.#client.delete(`routine/${routine.id}/`).then(
        () => true,
        () => false,
      );
      const suffix = rolledBack
        ? 'the partially created routine was deleted'
        : `rollback failed, delete routine ${routine.id} manually`;
      const message = `${error instanceof Error ? error.message : String(error)} (${suffix})`;
      if (error instanceof WgerError) throw new WgerError(error.kind, message, error.status, error.details);
      throw new Error(message, { cause: error });
    }
  }

  async deleteRoutine(routineId: number): Promise<void> {
    await this.#client.delete(`routine/${routineId}/`);
  }

  async #createEntry(dayId: number, order: number, exercise: NewRoutineExercise): Promise<void> {
    const slot = await this.#client.post('slot/', { day: dayId, order }, idOnly);
    const entry = await this.#client.post(
      'slot-entry/',
      {
        slot: slot.id,
        exercise: exercise.exerciseId,
        order: 1,
        weight_unit: WEIGHT_UNIT_KG,
        repetition_unit: REPETITION_UNIT_REPS,
      },
      idOnly,
    );
    const config = (path: string, value: number) =>
      this.#client.post(path, { slot_entry: entry.id, iteration: 1, value }, idOnly);
    await settleAll([
      config('sets-config/', Math.round(exercise.sets)),
      config('repetitions-config/', roundDecimal(exercise.reps, 2)),
      ...(exercise.weight === undefined ? [] : [config('weight-config/', roundDecimal(exercise.weight, 2))]),
      ...(exercise.rir === undefined ? [] : [config('rir-config/', roundDecimal(exercise.rir, 1))]),
    ]);
  }

  // ---- logs & sessions

  async logSet(exerciseId: number, set: NewSet, options: LogSetOptions = {}): Promise<SetResult> {
    const log = await this.#client.post(
      'workoutlog/',
      {
        exercise: exerciseId,
        repetitions: roundDecimal(set.reps, 2),
        repetitions_unit: REPETITION_UNIT_REPS,
        weight: roundDecimal(set.weight, 2),
        weight_unit: WEIGHT_UNIT_KG,
        ...(set.rir === undefined ? {} : { rir: roundDecimal(set.rir, 1) }),
        ...(options.date === undefined ? {} : { date: options.date }),
        ...(options.sessionId === undefined ? {} : { session: options.sessionId }),
        ...(options.routineId === undefined ? {} : { routine: options.routineId }),
        ...(options.notes === undefined ? {} : { notes: options.notes }),
      },
      workoutLogSchema,
    );
    return toSetResult(log);
  }

  /** Logged sets, most recent first. */
  async listSets(filter: SetFilter): Promise<SetResult[]> {
    const logs = await this.#client.listAll(
      'workoutlog/',
      workoutLogSchema,
      {
        exercise: filter.exerciseId,
        date__gte: filter.from,
        // `date` is a date-time: date__lte=YYYY-MM-DD means midnight and
        // would drop that whole day. Use "before the next day" instead.
        date__lt: filter.to === undefined ? undefined : addDays(filter.to, 1),
        ordering: '-date',
      },
      { max: filter.limit },
    );
    return logs.map(toSetResult);
  }

  async deleteLog(logId: string): Promise<void> {
    await this.#client.delete(`workoutlog/${encodeURIComponent(logId)}/`);
  }

  async createSession(start: string, notes?: string): Promise<WgerWorkoutSession> {
    return this.#client.post(
      'workoutsession/',
      { datetime_start: start, ...(notes === undefined ? {} : { notes }) },
      workoutSessionSchema,
    );
  }

  /** Deletes a session and, by cascade, all its logs. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.#client.delete(`workoutsession/${encodeURIComponent(sessionId)}/`);
  }

  // ---- languages

  /** Language ids to pick exercise names: first code of `codes`, then English. */
  async #nameLanguages(codes: string): Promise<{ preferred: number | null; fallback: number | null }> {
    this.#languages ??= this.#client
      .listAll('language/', languageSchema, {}, { max: 500 })
      .then((list) => new Map(list.map((l) => [l.short_name, l.id] as const)));
    let languages: Map<string, number>;
    try {
      languages = await this.#languages;
    } catch {
      // Names are a nicety: never fail a search because languages are unavailable.
      this.#languages = null;
      return { preferred: null, fallback: null };
    }
    const preferred = codes.split(',')[0]?.trim() ?? FALLBACK_LANGUAGE;
    return {
      preferred: languages.get(preferred) ?? null,
      fallback: languages.get(FALLBACK_LANGUAGE) ?? null,
    };
  }
}

/** Like Promise.all, but waits for every promise before rejecting with the first error. */
async function settleAll(promises: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}

/**
 * wger decimals have fixed places (weight / repetitions: 2, rir: 1) and
 * reject more digits with a 400.
 */
export function roundDecimal(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** YYYY-MM-DD + n days, calendar arithmetic (no time zone involved). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid date: ${date}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
