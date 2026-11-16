import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LB_TO_KG,
  estimateE1rm,
  loadsForPercentages,
  roundTo,
  setE1rmKg,
  summarizeE1rm,
  trainingMax,
} from '../../src/domain/strength.ts';
import type { SetResult } from '../../src/domain/types.ts';

const close = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${actual} ≉ ${expected}`);
};

describe('estimateE1rm (Epley + RIR)', () => {
  it('applies w * (1 + (reps + rir) / 30)', () => {
    close(estimateE1rm(100, 5, 2), 100 * (1 + 7 / 30));
    close(estimateE1rm(100, 5), 100 * (1 + 5 / 30));
    close(estimateE1rm(60, 10, 0), 80);
  });

  it('accepts exactly 12 effective reps and refuses more', () => {
    close(estimateE1rm(100, 10, 2), 140);
    assert.equal(estimateE1rm(100, 10, 3), null);
    assert.equal(estimateE1rm(100, 13), null);
  });

  it('refuses invalid inputs', () => {
    assert.equal(estimateE1rm(0, 5), null);
    assert.equal(estimateE1rm(-10, 5), null);
    assert.equal(estimateE1rm(100, 0), null);
    assert.equal(estimateE1rm(100, 5, -1), null);
    assert.equal(estimateE1rm(Number.NaN, 5), null);
  });
});

describe('roundTo / trainingMax / loads', () => {
  it('rounds to the nearest step without float noise', () => {
    assert.equal(roundTo(126, 2.5), 125);
    assert.equal(roundTo(126.25, 2.5), 127.5);
    assert.equal(roundTo(102.4999999, 2.5), 102.5);
    assert.equal(roundTo(0.1 + 0.2, 0.1), 0.3);
    assert.throws(() => roundTo(10, 0), RangeError);
  });

  it('TM is 90 % rounded to 2.5 kg by default', () => {
    assert.equal(trainingMax(140), 125);
    assert.equal(trainingMax(150), 135);
    assert.equal(trainingMax(140, 0.85, 1), 119);
  });

  it('computes rounded loads per percentage', () => {
    assert.deepEqual(loadsForPercentages(125, [65, 75, 85]), [
      { percent: 65, load: 82.5 },
      { percent: 75, load: 95 },
      { percent: 85, load: 107.5 },
    ]);
  });
});

const set = (overrides: Partial<SetResult>): SetResult => ({
  logId: 'x',
  sessionId: null,
  routineId: null,
  exerciseId: 1,
  performedAt: '2026-11-15T18:00:00+01:00',
  date: '2026-11-15',
  reps: 5,
  repsUnit: 'reps',
  weight: 100,
  weightUnit: 'kg',
  rir: 0,
  notes: null,
  ...overrides,
});

describe('setE1rmKg', () => {
  it('converts lb to kg', () => {
    close(setE1rmKg(set({ weight: 220, weightUnit: 'lb', rir: 0 })), 220 * LB_TO_KG * (1 + 5 / 30));
  });

  it('counts a missing RIR as 0', () => {
    close(setE1rmKg(set({ rir: null })), 100 * (1 + 5 / 30));
  });

  it('ignores non weight/reps sets', () => {
    assert.equal(setE1rmKg(set({ weightUnit: 'bodyweight' })), null);
    assert.equal(setE1rmKg(set({ repsUnit: 'seconds' })), null);
    assert.equal(setE1rmKg(set({ weight: null })), null);
    assert.equal(setE1rmKg(set({ reps: null })), null);
  });
});

describe('summarizeE1rm', () => {
  it('finds the best set and the best of the latest day', () => {
    const sets = [
      set({ logId: 'a', date: '2026-11-01', weight: 120, reps: 3 }), // 132
      set({ logId: 'b', date: '2026-11-10', weight: 100, reps: 5 }), // 116.7
      set({ logId: 'c', date: '2026-11-10', weight: 105, reps: 3 }), // 115.5
      set({ logId: 'd', date: '2026-11-12', weight: 50, reps: 20 }), // ignored (> 12)
    ];
    const summary = summarizeE1rm(sets);
    assert.equal(summary.considered, 3);
    assert.equal(summary.best?.set.logId, 'a');
    close(summary.best?.e1rm ?? null, 132);
    assert.equal(summary.latest?.set.logId, 'b');
  });

  it('is empty without qualifying sets', () => {
    assert.deepEqual(summarizeE1rm([set({ weight: null })]), { considered: 0, best: null, latest: null });
  });
});
