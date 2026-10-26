// Unit tests for js/features/annotate/anchor.js (pure parts). Run: node --test tests/unit/
// DOM parts (blockText, textOffsetsInElement, rangeFromOffsets) are checked in the browser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeAnchor, findAnchor, CONTEXT_LENGTH } from '../../js/features/annotate/anchor.js';

/** Anchor then find in the same text → same span. */
function roundTrip(text, start, end) {
  const a = makeAnchor(text, start, end);
  return { a, found: findAnchor(text, a) };
}

describe('makeAnchor', () => {
  test('basic quote and context', () => {
    assert.deepEqual(makeAnchor('one two three', 4, 7), { quote: 'two', prefix: 'one ', suffix: ' three', start: 4 });
  });

  test('context is limited to 32 characters each side', () => {
    assert.equal(CONTEXT_LENGTH, 32);
    const text = 'a'.repeat(100) + 'QUOTE' + 'b'.repeat(100);
    const a = makeAnchor(text, 100, 105);
    assert.equal(a.quote, 'QUOTE');
    assert.equal(a.prefix, 'a'.repeat(32));
    assert.equal(a.suffix, 'b'.repeat(32));
    assert.equal(a.start, 100);
  });

  test('quote at the very start and end of the block', () => {
    assert.deepEqual(makeAnchor('alpha beta', 0, 5), { quote: 'alpha', prefix: '', suffix: ' beta', start: 0 });
    assert.deepEqual(makeAnchor('alpha beta', 6, 10), { quote: 'beta', prefix: 'alpha ', suffix: '', start: 6 });
    assert.deepEqual(makeAnchor('alpha', 0, 5), { quote: 'alpha', prefix: '', suffix: '', start: 0 });
  });

  test('reversed offsets are swapped', () => {
    assert.deepEqual(makeAnchor('one two three', 7, 4), makeAnchor('one two three', 4, 7));
  });

  test('out-of-range and non-numeric offsets are clamped', () => {
    assert.deepEqual(makeAnchor('abc', -5, 99), { quote: 'abc', prefix: '', suffix: '', start: 0 });
    assert.deepEqual(makeAnchor('abc', 10, 20), { quote: '', prefix: 'abc', suffix: '', start: 3 });
    assert.deepEqual(makeAnchor('abc', NaN, 2), { quote: 'ab', prefix: '', suffix: 'c', start: 0 });
    assert.deepEqual(makeAnchor('abc', 1.7, 2.2), { quote: 'b', prefix: 'a', suffix: 'c', start: 1 });
  });

  test('empty text and empty span', () => {
    assert.deepEqual(makeAnchor('', 0, 0), { quote: '', prefix: '', suffix: '', start: 0 });
    assert.deepEqual(makeAnchor('abc', 1, 1), { quote: '', prefix: 'a', suffix: 'bc', start: 1 });
    assert.deepEqual(makeAnchor(undefined, 0, 3), { quote: '', prefix: '', suffix: '', start: 0 });
  });

  test('never splits a surrogate pair (emoji)', () => {
    const text = 'x😀y';
    // 😀 is two UTF-16 units at 1..3; offsets 2 split it.
    assert.equal(makeAnchor(text, 2, 3).quote, '😀');
    assert.equal(makeAnchor(text, 1, 2).quote, '😀');
    assert.equal(makeAnchor(text, 0, 2).quote, 'x😀');
  });

  test('context never starts or ends with half a character', () => {
    const emoji = '😀';
    // Put an emoji so that the 32-char prefix window would start inside it.
    const before = emoji + 'p'.repeat(31);
    const after = 's'.repeat(31) + emoji;
    const text = before + 'Q' + after;
    const a = makeAnchor(text, before.length, before.length + 1);
    assert.equal(a.quote, 'Q');
    assert.equal(a.prefix, 'p'.repeat(31));
    assert.equal(a.suffix, 's'.repeat(31));
    assert.ok(!/[\uD800-\uDFFF]/.test(a.prefix + a.suffix));
  });
});

describe('findAnchor: unchanged text', () => {
  test('round trip returns the same span', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    for (const [s, e] of [
      [0, 3],
      [4, 9],
      [10, 15],
      [40, 44],
      [0, text.length],
    ]) {
      assert.deepEqual(roundTrip(text, s, e).found, { start: s, end: e }, `${s}-${e}`);
    }
  });

  test('repeated words: each occurrence finds itself', () => {
    const text = 'cat dog cat dog cat dog cat';
    let pos = text.indexOf('cat');
    while (pos !== -1) {
      assert.deepEqual(roundTrip(text, pos, pos + 3).found, { start: pos, end: pos + 3 });
      pos = text.indexOf('cat', pos + 1);
    }
  });

  test('long runs of the same character', () => {
    const text = 'a'.repeat(200);
    assert.deepEqual(roundTrip(text, 50, 60).found, { start: 50, end: 60 });
  });

  test('unicode text', () => {
    const text = 'Ünïcödé — “quoted” 😀 text → arrows, café, naïve, 日本語.';
    const s = text.indexOf('😀');
    assert.deepEqual(roundTrip(text, s, s + 2).found, { start: s, end: s + 2 });
    const t = text.indexOf('café');
    assert.deepEqual(roundTrip(text, t, t + 4).found, { start: t, end: t + 4 });
    const j = text.indexOf('日本語');
    assert.deepEqual(roundTrip(text, j, j + 3).found, { start: j, end: j + 3 });
  });
});

describe('findAnchor: edited text', () => {
  const original = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
  const s = original.indexOf('epsilon');
  const anchor = makeAnchor(original, s, s + 'epsilon'.length);

  test('text inserted before the quote', () => {
    const edited = 'New opening sentence. ' + original;
    const found = findAnchor(edited, anchor);
    assert.deepEqual(found, { start: s + 22, end: s + 22 + 7 });
    assert.equal(edited.slice(found.start, found.end), 'epsilon');
  });

  test('text removed before the quote', () => {
    const edited = original.replace('Alpha beta gamma. ', '');
    const found = findAnchor(edited, anchor);
    assert.equal(edited.slice(found.start, found.end), 'epsilon');
  });

  test('text appended after the quote', () => {
    const edited = original + ' Kappa lambda.';
    assert.deepEqual(findAnchor(edited, anchor), { start: s, end: s + 7 });
  });

  test('text changed right after the quote (context partly differs)', () => {
    const edited = original.replace('epsilon zeta', 'epsilon ZETA');
    assert.deepEqual(findAnchor(edited, anchor), { start: s, end: s + 7 });
  });

  test('quote removed → null', () => {
    assert.equal(findAnchor(original.replace('epsilon', 'omega'), anchor), null);
  });

  test('quote changed → null', () => {
    assert.equal(findAnchor(original.replace('epsilon', 'epsilom'), anchor), null);
  });

  test('repeats: the occurrence with the matching context wins over the one at start', () => {
    const text = 'red one. blue one. green one.';
    const at = text.indexOf('one', text.indexOf('blue'));
    const a = makeAnchor(text, at, at + 3);
    // Insert text so another "one" moves to the old offset.
    const edited = 'one. ' + text;
    const found = findAnchor(edited, a);
    assert.equal(found.start, at + 5);
    assert.equal(edited.slice(found.start - 5, found.start), 'blue ');
  });

  test('repeats: an occurrence still at start with a near-equal context keeps its place', () => {
    const text = 'x one y one z';
    const a = makeAnchor(text, 2, 5); // first "one", prefix "x ", suffix " y one z"
    const found = findAnchor(text.replace(' z', ' w'), a);
    assert.deepEqual(found, { start: 2, end: 5 });
  });

  test('repeats with identical context: nearest to the old offset wins', () => {
    const text = 'ab ab ab ab ab ab ab ab ab ab';
    const a = { quote: 'ab', prefix: 'ab ', suffix: ' ab', start: 13 };
    const found = findAnchor(text, a);
    assert.ok(found.start === 12 || found.start === 15, `got ${found.start}`);
  });

  test('quote at the block edges after an edit elsewhere', () => {
    const text = 'Start word and the end';
    const a = makeAnchor(text, 0, 5);
    assert.deepEqual(findAnchor('Start word and a new end', a), { start: 0, end: 5 });
    const b = makeAnchor(text, text.length - 3, text.length);
    const edited = 'Start word, and the end';
    assert.deepEqual(findAnchor(edited, b), { start: edited.length - 3, end: edited.length });
  });

  test('whitespace changes are tolerated', () => {
    const text = 'one two  three four';
    const a = makeAnchor(text, 4, 14); // "two  three"
    assert.equal(a.quote, 'two  three');
    const edited = 'one two three four';
    const found = findAnchor(edited, a);
    assert.ok(found, 'found');
    assert.equal(edited.slice(found.start, found.end), 'two three');
  });

  test('no-break spaces and newlines count as spaces', () => {
    const a = makeAnchor('alpha beta gamma', 6, 16); // "beta gamma"
    const edited = 'alpha beta gamma';
    const found = findAnchor(edited, a);
    assert.equal(edited.slice(found.start, found.end), 'beta gamma');
    const edited2 = 'alpha\nbeta\n gamma';
    const found2 = findAnchor(edited2, a);
    assert.equal(edited2.slice(found2.start, found2.end), 'beta\n gamma');
  });
});

describe('findAnchor: bad input', () => {
  test('missing or empty anchor → null', () => {
    assert.equal(findAnchor('text', null), null);
    assert.equal(findAnchor('text', undefined), null);
    assert.equal(findAnchor('text', {}), null);
    assert.equal(findAnchor('text', { quote: '' }), null);
    assert.equal(findAnchor('text', { quote: 42 }), null);
    assert.equal(findAnchor('text', 'text'), null);
  });

  test('whitespace-only quote that does not occur → null', () => {
    assert.equal(findAnchor('abc', { quote: '  ', prefix: '', suffix: '', start: 0 }), null);
  });

  test('empty or missing text → null', () => {
    assert.equal(findAnchor('', { quote: 'a', prefix: '', suffix: '', start: 0 }), null);
    assert.equal(findAnchor(undefined, { quote: 'a', prefix: '', suffix: '', start: 0 }), null);
  });

  test('out-of-range or missing start still finds the quote', () => {
    assert.deepEqual(findAnchor('hello world', { quote: 'world', prefix: 'hello ', suffix: '', start: 999 }), {
      start: 6,
      end: 11,
    });
    assert.deepEqual(findAnchor('hello world', { quote: 'world', start: -4 }), { start: 6, end: 11 });
    assert.deepEqual(findAnchor('hello world', { quote: 'world' }), { start: 6, end: 11 });
    assert.deepEqual(findAnchor('hello world', { quote: 'world', prefix: null, suffix: 7, start: 'x' }), {
      start: 6,
      end: 11,
    });
  });

  test('quote longer than text → null', () => {
    assert.equal(findAnchor('ab', { quote: 'abc', prefix: '', suffix: '', start: 0 }), null);
  });

  test('a block with thousands of occurrences stays fast and finds one', () => {
    const text = 'ab '.repeat(20000);
    const t0 = Date.now();
    const found = findAnchor(text, { quote: 'ab', prefix: 'ab ', suffix: ' ab', start: 30000 });
    assert.ok(found);
    assert.ok(Date.now() - t0 < 500);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers of js/features/annotate/highlight.js (the DOM part is checked by tests/visual/highlight.mjs).
// ---------------------------------------------------------------------------

const { blockExists, trimSpan, HIGHLIGHT_COLORS } = await import('../../js/features/annotate/highlight.js');

describe('highlight helpers', () => {
  const q = {
    id: 'DEMO-0001',
    version: 2,
    choices: [{ id: 'a', text: 'Alpha' }, { id: 'b', text: 'Beta' }],
    choiceNotes: { a: 'Why alpha' },
    explanation: [{ id: 'p1', type: 'p', text: 'Sample' }, { id: 'tbl', type: 'table', head: [], rows: [] }],
  };

  test('colors are the four contract colors in order', () => {
    assert.deepEqual([...HIGHLIGHT_COLORS], ['yellow', 'green', 'blue', 'pink']);
  });

  test('blockExists: stem, choices, notes and explanation blocks', () => {
    assert.equal(blockExists(q, 'stem'), true);
    assert.equal(blockExists(q, 'choice-a'), true);
    assert.equal(blockExists(q, 'choice-e'), false);
    assert.equal(blockExists(q, 'note-a'), true);
    assert.equal(blockExists(q, 'note-b'), false);
    assert.equal(blockExists(q, 'p1'), true);
    assert.equal(blockExists(q, 'tbl'), true);
    assert.equal(blockExists(q, 'gone'), false);
  });

  test('blockExists: bad input', () => {
    assert.equal(blockExists(null, 'stem'), false);
    assert.equal(blockExists(q, undefined), false);
    assert.equal(blockExists({ id: 'x' }, 'choice-a'), false);
    assert.equal(blockExists({ id: 'x' }, 'p1'), false);
  });

  test('trimSpan drops whitespace at both ends', () => {
    assert.deepEqual(trimSpan('one two  three', 3, 9), { start: 4, end: 7 });
    assert.deepEqual(trimSpan('a \nb', 1, 3), { start: 3, end: 3 });
    assert.deepEqual(trimSpan('abc', 0, 3), { start: 0, end: 3 });
    assert.deepEqual(trimSpan('   ', 0, 3), { start: 3, end: 3 });
  });
});
