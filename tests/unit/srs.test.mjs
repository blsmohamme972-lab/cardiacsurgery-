// Unit tests for js/features/srs.js (spaced repetition, pure). Run: node --test tests/unit/*.test.mjs
import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  nextSrs,
  isDue,
  DEFAULT_EASE,
  MIN_EASE,
  MAX_EASE,
  LAPSE_EASE_PENALTY,
  SPEED_EASE_STEP,
  FAST_MS,
  SLOW_MS,
  RELEARN_DELAY_MS,
  DAY_MS,
} from '../../js/features/srs.js';

/** A fixed answer time (2026-01-15 10:00 UTC). */
const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
/** Neither fast nor slow. */
const NORMAL_MS = 45 * 1000;
/** Fast (< 20 s). */
const QUICK_MS = 5 * 1000;
/** Slow (> 90 s). */
const LONG_MS = 120 * 1000;

const right = (ms = NORMAL_MS) => ({ correct: true, ms });
const wrong = (ms = NORMAL_MS) => ({ correct: false, ms });

/**
 * @param {Partial<import('../../js/features/srs.js').Srs>} fields
 */
function srs(fields = {}) {
  return { due: NOW, interval: 0, ease: DEFAULT_EASE, reps: 0, lapses: 0, ...fields };
}

describe('constants', () => {
  test('match the contract (§7.1)', () => {
    assert.equal(DEFAULT_EASE, 2.5);
    assert.equal(MIN_EASE, 1.3);
    assert.equal(MAX_EASE, 3.0);
    assert.equal(LAPSE_EASE_PENALTY, 0.2);
    assert.equal(SPEED_EASE_STEP, 0.05);
    assert.equal(FAST_MS, 20000);
    assert.equal(SLOW_MS, 90000);
    assert.equal(RELEARN_DELAY_MS, 10 * 60 * 1000);
    assert.equal(DAY_MS, 86400000);
  });
});

describe('nextSrs: first answer (prev = null)', () => {
  test('right at normal speed: reps 1, interval 1 day, default ease', () => {
    assert.deepEqual(nextSrs(null, right(), NOW), {
      due: NOW + DAY_MS,
      interval: 1,
      ease: 2.5,
      reps: 1,
      lapses: 0,
    });
  });

  test('right and fast: ease + 0.05', () => {
    assert.deepEqual(nextSrs(null, right(QUICK_MS), NOW), {
      due: NOW + DAY_MS,
      interval: 1,
      ease: 2.55,
      reps: 1,
      lapses: 0,
    });
  });

  test('right and slow: ease - 0.05', () => {
    assert.equal(nextSrs(null, right(LONG_MS), NOW).ease, 2.45);
  });

  test('wrong: reps 0, lapses 1, interval 0, due in 10 minutes, ease - 0.2', () => {
    assert.deepEqual(nextSrs(null, wrong(), NOW), {
      due: NOW + RELEARN_DELAY_MS,
      interval: 0,
      ease: 2.3,
      reps: 0,
      lapses: 1,
    });
  });

  test('undefined prev behaves like null', () => {
    assert.deepEqual(nextSrs(undefined, right(), NOW), nextSrs(null, right(), NOW));
    assert.deepEqual(nextSrs(undefined, wrong(), NOW), nextSrs(null, wrong(), NOW));
  });
});

describe('nextSrs: success intervals', () => {
  test('first success → 1 day, second → 3 days, third → round(interval × ease)', () => {
    const s1 = nextSrs(null, right(), NOW);
    assert.equal(s1.reps, 1);
    assert.equal(s1.interval, 1);
    assert.equal(s1.due, NOW + 1 * DAY_MS);

    const t2 = NOW + DAY_MS;
    const s2 = nextSrs(s1, right(), t2);
    assert.equal(s2.reps, 2);
    assert.equal(s2.interval, 3);
    assert.equal(s2.due, t2 + 3 * DAY_MS);

    const t3 = t2 + 3 * DAY_MS;
    const s3 = nextSrs(s2, right(), t3);
    assert.equal(s3.reps, 3);
    assert.equal(s3.interval, 8); // round(3 × 2.5 = 7.5)
    assert.equal(s3.due, t3 + 8 * DAY_MS);

    const s4 = nextSrs(s3, right(), t3);
    assert.equal(s4.reps, 4);
    assert.equal(s4.interval, 20); // 8 × 2.5
    assert.equal(s4.ease, 2.5);
  });

  test('the interval uses the ease in effect before the answer', () => {
    // Fast answers raise the ease after the interval is computed.
    const s1 = nextSrs(null, right(QUICK_MS), NOW); // ease 2.55
    const s2 = nextSrs(s1, right(QUICK_MS), NOW); // interval 3, ease 2.6
    assert.equal(s2.ease, 2.6);
    const s3 = nextSrs(s2, right(QUICK_MS), NOW);
    assert.equal(s3.interval, 8); // round(3 × 2.6 = 7.8), not 3 × 2.65
    assert.equal(s3.ease, 2.65);
    const s4 = nextSrs(s3, right(QUICK_MS), NOW);
    assert.equal(s4.interval, 21); // round(8 × 2.65 = 21.2)
  });

  test('later reviews round half up (round(interval × ease))', () => {
    assert.equal(nextSrs(srs({ reps: 2, interval: 5, ease: 2.5 }), right(), NOW).interval, 13); // 12.5
    assert.equal(nextSrs(srs({ reps: 5, interval: 10, ease: 1.34 }), right(), NOW).interval, 13); // 13.4
    assert.equal(nextSrs(srs({ reps: 5, interval: 10, ease: 1.36 }), right(), NOW).interval, 14); // 13.6
  });

  test('a later review never schedules less than 1 day', () => {
    const s = nextSrs(srs({ reps: 4, interval: 0, ease: 2.5 }), right(), NOW);
    assert.equal(s.reps, 5);
    assert.equal(s.interval, 1);
    assert.equal(s.due, NOW + DAY_MS);
  });

  test('success keeps lapses', () => {
    const s = nextSrs(srs({ reps: 2, interval: 3, lapses: 4 }), right(), NOW);
    assert.equal(s.lapses, 4);
  });
});

describe('nextSrs: lapse', () => {
  test('resets reps and interval, counts the lapse, due in 10 minutes', () => {
    const prev = srs({ due: NOW - DAY_MS, reps: 6, interval: 40, ease: 2.7, lapses: 2 });
    assert.deepEqual(nextSrs(prev, wrong(), NOW), {
      due: NOW + RELEARN_DELAY_MS,
      interval: 0,
      ease: 2.5,
      reps: 0,
      lapses: 3,
    });
  });

  test('answer time does not change the lapse penalty', () => {
    for (const ms of [QUICK_MS, NORMAL_MS, LONG_MS, undefined]) {
      assert.equal(nextSrs(null, wrong(ms), NOW).ease, 2.3, `ms=${ms}`);
    }
  });

  test('after a lapse the success ladder restarts at 1 day, then 3 days', () => {
    const lapsed = nextSrs(srs({ reps: 5, interval: 30 }), wrong(), NOW);
    const s1 = nextSrs(lapsed, right(), NOW);
    assert.equal(s1.reps, 1);
    assert.equal(s1.interval, 1);
    const s2 = nextSrs(s1, right(), NOW);
    assert.equal(s2.reps, 2);
    assert.equal(s2.interval, 3);
    const s3 = nextSrs(s2, right(), NOW);
    assert.equal(s3.interval, Math.round(3 * lapsed.ease));
  });
});

describe('nextSrs: ease clamps and rounding', () => {
  test('ease never drops below 1.3 on a lapse', () => {
    assert.equal(nextSrs(srs({ ease: 1.4 }), wrong(), NOW).ease, 1.3);
    assert.equal(nextSrs(srs({ ease: 1.3 }), wrong(), NOW).ease, 1.3);
    let s = null;
    for (let i = 0; i < 20; i++) s = nextSrs(s, wrong(), NOW);
    assert.equal(s.ease, MIN_EASE);
    assert.equal(s.lapses, 20);
  });

  test('ease never drops below 1.3 on a slow answer', () => {
    assert.equal(nextSrs(srs({ ease: 1.3 }), right(LONG_MS), NOW).ease, 1.3);
    assert.equal(nextSrs(srs({ ease: 1.32 }), right(LONG_MS), NOW).ease, 1.3);
  });

  test('ease never rises above 3.0', () => {
    assert.equal(nextSrs(srs({ ease: 3.0 }), right(QUICK_MS), NOW).ease, 3.0);
    assert.equal(nextSrs(srs({ ease: 2.98 }), right(QUICK_MS), NOW).ease, 3.0);
    let s = null;
    for (let i = 0; i < 30; i++) s = nextSrs(s, right(QUICK_MS), NOW);
    assert.equal(s.ease, MAX_EASE);
  });

  test('repeated ±0.05 steps stay on 2 decimals (no float drift)', () => {
    let s = null;
    const seen = [];
    for (let i = 0; i < 9; i++) {
      s = nextSrs(s, right(QUICK_MS), NOW);
      seen.push(s.ease);
    }
    assert.deepEqual(seen, [2.55, 2.6, 2.65, 2.7, 2.75, 2.8, 2.85, 2.9, 2.95]);
    for (let i = 0; i < 4; i++) {
      s = nextSrs(s, right(LONG_MS), NOW);
      assert.equal(s.ease, Math.round(s.ease * 100) / 100);
    }
    assert.equal(s.ease, 2.75);
  });

  test('a stored ease out of range is clamped before use', () => {
    assert.equal(nextSrs(srs({ ease: 9 }), right(), NOW).ease, 3.0);
    assert.equal(nextSrs(srs({ ease: 0.2 }), right(), NOW).ease, 1.3);
    // Third review: interval computed with the clamped ease (10 × 3.0).
    assert.equal(nextSrs(srs({ ease: 9, reps: 2, interval: 10 }), right(), NOW).interval, 30);
  });
});

describe('nextSrs: speed thresholds', () => {
  test('exactly 20 s is not fast; just under is', () => {
    assert.equal(nextSrs(null, right(FAST_MS), NOW).ease, 2.5);
    assert.equal(nextSrs(null, right(FAST_MS - 1), NOW).ease, 2.55);
    assert.equal(nextSrs(null, right(0), NOW).ease, 2.55);
  });

  test('exactly 90 s is not slow; just over is', () => {
    assert.equal(nextSrs(null, right(SLOW_MS), NOW).ease, 2.5);
    assert.equal(nextSrs(null, right(SLOW_MS + 1), NOW).ease, 2.45);
  });

  test('unknown or invalid time counts as neither fast nor slow', () => {
    for (const ms of [undefined, null, NaN, -5, Infinity, '5000']) {
      assert.equal(nextSrs(null, { correct: true, ms }, NOW).ease, 2.5, `ms=${String(ms)}`);
    }
    assert.equal(nextSrs(null, { correct: true }, NOW).ease, 2.5);
  });
});

describe('nextSrs: due times', () => {
  test('due = now + interval days on success', () => {
    const s = nextSrs(srs({ reps: 3, interval: 10, ease: 2.0 }), right(), NOW);
    assert.equal(s.interval, 20);
    assert.equal(s.due, NOW + 20 * DAY_MS);
  });

  test('due counts from the answer time, not the old due time', () => {
    const late = NOW + 5 * DAY_MS;
    const s = nextSrs(srs({ due: NOW, reps: 1, interval: 1 }), right(), late);
    assert.equal(s.due, late + 3 * DAY_MS);
  });

  test('due = now + 10 minutes on a lapse', () => {
    assert.equal(nextSrs(srs({ reps: 3, interval: 8 }), wrong(), NOW).due, NOW + 10 * 60 * 1000);
  });

  test('now defaults to Date.now()', () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    try {
      assert.equal(nextSrs(null, right()).due, NOW + DAY_MS);
      assert.equal(nextSrs(null, wrong()).due, NOW + RELEARN_DELAY_MS);
      assert.equal(nextSrs(null, right(), NaN).due, NOW + DAY_MS);
    } finally {
      mock.timers.reset();
    }
  });
});

describe('nextSrs: robustness', () => {
  test('never changes its input', () => {
    const prev = Object.freeze(srs({ reps: 2, interval: 3, ease: 2.4, lapses: 1 }));
    const copy = { ...prev };
    const a = nextSrs(prev, right(QUICK_MS), NOW);
    const b = nextSrs(prev, wrong(), NOW);
    assert.deepEqual(prev, copy);
    assert.notEqual(a, prev);
    assert.notEqual(b, prev);
  });

  test('returns exactly the five schedule fields', () => {
    const s = nextSrs({ ...srs({ reps: 1, interval: 1 }), extra: 'x' }, right(), NOW);
    assert.deepEqual(Object.keys(s).sort(), ['due', 'ease', 'interval', 'lapses', 'reps']);
  });

  test('tolerates corrupted stored fields (old or damaged backups)', () => {
    const s = nextSrs({ due: 'x', interval: -4, ease: 'easy', reps: -2, lapses: 2.7 }, right(), NOW);
    assert.deepEqual(s, { due: NOW + DAY_MS, interval: 1, ease: 2.5, reps: 1, lapses: 2 });
    const w = nextSrs({ reps: 3.9, lapses: -1, ease: NaN }, wrong(), NOW);
    assert.deepEqual(w, { due: NOW + RELEARN_DELAY_MS, interval: 0, ease: 2.3, reps: 0, lapses: 1 });
  });

  test('a fractional stored interval is rounded before use', () => {
    // reps 2 → 3: round(round(2.6) × 2.5) = round(7.5) = 8
    assert.equal(nextSrs(srs({ reps: 2, interval: 2.6 }), right(), NOW).interval, 8);
  });

  test('a non-object prev counts as never scheduled', () => {
    for (const prev of ['x', 42, true]) {
      assert.deepEqual(nextSrs(/** @type {any} */ (prev), right(), NOW), nextSrs(null, right(), NOW));
    }
  });

  test('a missing or malformed result counts as wrong', () => {
    assert.equal(nextSrs(null, /** @type {any} */ (null), NOW).lapses, 1);
    assert.equal(nextSrs(null, /** @type {any} */ ({}), NOW).lapses, 1);
    assert.equal(nextSrs(null, { correct: 0 }, NOW).reps, 0);
  });
});

describe('isDue', () => {
  test('null, undefined and non-objects are never due (new, not a review)', () => {
    assert.equal(isDue(null, NOW), false);
    assert.equal(isDue(undefined, NOW), false);
    assert.equal(isDue(/** @type {any} */ ('x'), NOW), false);
    assert.equal(isDue(/** @type {any} */ (5), NOW), false);
  });

  test('due when the due time has passed or is now', () => {
    assert.equal(isDue(srs({ due: NOW - 1 }), NOW), true);
    assert.equal(isDue(srs({ due: NOW }), NOW), true);
    assert.equal(isDue(srs({ due: NOW + 1 }), NOW), false);
  });

  test('a missing or invalid due time is never due', () => {
    assert.equal(isDue({}, NOW), false);
    assert.equal(isDue(/** @type {any} */ ({ due: 'yesterday' }), NOW), false);
    assert.equal(isDue({ due: NaN }, NOW), false);
    assert.equal(isDue({ due: -Infinity }, NOW), false);
  });

  test('follows a schedule: a lapse is due after 10 minutes, a success after its interval', () => {
    const lapse = nextSrs(null, wrong(), NOW);
    assert.equal(isDue(lapse, NOW + RELEARN_DELAY_MS - 1), false);
    assert.equal(isDue(lapse, NOW + RELEARN_DELAY_MS), true);
    const ok = nextSrs(null, right(), NOW);
    assert.equal(isDue(ok, NOW + DAY_MS - 1), false);
    assert.equal(isDue(ok, NOW + DAY_MS), true);
  });

  test('now defaults to Date.now()', () => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    try {
      assert.equal(isDue(srs({ due: NOW - 1 })), true);
      assert.equal(isDue(srs({ due: NOW + 1 })), false);
    } finally {
      mock.timers.reset();
    }
  });
});
