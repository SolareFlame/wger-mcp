import type { SetResult } from './types.ts';

/** Above this many "effective" reps (reps + RIR), Epley is too unreliable: no estimate. */
export const MAX_EFFECTIVE_REPS = 12;
export const DEFAULT_TM_RATIO = 0.9;
export const DEFAULT_ROUNDING_KG = 2.5;
export const LB_TO_KG = 0.45359237;

/**
 * Estimated 1RM, Epley adjusted for reps in reserve: w * (1 + (reps + rir) / 30).
 * Returns null for invalid inputs or when reps + rir > 12.
 */
export function estimateE1rm(weight: number, reps: number, rir = 0): number | null {
  if (![weight, reps, rir].every(Number.isFinite)) return null;
  if (weight <= 0 || reps < 1 || rir < 0) return null;
  const effectiveReps = reps + rir;
  if (effectiveReps > MAX_EFFECTIVE_REPS) return null;
  return weight * (1 + effectiveReps / 30);
}

/** Rounds to the nearest multiple of `step` (e.g. 2.5 kg plates). */
export function roundTo(value: number, step: number): number {
  if (!(step > 0)) throw new RangeError('step must be > 0');
  // The second rounding strips binary floating point noise (e.g. 102.49999999).
  return Math.round(Math.round(value / step) * step * 1e6) / 1e6;
}

/** Training max: a fraction of the e1RM (90 % by default), rounded to `step`. */
export function trainingMax(
  e1rm: number,
  ratio: number = DEFAULT_TM_RATIO,
  step: number = DEFAULT_ROUNDING_KG,
): number {
  return roundTo(e1rm * ratio, step);
}

export interface PercentLoad {
  percent: number;
  load: number;
}

/** Loads for each percentage of `base`, rounded to `step`. */
export function loadsForPercentages(
  base: number,
  percentages: readonly number[],
  step: number = DEFAULT_ROUNDING_KG,
): PercentLoad[] {
  return percentages.map((percent) => ({ percent, load: roundTo((base * percent) / 100, step) }));
}

/**
 * e1RM of a logged set, in kg. Only sets counted in repetitions and weighed
 * in kg or lb qualify; a missing RIR counts as 0 (set taken to failure).
 */
export function setE1rmKg(set: SetResult): number | null {
  if (set.repsUnit !== 'reps' || set.reps === null || set.weight === null) return null;
  let weightKg: number;
  if (set.weightUnit === 'kg') weightKg = set.weight;
  else if (set.weightUnit === 'lb') weightKg = set.weight * LB_TO_KG;
  else return null;
  return estimateE1rm(weightKg, set.reps, set.rir ?? 0);
}

export interface E1rmPoint {
  e1rm: number;
  set: SetResult;
}

export interface E1rmSummary {
  /** Sets that produced an estimate. */
  considered: number;
  /** Highest estimate over all sets. */
  best: E1rmPoint | null;
  /** Highest estimate of the most recent day that has one. */
  latest: E1rmPoint | null;
}

export function summarizeE1rm(sets: readonly SetResult[]): E1rmSummary {
  let considered = 0;
  let best: E1rmPoint | null = null;
  let latest: E1rmPoint | null = null;
  for (const set of sets) {
    const e1rm = setE1rmKg(set);
    if (e1rm === null) continue;
    considered += 1;
    if (best === null || e1rm > best.e1rm) best = { e1rm, set };
    if (
      latest === null ||
      set.date > latest.set.date ||
      (set.date === latest.set.date && e1rm > latest.e1rm)
    ) {
      latest = { e1rm, set };
    }
  }
  return { considered, best, latest };
}
