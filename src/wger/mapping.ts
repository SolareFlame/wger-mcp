import type {
  ExerciseSummary,
  PlannedValue,
  ProgressionStep,
  RepetitionUnit,
  RoutineDetail,
  RoutineSummary,
  SetResult,
  WeightUnit,
} from '../domain/types.ts';
import type {
  WgerConfig,
  WgerExerciseInfo,
  WgerRoutine,
  WgerRoutineStructure,
  WgerSlotEntryStructure,
  WgerWorkoutLog,
} from './api.ts';

/**
 * Pure conversions from wger payloads (validated in api.ts) to domain types.
 * Field names stay confined to src/wger/: api.ts for requests and schemas,
 * this file for reading them.
 */

/** IDs of /setting-weightunit/ (wger fixtures, checked on 2.8.0-dev.5). */
export const WEIGHT_UNITS: Readonly<Record<number, WeightUnit>> = {
  1: 'kg',
  2: 'lb',
  3: 'bodyweight',
  4: 'plates',
  5: 'km/h',
  6: 'mph',
};

/** IDs of /setting-repetitionunit/ (wger fixtures, checked on 2.8.0-dev.5). */
export const REPETITION_UNITS: Readonly<Record<number, RepetitionUnit>> = {
  1: 'reps',
  2: 'until_failure',
  3: 'seconds',
  4: 'minutes',
  5: 'miles',
  6: 'kilometers',
  7: 'max_reps',
  8: 'meters',
};

export const WEIGHT_UNIT_KG = 1;
export const REPETITION_UNIT_REPS = 1;

/** wger serializes decimals as strings ("100.00"); tolerate numbers too. */
export function parseDecimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A null unit falls back to wger's model default (kg, repetitions): that is
 * what wger itself stores when a log is created without units.
 */
export function weightUnitOf(id: number | null): WeightUnit {
  return WEIGHT_UNITS[id ?? WEIGHT_UNIT_KG] ?? 'unknown';
}

export function repetitionUnitOf(id: number | null): RepetitionUnit {
  return REPETITION_UNITS[id ?? REPETITION_UNIT_REPS] ?? 'unknown';
}

/** wger returns local date-times ("2026-11-15T18:00:00+01:00"): the day is the date prefix. */
export function calendarDate(dateTime: string): string {
  return dateTime.slice(0, 10);
}

export function toSetResult(log: WgerWorkoutLog): SetResult {
  return {
    logId: log.id,
    sessionId: log.session,
    routineId: log.routine,
    exerciseId: log.exercise,
    performedAt: log.date,
    date: calendarDate(log.date),
    reps: parseDecimal(log.repetitions),
    repsUnit: repetitionUnitOf(log.repetitions_unit),
    weight: parseDecimal(log.weight),
    weightUnit: weightUnitOf(log.weight_unit),
    rir: parseDecimal(log.rir),
    notes: log.notes ?? null,
  };
}

/** Exercise name in the preferred language, then English, then any. */
export function exerciseName(
  exercise: WgerExerciseInfo,
  languageId: number | null,
  fallbackLanguageId: number | null,
): string {
  const byLanguage = (id: number | null) =>
    id === null ? undefined : exercise.translations.find((t) => t.language === id);
  const translation =
    byLanguage(languageId) ?? byLanguage(fallbackLanguageId) ?? exercise.translations[0];
  return translation?.name ?? `exercise #${exercise.id}`;
}

export function toExerciseSummary(
  exercise: WgerExerciseInfo,
  languageId: number | null,
  fallbackLanguageId: number | null,
): ExerciseSummary {
  const muscleName = (m: { name: string; name_en?: string | null | undefined }) => m.name_en || m.name;
  return {
    id: exercise.id,
    name: exerciseName(exercise, languageId, fallbackLanguageId),
    category: exercise.category?.name ?? null,
    muscles: exercise.muscles.map(muscleName),
    musclesSecondary: exercise.muscles_secondary.map(muscleName),
    equipment: exercise.equipment.map((e) => e.name),
  };
}

export function toRoutineSummary(routine: WgerRoutine): RoutineSummary {
  return {
    id: routine.id,
    name: routine.name ?? '',
    description: routine.description ?? '',
    start: routine.start,
    end: routine.end,
    fitInWeek: routine.fit_in_week ?? false,
  };
}

function toProgressionStep(config: WgerConfig): ProgressionStep | null {
  const value = parseDecimal(config.value);
  if (value === null) return null;
  return {
    iteration: config.iteration,
    operation: config.operation ?? 'r',
    value,
    step: config.step ?? 'na',
    repeat: config.repeat ?? false,
  };
}

/** Lowest iteration is the base value, later ones are progression rules. */
export function toPlannedValue(configs: readonly WgerConfig[], maxConfigs: readonly WgerConfig[]): PlannedValue {
  const steps = (list: readonly WgerConfig[]) =>
    list
      .map(toProgressionStep)
      .filter((s): s is ProgressionStep => s !== null)
      .sort((a, b) => a.iteration - b.iteration);
  const [base, ...progression] = steps(configs);
  const [maxBase] = steps(maxConfigs);
  return { value: base?.value ?? null, max: maxBase?.value ?? null, progression };
}

function toRoutineEntry(entry: WgerSlotEntryStructure, names: ReadonlyMap<number, string>) {
  return {
    id: entry.id,
    exerciseId: entry.exercise,
    exerciseName: names.get(entry.exercise) ?? null,
    type: entry.type ?? 'normal',
    comment: entry.comment ?? '',
    sets: toPlannedValue(entry.set_nr_configs, entry.max_set_nr_configs),
    reps: toPlannedValue(entry.repetitions_configs, entry.max_repetitions_configs),
    repsUnit: repetitionUnitOf(entry.repetition_unit),
    weight: toPlannedValue(entry.weight_configs, entry.max_weight_configs),
    weightUnit: weightUnitOf(entry.weight_unit),
    rir: toPlannedValue(entry.rir_configs, entry.max_rir_configs),
    restSeconds: toPlannedValue(entry.rest_configs, entry.max_rest_configs),
  };
}

export function toRoutineDetail(
  structure: WgerRoutineStructure,
  names: ReadonlyMap<number, string>,
): RoutineDetail {
  const byOrder = <T extends { order?: number | undefined; id: number }>(a: T, b: T) =>
    (a.order ?? 0) - (b.order ?? 0) || a.id - b.id;
  return {
    ...toRoutineSummary(structure),
    days: [...structure.days].sort(byOrder).map((day) => ({
      id: day.id,
      order: day.order ?? 0,
      name: day.name ?? '',
      description: day.description ?? '',
      isRest: day.is_rest ?? false,
      slots: [...day.slots].sort(byOrder).map((slot) => ({
        id: slot.id,
        order: slot.order ?? 0,
        comment: slot.comment ?? '',
        entries: [...slot.entries].sort(byOrder).map((entry) => toRoutineEntry(entry, names)),
      })),
    })),
  };
}

/** Exercise IDs referenced by a routine, deduplicated. */
export function routineExerciseIds(structure: WgerRoutineStructure): number[] {
  const ids = new Set<number>();
  for (const day of structure.days)
    for (const slot of day.slots) for (const entry of slot.entries) ids.add(entry.exercise);
  return [...ids];
}
