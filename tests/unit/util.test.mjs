// Unit tests for js/core/util.js (pure helpers). Run: node --test tests/unit/
import { test, describe, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  uid,
  hashString,
  seededRandom,
  shuffle,
  clamp,
  debounce,
  throttle,
  sleep,
  formatDuration,
  formatRelative,
  formatDate,
  formatNumber,
  dayKey,
  startOfDay,
  addDays,
  plural,
  pct,
  escapeRegExp,
  MINUTE_MS,
  HOUR_MS,
  DAY_MS,
} from '../../js/core/util.js';

/** Reference FNV-1a over TextEncoder bytes. */
function fnv1aReference(s) {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

describe('uid', () => {
  test('is URL-safe lowercase alphanumeric with a fixed length', () => {
    const id = uid();
    assert.match(id, /^[0-9a-z]{19}$/);
  });

  test('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uid()));
    assert.equal(ids.size, 5000);
  });

  test('sorts by creation time (time prefix)', () => {
    const now = Date.now();
    mock.timers.enable({ apis: ['Date'], now });
    try {
      const a = uid();
      mock.timers.tick(5);
      const b = uid();
      assert.ok(a.slice(0, 9) < b.slice(0, 9));
    } finally {
      mock.timers.reset();
    }
  });
});

describe('hashString (FNV-1a 32-bit)', () => {
  test('matches published test vectors', () => {
    assert.equal(hashString(''), 0x811c9dc5);
    assert.equal(hashString('a'), 0xe40c292c);
    assert.equal(hashString('foobar'), 0xbf9cf968);
  });

  test('returns an unsigned 32-bit integer', () => {
    for (const s of ['x', 'CPB-0001', 'a much longer string with spaces']) {
      const h = hashString(s);
      assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff);
    }
  });

  test('hashes UTF-8 bytes like TextEncoder (incl. emoji and lone surrogates)', () => {
    const samples = ['é', 'ß→⇒', 'Δ pressure ↑', '🫀 heart', 'mixed 漢字 text', '\ud800', 'a\udc00b', '\ud83d'];
    for (const s of samples) assert.equal(hashString(s), fnv1aReference(s), JSON.stringify(s));
  });

  test('coerces non-strings', () => {
    assert.equal(hashString(123), hashString('123'));
    assert.equal(hashString(null), hashString(''));
    assert.equal(hashString(undefined), hashString(''));
  });
});

describe('seededRandom (mulberry32)', () => {
  test('is deterministic for the same seed', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
  });

  test('differs for different seeds', () => {
    const a = seededRandom(1);
    const b = seededRandom(2);
    const seqA = Array.from({ length: 5 }, a);
    const seqB = Array.from({ length: 5 }, b);
    assert.notDeepEqual(seqA, seqB);
  });

  test('produces floats in [0, 1) with a sane distribution', () => {
    const r = seededRandom(7);
    let sum = 0;
    const buckets = new Array(10).fill(0);
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = r();
      assert.ok(v >= 0 && v < 1);
      sum += v;
      buckets[Math.floor(v * 10)]++;
    }
    assert.ok(Math.abs(sum / n - 0.5) < 0.02);
    for (const c of buckets) assert.ok(c > n / 10 - 400 && c < n / 10 + 400);
  });

  test('accepts string and float seeds (hashed) deterministically', () => {
    assert.equal(seededRandom('session-1')(), seededRandom('session-1')());
    assert.notEqual(seededRandom('session-1')(), seededRandom('session-2')());
    assert.notEqual(seededRandom(0.25)(), seededRandom(0.75)());
  });

  test('matches the reference mulberry32 first value for seed 1', () => {
    // Reference implementation, inlined to pin the algorithm.
    let a = 1;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const expected = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    assert.equal(seededRandom(1)(), expected);
  });
});

describe('shuffle', () => {
  test('returns a new array with the same elements and leaves the input untouched', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const copy = input.slice();
    const out = shuffle(input, seededRandom(3));
    assert.notEqual(out, input);
    assert.deepEqual(input, copy);
    assert.deepEqual(out.slice().sort((x, y) => x - y), copy);
  });

  test('is deterministic with a seeded generator', () => {
    const a = shuffle(['a', 'b', 'c', 'd', 'e'], seededRandom('x'));
    const b = shuffle(['a', 'b', 'c', 'd', 'e'], seededRandom('x'));
    assert.deepEqual(a, b);
  });

  test('handles empty, single and iterable inputs', () => {
    assert.deepEqual(shuffle([]), []);
    assert.deepEqual(shuffle([1]), [1]);
    assert.deepEqual(shuffle(new Set([1, 2, 3])).sort(), [1, 2, 3]);
    assert.deepEqual(shuffle(null), []);
  });

  test('survives a generator returning 1, NaN or negatives', () => {
    for (const bad of [() => 1, () => NaN, () => -0.5]) {
      const out = shuffle([1, 2, 3, 4], bad);
      assert.deepEqual(out.slice().sort(), [1, 2, 3, 4]);
    }
  });

  test('is roughly uniform (every position reached by every element)', () => {
    const rand = seededRandom(99);
    const counts = Array.from({ length: 4 }, () => new Array(4).fill(0));
    for (let i = 0; i < 8000; i++) {
      shuffle([0, 1, 2, 3], rand).forEach((v, pos) => counts[v][pos]++);
    }
    for (const row of counts) for (const c of row) assert.ok(c > 1700 && c < 2300, `count ${c}`);
  });
});

describe('clamp', () => {
  test('clamps into range', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(11, 0, 10), 10);
  });
  test('treats NaN as min and swaps reversed bounds', () => {
    assert.equal(clamp(NaN, 2, 4), 2);
    assert.equal(clamp(5, 10, 0), 5);
    assert.equal(clamp(50, 10, 0), 10);
  });
});

describe('debounce', () => {
  afterEach(() => mock.timers.reset());

  test('calls once with the latest arguments after the quiet period', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const calls = [];
    const fn = debounce((...args) => calls.push(args), 300);
    fn(1);
    fn(2);
    mock.timers.tick(299);
    assert.equal(calls.length, 0);
    fn(3);
    mock.timers.tick(299);
    assert.equal(calls.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(calls, [[3]]);
  });

  test('flush() runs now and returns the result; cancel() drops the call', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    let n = 0;
    const fn = debounce((x) => {
      n++;
      return x * 2;
    }, 100);
    fn(21);
    assert.equal(fn.pending(), true);
    assert.equal(fn.flush(), 42);
    assert.equal(fn.pending(), false);
    assert.equal(fn.flush(), undefined);
    fn(1);
    fn.cancel();
    mock.timers.tick(200);
    assert.equal(n, 1);
  });

  test('keeps `this`', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const obj = {
      v: 7,
      seen: 0,
      run: debounce(function () {
        this.seen = this.v;
      }, 10),
    };
    obj.run();
    mock.timers.tick(10);
    assert.equal(obj.seen, 7);
  });
});

describe('throttle', () => {
  afterEach(() => mock.timers.reset());

  test('runs immediately, then at most once per window with the latest args', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const calls = [];
    const fn = throttle((x) => calls.push(x), 100);
    fn(1);
    fn(2);
    fn(3);
    assert.deepEqual(calls, [1]);
    mock.timers.tick(100);
    assert.deepEqual(calls, [1, 3]);
    mock.timers.tick(150);
    fn(4);
    assert.deepEqual(calls, [1, 3, 4]);
  });

  test('cancel() drops the trailing call', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const calls = [];
    const fn = throttle((x) => calls.push(x), 100);
    fn(1);
    fn(2);
    fn.cancel();
    mock.timers.tick(500);
    assert.deepEqual(calls, [1]);
  });
});

describe('sleep', () => {
  test('resolves after the delay', async () => {
    const t0 = Date.now();
    await sleep(20);
    assert.ok(Date.now() - t0 >= 15);
  });

  test('rejects when aborted', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (err) => err.name === 'AbortError');
  });

  test('rejects immediately for an already-aborted signal', async () => {
    await assert.rejects(sleep(10, { signal: AbortSignal.abort() }));
  });
});

describe('formatDuration', () => {
  test('formats minutes and hours', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(5_000), '0:05');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(65_999), '1:05');
    assert.equal(formatDuration(600_000), '10:00');
    assert.equal(formatDuration(3_723_000), '1:02:03');
    assert.equal(formatDuration(36_000_000), '10:00:00');
  });
  test('handles invalid input', () => {
    assert.equal(formatDuration(-5), '0:00');
    assert.equal(formatDuration(NaN), '0:00');
    assert.equal(formatDuration(undefined), '0:00');
  });
});

describe('dayKey / startOfDay / addDays', () => {
  test('dayKey uses local time and zero-pads', () => {
    assert.equal(dayKey(new Date(2026, 2, 5, 23, 59).getTime()), '2026-03-05');
    assert.equal(dayKey(new Date(2026, 11, 31, 0, 0)), '2026-12-31');
    assert.equal(dayKey(NaN), '');
  });
  test('startOfDay is local midnight', () => {
    const ts = new Date(2026, 4, 10, 15, 30).getTime();
    assert.equal(startOfDay(ts), new Date(2026, 4, 10).getTime());
  });
  test('addDays moves calendar days and crosses months/years', () => {
    const ts = new Date(2026, 11, 31, 9, 0).getTime();
    assert.equal(dayKey(addDays(ts, 1)), '2027-01-01');
    assert.equal(dayKey(addDays(ts, -31)), '2026-11-30');
    assert.equal(new Date(addDays(ts, 1)).getHours(), 9);
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 2, 12, 15, 0).getTime(); // 12 Mar 2026, 15:00 local

  test('past', () => {
    assert.equal(formatRelative(now, now), 'just now');
    assert.equal(formatRelative(now - 30_000, now), 'just now');
    assert.equal(formatRelative(now - 5 * MINUTE_MS, now), '5 min ago');
    assert.equal(formatRelative(now - 59 * MINUTE_MS, now), '59 min ago');
    assert.equal(formatRelative(now - 3 * HOUR_MS, now), '3 h ago');
    assert.equal(formatRelative(new Date(2026, 2, 11, 9, 0).getTime(), now), 'yesterday');
    assert.equal(formatRelative(new Date(2026, 2, 1, 9, 0).getTime(), now), '1 Mar');
    assert.equal(formatRelative(new Date(2025, 11, 25).getTime(), now), '25 Dec 2025');
  });

  test('recent hours across midnight still read as hours', () => {
    const justAfterMidnight = new Date(2026, 2, 12, 0, 30).getTime();
    assert.equal(formatRelative(justAfterMidnight - 2 * HOUR_MS, justAfterMidnight), '2 h ago');
  });

  test('future', () => {
    assert.equal(formatRelative(now + 10 * MINUTE_MS, now), 'in 10 min');
    assert.equal(formatRelative(now + 3 * HOUR_MS, now), 'in 3 h');
    assert.equal(formatRelative(new Date(2026, 2, 13, 9, 0).getTime(), now), 'tomorrow');
    assert.equal(formatRelative(new Date(2026, 2, 20).getTime(), now), '20 Mar');
  });

  test('defaults `now` to the current time and handles bad input', () => {
    assert.equal(formatRelative(Date.now()), 'just now');
    assert.equal(formatRelative(NaN, now), '');
  });

  test('formatDate adds the year only when it differs', () => {
    assert.equal(formatDate(new Date(2026, 0, 2), now), '2 Jan');
    assert.equal(formatDate(new Date(2024, 6, 9), now), '9 Jul 2024');
  });
});

describe('plural / formatNumber', () => {
  test('includes the count and picks the form', () => {
    assert.equal(plural(0, 'question'), '0 questions');
    assert.equal(plural(1, 'question'), '1 question');
    assert.equal(plural(2, 'question'), '2 questions');
    assert.equal(plural(5000, 'question'), '5,000 questions');
    assert.equal(plural(3, 'child', 'children'), '3 children');
    assert.equal(plural(1, 'child', 'children'), '1 child');
  });
  test('formatNumber groups digits', () => {
    assert.equal(formatNumber(1234567), '1,234,567');
    assert.equal(formatNumber(12), '12');
    assert.equal(formatNumber(NaN), '0');
  });
});

describe('pct', () => {
  test('rounds to an integer percentage', () => {
    assert.equal(pct(1, 2), 50);
    assert.equal(pct(1, 3), 33);
    assert.equal(pct(2, 3), 67);
    assert.equal(pct(3, 3), 100);
  });
  test('guards zero, negative and invalid denominators', () => {
    assert.equal(pct(0, 0), 0);
    assert.equal(pct(5, 0), 0);
    assert.equal(pct(5, -1), 0);
    assert.equal(pct(NaN, 10), 0);
    assert.equal(pct(0, 10), 0);
  });
  test('clamps to 0..100 and stays honest at the edges', () => {
    assert.equal(pct(15, 10), 100);
    assert.equal(pct(199, 200), 99); // not "100%" while one is missing
    assert.equal(pct(1, 1000), 1); // not "0%" when one is correct
  });
});

describe('escapeRegExp', () => {
  test('escapes special characters', () => {
    const s = 'a.b*c?(d)[e]{f}|g^h$i\\j+k';
    assert.ok(new RegExp(`^${escapeRegExp(s)}$`).test(s));
  });
});

test('time constants', () => {
  assert.equal(MINUTE_MS, 60_000);
  assert.equal(HOUR_MS, 3_600_000);
  assert.equal(DAY_MS, 86_400_000);
});
