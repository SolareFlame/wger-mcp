/**
 * Domain types. No wger field name lives here: src/wger/ maps wger payloads
 * onto these shapes, everything above (tools, maths) only sees these.
 */

export type WeightUnit = 'kg' | 'lb' | 'bodyweight' | 'plates' | 'km/h' | 'mph' | 'unknown';

export type RepetitionUnit =
  | 'reps'
  | 'until_failure'
  | 'max_reps'
  | 'seconds'
  | 'minutes'
  | 'meters'
  | 'kilometers'
  | 'miles'
  | 'unknown';

/** One performed set, as logged in wger. */
export interface SetResult {
  logId: string;
  sessionId: string | null;
  routineId: number | null;
  exerciseId: number;
  /** ISO 8601 date-time as stored by wger (server time zone offset included). */
  performedAt: string;
  /** Calendar day (YYYY-MM-DD) in the server time zone. */
  date: string;
  reps: number | null;
  repsUnit: RepetitionUnit;
  weight: number | null;
  weightUnit: WeightUnit;
  rir: number | null;
  notes: string | null;
}

export interface ExerciseSummary {
  id: number;
  name: string;
  category: string | null;
  muscles: string[];
  musclesSecondary: string[];
  equipment: string[];
}

export interface RoutineSummary {
  id: number;
  name: string;
  description: string;
  start: string;
  end: string;
  fitInWeek: boolean;
}

/** A training variable of a routine entry: base value + optional range and progression. */
export interface PlannedValue {
  value: number | null;
  max: number | null;
  /** Changes applied on later iterations (wger "configs" beyond the first one). */
  progression: ProgressionStep[];
}

export interface ProgressionStep {
  iteration: number;
  /** "+" add, "-" subtract, "r" replace. */
  operation: '+' | '-' | 'r';
  value: number;
  /** "abs" absolute, "percent" relative, "na" for replace. */
  step: 'abs' | 'percent' | 'na';
  repeat: boolean;
}

export interface RoutineEntry {
  id: number;
  exerciseId: number;
  exerciseName: string | null;
  type: string;
  comment: string;
  sets: PlannedValue;
  reps: PlannedValue;
  repsUnit: RepetitionUnit;
  weight: PlannedValue;
  weightUnit: WeightUnit;
  rir: PlannedValue;
  restSeconds: PlannedValue;
}

export interface RoutineSlot {
  id: number;
  order: number;
  comment: string;
  /** More than one entry means a superset. */
  entries: RoutineEntry[];
}

export interface RoutineDay {
  id: number;
  order: number;
  name: string;
  description: string;
  isRest: boolean;
  slots: RoutineSlot[];
}

export interface RoutineDetail extends RoutineSummary {
  days: RoutineDay[];
}

/** Input of a routine creation, independent from wger's day/slot/entry/config model. */
export interface NewRoutine {
  name: string;
  description?: string | undefined;
  start: string;
  end: string;
  fitInWeek: boolean;
  days: NewRoutineDay[];
}

export interface NewRoutineDay {
  name: string;
  isRest: boolean;
  exercises: NewRoutineExercise[];
}

export interface NewRoutineExercise {
  exerciseId: number;
  sets: number;
  reps: number;
  weight?: number | undefined;
  rir?: number | undefined;
}

export interface NewSet {
  reps: number;
  weight: number;
  rir?: number | undefined;
}
