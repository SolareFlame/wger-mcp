import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SetResult } from '../../src/domain/types.ts';
import { formatSet, groupHistory } from '../../src/tools/format.ts';

const set = (logId: string, performedAt: string, exerciseId = 615, weight = 100): SetResult => ({
  logId,
  sessionId: null,
  routineId: null,
  exerciseId,
  performedAt,
  date: performedAt.slice(0, 10),
  reps: 5,
  repsUnit: 'reps',
  weight,
  weightUnit: 'kg',
  rir: 2,
  notes: null,
});

describe('formatSet', () => {
  it('rounds e1RM to 0.1 kg', () => {
    assert.equal(formatSet(set('a', '2026-11-15T18:00:00+01:00')).e1rm_kg, 123.3);
  });
});

describe('groupHistory', () => {
  it('groups by day desc, exercise in first-performed order, sets chronological', () => {
    const sets = [
      // as returned by wger with ordering=-date
      set('d', '2026-11-15T18:20:00+01:00', 73),
      set('c', '2026-11-15T18:10:00+01:00', 615, 107.5),
      set('b', '2026-11-15T18:00:00+01:00', 615),
      set('a', '2026-11-10T00:00:00+01:00', 615, 80),
    ];
    const days = groupHistory(sets, new Map([[615, 'Squats']]));
    assert.deepEqual(
      days.map((d) => [d.date, d.exercises.map((e) => [e.exercise_id, e.name, e.sets.map((s) => s.log_id)])]),
      [
        [
          '2026-11-15',
          [
            [615, 'Squats', ['b', 'c']],
            [73, null, ['d']],
          ],
        ],
        ['2026-11-10', [[615, 'Squats', ['a']]]],
      ],
    );
  });
});
