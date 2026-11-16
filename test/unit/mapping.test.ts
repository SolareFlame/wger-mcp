import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { workoutLogSchema, type WgerWorkoutLog } from '../../src/wger/api.ts';
import { parseDecimal, toPlannedValue, toSetResult } from '../../src/wger/mapping.ts';

/** Response of POST /api/v2/workoutlog/ captured on wger 2.8.0-dev.5. */
const realLog: WgerWorkoutLog = workoutLogSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/workoutlog.json', import.meta.url), 'utf8')),
);

const log = (overrides: Partial<WgerWorkoutLog>): WgerWorkoutLog => ({ ...realLog, ...overrides });

describe('toSetResult (WorkoutLog → SetResult)', () => {
  it('maps a real wger 2.8 log', () => {
    assert.deepEqual(toSetResult(realLog), {
      logId: '01a1e530-3735-78fd-9ae4-4ba72fb2b1ec',
      sessionId: '01a1e530-3743-7fa7-bff2-155a942e5253',
      routineId: null,
      exerciseId: 615,
      performedAt: '2026-11-15T18:00:00+01:00',
      date: '2026-11-15',
      reps: 5,
      repsUnit: 'reps',
      weight: 100,
      weightUnit: 'kg',
      rir: 2,
      notes: null,
    });
  });

  it('parses decimal strings, keeps fractional values', () => {
    const set = toSetResult(log({ weight: '107.50', repetitions: '3.00', rir: '1.5' }));
    assert.equal(set.weight, 107.5);
    assert.equal(set.reps, 3);
    assert.equal(set.rir, 1.5);
  });

  it('keeps missing values as null', () => {
    const set = toSetResult(log({ weight: null, repetitions: null, rir: null, session: null }));
    assert.equal(set.weight, null);
    assert.equal(set.reps, null);
    assert.equal(set.rir, null);
    assert.equal(set.sessionId, null);
  });

  it('maps known units and flags unknown ones', () => {
    assert.equal(toSetResult(log({ weight_unit: 2 })).weightUnit, 'lb');
    assert.equal(toSetResult(log({ weight_unit: 3 })).weightUnit, 'bodyweight');
    assert.equal(toSetResult(log({ weight_unit: 99 })).weightUnit, 'unknown');
    assert.equal(toSetResult(log({ repetitions_unit: 3 })).repsUnit, 'seconds');
    assert.equal(toSetResult(log({ repetitions_unit: 2 })).repsUnit, 'until_failure');
    assert.equal(toSetResult(log({ repetitions_unit: 42 })).repsUnit, 'unknown');
  });

  it('treats null units as wger defaults (kg, repetitions)', () => {
    const set = toSetResult(log({ weight_unit: null, repetitions_unit: null }));
    assert.equal(set.weightUnit, 'kg');
    assert.equal(set.repsUnit, 'reps');
  });

  it('takes the calendar day in the server time zone, not UTC', () => {
    // 00:30 in Paris is still the previous day in UTC.
    assert.equal(toSetResult(log({ date: '2026-11-15T00:30:00+01:00' })).date, '2026-11-15');
    assert.equal(toSetResult(log({ date: '2026-11-16T17:28:36.170426+01:00' })).date, '2026-11-16');
  });

  it('keeps routine and notes', () => {
    const set = toSetResult(log({ routine: 7, notes: 'easy' }));
    assert.equal(set.routineId, 7);
    assert.equal(set.notes, 'easy');
  });

  it('rejects payloads that drifted from the 2.8 shape', () => {
    // Pre-2.8 logs had integer ids.
    assert.equal(workoutLogSchema.safeParse({ ...realLog, id: 12 }).success, false);
    assert.equal(workoutLogSchema.safeParse({ ...realLog, exercise: undefined }).success, false);
  });
});

describe('parseDecimal', () => {
  it('handles strings, numbers, empty and garbage', () => {
    assert.equal(parseDecimal('100.00'), 100);
    assert.equal(parseDecimal(12.5), 12.5);
    assert.equal(parseDecimal(null), null);
    assert.equal(parseDecimal(''), null);
    assert.equal(parseDecimal('abc'), null);
  });
});

describe('toPlannedValue', () => {
  it('uses the lowest iteration as base and the rest as progression', () => {
    const planned = toPlannedValue(
      [
        { iteration: 3, value: '2.50', operation: '+', step: 'abs', repeat: true },
        { iteration: 1, value: '100.00', operation: 'r', step: 'na', repeat: false },
      ],
      [{ iteration: 1, value: '110.00' }],
    );
    assert.deepEqual(planned, {
      value: 100,
      max: 110,
      progression: [{ iteration: 3, operation: '+', value: 2.5, step: 'abs', repeat: true }],
    });
  });

  it('is empty without configs', () => {
    assert.deepEqual(toPlannedValue([], []), { value: null, max: null, progression: [] });
  });
});
