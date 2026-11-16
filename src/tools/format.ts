import { setE1rmKg } from '../domain/strength.ts';
import type { SetResult } from '../domain/types.ts';

/**
 * Presentation of domain objects as compact JSON for the model.
 * snake_case keys, kg-suffixed numbers, rounded estimates.
 */

export const round1 = (value: number): number => Math.round(value * 10) / 10;

/** Code-unit comparison: ISO 8601 strings from one server sort chronologically. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function formatSet(set: SetResult) {
  const e1rm = setE1rmKg(set);
  return {
    log_id: set.logId,
    reps: set.reps,
    ...(set.repsUnit === 'reps' ? {} : { reps_unit: set.repsUnit }),
    weight: set.weight,
    weight_unit: set.weightUnit,
    rir: set.rir,
    e1rm_kg: e1rm === null ? null : round1(e1rm),
    ...(set.notes ? { notes: set.notes } : {}),
  };
}

export interface HistoryDay {
  date: string;
  exercises: {
    exercise_id: number;
    name: string | null;
    sets: ReturnType<typeof formatSet>[];
  }[];
}

/**
 * Groups sets by day (most recent first), then by exercise in the order they
 * were first performed that day, with sets in chronological order.
 */
export function groupHistory(
  sets: readonly SetResult[],
  names: ReadonlyMap<number, string>,
): HistoryDay[] {
  const chronological = [...sets].sort(
    (a, b) => compare(a.performedAt, b.performedAt) || compare(a.logId, b.logId),
  );
  const days = new Map<string, Map<number, SetResult[]>>();
  for (const set of chronological) {
    const day = days.get(set.date) ?? new Map<number, SetResult[]>();
    days.set(set.date, day);
    const list = day.get(set.exerciseId) ?? [];
    day.set(set.exerciseId, list);
    list.push(set);
  }
  return [...days.entries()]
    .sort(([a], [b]) => compare(b, a))
    .map(([date, exercises]) => ({
      date,
      exercises: [...exercises.entries()].map(([exerciseId, list]) => ({
        exercise_id: exerciseId,
        name: names.get(exerciseId) ?? null,
        sets: list.map(formatSet),
      })),
    }));
}
