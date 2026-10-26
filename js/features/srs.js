/**
 * Spaced repetition scheduling (docs/ARCHITECTURE.md §7.1).
 *
 * An SM-2 variant with automatic grading: the learner never rates a card.
 * The grade comes from correctness and answer time.
 *
 * - Wrong: `reps = 0`, `lapses + 1`, `interval = 0`, due again in 10 minutes,
 *   `ease = max(1.3, ease - 0.2)`.
 * - Right: `reps + 1`; the new interval is 1 day after the first success,
 *   3 days after the second, then `round(previous interval × ease)` days
 *   (using the ease in effect before this answer). Due `interval` days from now.
 *   A fast answer (under 20 s) adds 0.05 to the ease (max 3.0); a slow one
 *   (over 90 s) takes 0.05 away (min 1.3).
 *
 * Pure: no I/O, no DOM, no clock reads unless `now` is omitted.
 *
 * @module features/srs
 */

/**
 * @typedef {object} Srs
 * @property {number} due       Timestamp (ms) when the question is due again.
 * @property {number} interval  Current interval in days (0 after a lapse).
 * @property {number} ease      Ease factor, 1.3 – 3.0.
 * @property {number} reps      Successful reviews in a row.
 * @property {number} lapses    Total number of wrong answers.
 */

/** Starting ease of a question that has never been scheduled. */
export const DEFAULT_EASE = 2.5;
/** Lowest allowed ease. */
export const MIN_EASE = 1.3;
/** Highest allowed ease. */
export const MAX_EASE = 3.0;
/** Ease change for a wrong answer. */
export const LAPSE_EASE_PENALTY = 0.2;
/** Ease change for a fast or slow right answer. */
export const SPEED_EASE_STEP = 0.05;
/** A right answer faster than this counts as easy. */
export const FAST_MS = 20 * 1000;
/** A right answer slower than this counts as hard. */
export const SLOW_MS = 90 * 1000;
/** A wrong answer comes back after this delay. */
export const RELEARN_DELAY_MS = 10 * 60 * 1000;
/** One scheduling day. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rounds an ease to 2 decimals so repeated ±0.05 steps never drift (2.55, not 2.5500000000000003).
 * @param {number} e
 * @returns {number}
 */
function roundEase(e) {
  return Math.round(e * 100) / 100;
}

/**
 * @param {number} e
 * @returns {number}
 */
function clampEase(e) {
  return roundEase(Math.min(MAX_EASE, Math.max(MIN_EASE, e)));
}

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Cleans a stored schedule (tolerates missing or corrupted fields, e.g. from an old backup).
 * @param {Partial<Srs> | null | undefined} prev
 * @param {number} now
 * @returns {Srs}
 */
function sanitize(prev, now) {
  const p = prev && typeof prev === 'object' ? prev : {};
  return {
    due: finiteOr(p.due, now),
    interval: Math.max(0, Math.round(finiteOr(p.interval, 0))),
    ease: clampEase(finiteOr(p.ease, DEFAULT_EASE)),
    reps: Math.max(0, Math.floor(finiteOr(p.reps, 0))),
    lapses: Math.max(0, Math.floor(finiteOr(p.lapses, 0))),
  };
}

/**
 * Computes the next schedule of a question after an answer.
 *
 * @param {Srs | null | undefined} prev The current schedule, or null for a question never scheduled.
 * @param {{ correct: boolean, ms?: number }} result Whether the answer was right and how long it took
 *   (ms; unknown or invalid time counts as neither fast nor slow).
 * @param {number} [now] Answer time (ms). Defaults to `Date.now()`.
 * @returns {Srs} A new schedule object (the input is never changed).
 * @example
 * let s = nextSrs(null, { correct: true, ms: 15000 }, now); // reps 1, interval 1, ease 2.55
 * s = nextSrs(s, { correct: false, ms: 30000 }, now);        // reps 0, lapses 1, due in 10 min
 */
export function nextSrs(prev, result, now = Date.now()) {
  const t = finiteOr(now, Date.now());
  const p = sanitize(prev, t);
  const correct = Boolean(result && result.correct);
  const ms = result && typeof result.ms === 'number' && Number.isFinite(result.ms) && result.ms >= 0 ? result.ms : null;

  if (!correct) {
    return {
      due: t + RELEARN_DELAY_MS,
      interval: 0,
      ease: clampEase(p.ease - LAPSE_EASE_PENALTY),
      reps: 0,
      lapses: p.lapses + 1,
    };
  }

  const reps = p.reps + 1;
  let interval;
  if (reps === 1) interval = 1;
  else if (reps === 2) interval = 3;
  else interval = Math.max(1, Math.round(p.interval * p.ease));

  let ease = p.ease;
  if (ms !== null && ms < FAST_MS) ease += SPEED_EASE_STEP;
  else if (ms !== null && ms > SLOW_MS) ease -= SPEED_EASE_STEP;

  return {
    due: t + interval * DAY_MS,
    interval,
    ease: clampEase(ease),
    reps,
    lapses: p.lapses,
  };
}

/**
 * True when a scheduled question is due (its due time has passed).
 * A missing schedule is never due (the question is new, not a review).
 *
 * @param {Srs | null | undefined} srs
 * @param {number} [now] Defaults to `Date.now()`.
 * @returns {boolean}
 */
export function isDue(srs, now = Date.now()) {
  if (!srs || typeof srs !== 'object') return false;
  const due = srs.due;
  return typeof due === 'number' && Number.isFinite(due) && due <= now;
}
