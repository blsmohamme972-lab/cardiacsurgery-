// Unit tests for the pure helpers of js/features/book/viewer.js and js/features/book/pdf.js.
// Run: node --test tests/unit/
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../../js/features/book/viewer.js';
import { PdfError, toPdfError, cleanText, flattenOutline, PDFJS_VERSION } from '../../js/features/book/pdf.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const LETTER = { w: 612, h: 792 };
const SP = { gap: 10, padX: 8, padY: 10 };
const pages = (n, size = LETTER) => Array.from({ length: n }, () => ({ ...size }));

describe('fit + layout', () => {
  test('clampScale', () => {
    assert.equal(v.clampScale(0.01), v.MIN_SCALE);
    assert.equal(v.clampScale(100), v.MAX_SCALE);
    assert.equal(v.clampScale(1.5), 1.5);
    assert.equal(v.clampScale(NaN), 1);
  });

  test('spacingFor: thin margins on phones', () => {
    assert.ok(v.spacingFor(390).padX < v.spacingFor(834).padX);
    assert.deepEqual(Object.keys(v.spacingFor(390)).sort(), ['gap', 'padX', 'padY']);
  });

  test('fitScale width / page', () => {
    near(v.fitScale('fit-width', LETTER, { w: 390, h: 844 }, SP), (390 - 16) / 612);
    // Portrait page on a landscape screen: the height limits fit-page.
    near(v.fitScale('fit-page', LETTER, { w: 1280, h: 800 }, SP), (800 - 20) / 792);
    // Landscape page on a phone: the width limits both.
    near(v.fitScale('fit-page', { w: 792, h: 612 }, { w: 390, h: 844 }, SP), (390 - 16) / 792);
    // Never outside the zoom range.
    assert.equal(v.fitScale('fit-width', LETTER, { w: 10, h: 10 }, SP), v.MIN_SCALE);
  });

  test('computeLayout: integer boxes, centred, gaps', () => {
    const s = (390 - 16) / 612;
    const l = v.computeLayout(pages(3), s, 390, SP);
    assert.equal(l.n, 3);
    assert.deepEqual(l.widths, [374, 374, 374]);
    assert.equal(l.heights[0], Math.floor(792 * s));
    assert.equal(l.tops[0], 10);
    assert.equal(l.tops[1], 10 + l.heights[0] + 10);
    assert.equal(l.totalH, l.tops[2] + l.heights[2] + 10);
    assert.equal(l.totalW, 390);
    assert.equal(l.lefts[0], 8);
    for (const x of [...l.widths, ...l.heights, ...l.tops, ...l.lefts]) assert.ok(Number.isInteger(x));
  });

  test('computeLayout: zoomed wider than the viewport, mixed sizes', () => {
    const l = v.computeLayout([LETTER, { w: 792, h: 612 }], 1, 390, SP);
    assert.equal(l.totalW, 792 + 16);
    assert.equal(l.lefts[1], 8);
    assert.equal(l.lefts[0], Math.floor((808 - 612) / 2));
  });

  test('computeLayout: empty document', () => {
    const l = v.computeLayout([], 1, 390, SP);
    assert.equal(l.n, 0);
    assert.equal(l.totalH, 20);
  });
});

describe('visible range + page tracking', () => {
  const l = v.computeLayout(pages(10), 0.5, 400, SP); // heights 396, stride 406
  test('visibleRange', () => {
    assert.deepEqual(v.visibleRange(l, 0, 500), { first: 0, last: 1 });
    assert.deepEqual(v.visibleRange(l, 406 * 3 + 10, 300), { first: 3, last: 3 });
    // Viewport starting inside the gap after page 0.
    assert.deepEqual(v.visibleRange(l, 10 + 396 + 2, 100), { first: 1, last: 1 });
    // Past the end.
    assert.deepEqual(v.visibleRange(l, 1e6, 500), { first: -1, last: -1 });
    assert.deepEqual(v.visibleRange(l, 0, 0), { first: -1, last: -1 });
    assert.deepEqual(v.visibleRange(l, 0, 1e6), { first: 0, last: 9 });
  });

  test('mostVisiblePage: largest visible part, ties → earlier', () => {
    assert.equal(v.mostVisiblePage(l, 0, 500), 0);
    // 100 px of page 0 visible, 390 of page 1.
    assert.equal(v.mostVisiblePage(l, 10 + 396 - 100, 500), 1);
    // Exactly half each (ties) → the earlier page.
    const top = 10 + 396 - 150;
    assert.equal(v.mostVisiblePage(l, top, 310), 0);
    assert.equal(v.mostVisiblePage(l, 1e6, 500), 9);
  });

  test('renderRange: visible ±1, clamped', () => {
    assert.deepEqual(v.renderRange({ first: 0, last: 1 }, 10), { first: 0, last: 2 });
    assert.deepEqual(v.renderRange({ first: 8, last: 9 }, 10), { first: 7, last: 9 });
    assert.deepEqual(v.renderRange({ first: 4, last: 4 }, 10, 2), { first: 2, last: 6 });
    assert.deepEqual(v.renderRange({ first: -1, last: -1 }, 10), { first: -1, last: -1 });
  });
});

describe('pixel budget', () => {
  test('outputScaleFor: dpr unless the budget caps it', () => {
    assert.equal(v.outputScaleFor(374, 484, 3, 5e6), 3);
    const capped = v.outputScaleFor(2000, 2600, 3, 5e6);
    near(capped, Math.sqrt(5e6 / (2000 * 2600)));
    assert.ok(2000 * 2600 * capped * capped <= 5e6 + 1);
    assert.ok(v.outputScaleFor(1e6, 1e6, 2, 1) >= 0.1);
  });

  test('canvasBudget: phones and small devices get less', () => {
    assert.ok(v.canvasBudget({ coarse: true }) < v.canvasBudget({}));
    assert.ok(v.canvasBudget({ deviceMemory: 2 }) < v.canvasBudget({ coarse: true }));
    assert.equal(v.canvasBudget({ deviceMemory: 4 }), v.canvasBudget({ coarse: true }));
  });

  test('detailRegion: visible part, grown within the budget, inside the page', () => {
    const box = { w: 2000, h: 2600 };
    const seen = { x: 500, y: 700, w: 390, h: 800 };
    const r = v.detailRegion(box, seen, 3, 5e6);
    assert.equal(r.os, Math.min(3, r.os));
    assert.ok(r.x <= seen.x && r.y <= seen.y && r.x + r.w >= seen.x + seen.w && r.y + r.h >= seen.y + seen.h);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= box.w && r.y + r.h <= box.h);
    assert.ok(r.w * r.h * r.os * r.os <= 5e6 * 1.01);
    // Visible part alone over budget: no margin, lower resolution.
    const big = v.detailRegion(box, { x: 0, y: 0, w: 1500, h: 1500 }, 3, 5e6);
    assert.deepEqual([big.x, big.y, big.w, big.h], [0, 0, 1500, 1500]);
    assert.ok(big.os < 3);
    // Near an edge: clamped.
    const edge = v.detailRegion(box, { x: 1900, y: 0, w: 100, h: 100 }, 2, 5e6);
    assert.ok(edge.x + edge.w <= 2000 && edge.y === 0);
  });

  test('containsRect', () => {
    assert.ok(v.containsRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 1, y: 1, w: 9, h: 9 }));
    assert.ok(!v.containsRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 1, y: 1, w: 10, h: 9 }));
  });
});

describe('incremental work', () => {
  test('nextChunkSize grows when cheap, shrinks when slow, stays in bounds', () => {
    assert.equal(v.nextChunkSize(64, 1), 128);
    assert.equal(v.nextChunkSize(64, 8), 64);
    assert.equal(v.nextChunkSize(64, 20), 32);
    assert.equal(v.nextChunkSize(1024, 0), 1024);
    assert.equal(v.nextChunkSize(16, 100), 16);
    assert.equal(v.nextChunkSize(10, 100, { min: 4 }), 5);
  });
});

describe('Lru', () => {
  test('touch order and victims never in keep', () => {
    const lru = new v.Lru();
    for (const k of [1, 2, 3, 4, 5]) lru.touch(k);
    lru.touch(1);
    assert.deepEqual(lru.keys(), [2, 3, 4, 5, 1]);
    assert.deepEqual(lru.victims(3), [2, 3]);
    assert.deepEqual(lru.victims(3, new Set([2])), [3, 4]);
    assert.deepEqual(lru.victims(10), []);
    lru.delete(3);
    assert.equal(lru.size, 4);
    assert.ok(!lru.has(3) && lru.has(4));
    // Everything protected: nothing evicted, even over the cap.
    assert.deepEqual(lru.victims(1, new Set([1, 2, 4, 5])), []);
  });
});

describe('focal-point zoom', () => {
  test('locatePoint / pointOf round trip', () => {
    const l = v.computeLayout(pages(5), 0.6, 390, SP);
    const loc = v.locatePoint(l, 100, l.tops[2] + 50);
    assert.equal(loc.index, 2);
    const p = v.pointOf(l, loc);
    near(p.x, 100);
    near(p.y, l.tops[2] + 50);
    assert.deepEqual(v.locatePoint(v.computeLayout([], 1, 390, SP), 0, 0), { index: 0, fx: 0, fy: 0 });
  });

  test('zoomScroll keeps the content under the focal point', () => {
    const view = 390;
    const a = v.computeLayout(pages(20), 0.6, view, SP);
    const b = v.computeLayout(pages(20), 1.5, view, SP);
    const scroll = { left: 0, top: a.tops[7] + 120 };
    const focal = { x: 200, y: 300 };
    const before = v.locatePoint(a, scroll.left + focal.x, scroll.top + focal.y);
    const next = v.zoomScroll(a, b, scroll, focal);
    const after = v.locatePoint(b, next.left + focal.x, next.top + focal.y);
    assert.equal(after.index, before.index);
    near(after.fx, before.fx, 1e-9);
    near(after.fy, before.fy, 1e-9);
  });

  test('zoomScroll follows a moved focal point (pinch pan)', () => {
    const a = v.computeLayout(pages(4), 1, 800, SP);
    const b = v.computeLayout(pages(4), 2, 800, SP);
    const scroll = { left: 10, top: 500 };
    const next = v.zoomScroll(a, b, scroll, { x: 100, y: 100 }, { x: 160, y: 40 });
    const before = v.locatePoint(a, 110, 600);
    const after = v.locatePoint(b, next.left + 160, next.top + 40);
    assert.equal(after.index, before.index);
    near(after.fx, before.fx, 1e-9);
    near(after.fy, before.fy, 1e-9);
  });

  test('nextZoom steps and stops at fit scales', () => {
    near(v.nextZoom(1, 1), 1.25);
    near(v.nextZoom(1, -1), 0.8);
    near(v.nextZoom(1, 1, [1.1]), 1.1);
    near(v.nextZoom(1, -1, [0.9, 0.5]), 0.9);
    // A stop equal to the current scale is skipped.
    near(v.nextZoom(1, 1, [1.0, 2]), 1.25);
    assert.equal(v.nextZoom(v.MAX_SCALE, 1), v.MAX_SCALE);
    assert.equal(v.nextZoom(v.MIN_SCALE, -1), v.MIN_SCALE);
  });
});

describe('rects', () => {
  test('mergeRects joins line pieces, drops empties and duplicates', () => {
    const out = v.mergeRects([
      [10, 10, 30, 12],
      [40, 10, 20, 12],
      [10, 10, 30, 12], // duplicate (element + text rect)
      [0, 0, 0, 12], // empty
      [10, 30, 50, 12], // next line
    ]);
    assert.deepEqual(out, [
      [10, 10, 50, 12],
      [10, 30, 50, 12],
    ]);
    // A wide gap stays two rects.
    assert.equal(v.mergeRects([[0, 0, 10, 10], [100, 0, 10, 10]]).length, 2);
    assert.deepEqual(v.mergeRects([]), []);
  });

  test('multiplyTransform + textItemRect (unrotated page)', () => {
    near(v.multiplyTransform([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 6])[4], 10);
    // Viewport transform of a 612×792 page at scale 1: y flips.
    const vp = [1, 0, 0, -1, 0, 792];
    const item = { str: 'abcdefghij', transform: [12, 0, 0, 12, 100, 700], width: 60 };
    const r = v.textItemRect(vp, item, 2, 5, LETTER);
    assert.ok(r);
    near(r[0] * 612, 100 + 12, 1e-6); // 2 of 10 chars of a 60-pt run
    near(r[2] * 612, 18, 1e-6);
    const baseline = 792 - 700;
    assert.ok(r[1] * 792 < baseline && (r[1] + r[3]) * 792 > baseline);
    assert.equal(v.textItemRect(vp, { str: '', transform: [1, 0, 0, 1, 0, 0], width: 0 }, 0, 0, LETTER), null);
  });
});

describe('search text', () => {
  test('foldChar / normalizeQuery: case, accents, ligatures, spaces', () => {
    assert.equal(v.foldChar('É'), 'e');
    assert.equal(v.foldChar('ﬁ'), 'fi');
    assert.equal(v.normalizeQuery('  Café   AU\tlait '), 'cafe au lait');
    assert.equal(v.normalizeQuery(''), '');
    assert.equal(v.normalizeQuery(null), '');
  });

  test('buildSearchText maps every folded char to its item + offset', () => {
    const st = v.buildSearchText(['Hello ', 'Wörld', 'next'], [false, true, false]);
    assert.equal(st.text, 'hello world next');
    const at = st.text.indexOf('world');
    assert.equal(st.item[at], 1);
    assert.equal(st.off[at], 0);
    assert.equal(st.off[at + 1], 1); // ö → o keeps its offset
    assert.equal(st.raw, 'Hello Wörld next');
    assert.equal(st.item.length, st.text.length);
  });

  test('buildSearchText joins hyphenated line breaks and collapses whitespace', () => {
    const st = v.buildSearchText(['the cardi-', 'ac  cycle', 'Well-', 'Known'], [true, true, true, false]);
    assert.equal(st.text, 'the cardiac cycle well- known');
    assert.equal(st.raw, 'the cardiac cycle Well- Known');
  });

  test('buildSearchText: ligature expands to two search chars on one source char', () => {
    const st = v.buildSearchText(['ﬁne'], [false]);
    assert.equal(st.text, 'fine');
    assert.deepEqual([...st.off], [0, 0, 1, 2]);
    assert.equal(st.raw, 'ﬁne');
    const m = v.findMatches(st.text, 'fine')[0];
    assert.deepEqual(v.matchSegments(st, m.start, m.end), [{ item: 0, from: 0, to: 3 }]);
  });

  test('findMatches is non-overlapping; matchSegments spans items', () => {
    assert.deepEqual(v.findMatches('aaaa', 'aa'), [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    assert.deepEqual(v.findMatches('abc', ''), []);
    const st = v.buildSearchText(['alpha be', 'ta gamma'], [false, false]);
    const m = v.findMatches(st.text, 'beta')[0];
    assert.deepEqual(v.matchSegments(st, m.start, m.end), [
      { item: 0, from: 6, to: 8 },
      { item: 1, from: 0, to: 2 },
    ]);
  });

  test('matchExcerpt gives readable context', () => {
    const words = 'one two three four five six seven eight nine ten eleven twelve thirteen';
    const st = v.buildSearchText([words], [false]);
    const m = v.findMatches(st.text, 'seven')[0];
    const ex = v.matchExcerpt(st, m.start, m.end, 12);
    assert.equal(ex.match, 'seven');
    assert.ok(ex.before.startsWith('…') && ex.before.endsWith(' '));
    assert.ok(ex.after.endsWith('…'));
    const short = v.matchExcerpt(v.buildSearchText(['Seven'], [false]), 0, 5);
    assert.deepEqual(short, { before: '', match: 'Seven', after: '' });
  });
});

describe('pdf.js helpers', () => {
  test('PdfError carries a plain message and code', () => {
    const e = new PdfError('password');
    assert.equal(e.name, 'PdfError');
    assert.equal(e.code, 'password');
    assert.match(e.userMessage, /password/);
    assert.equal(e.message, e.userMessage);
    assert.equal(PDFJS_VERSION, '4.10.38');
  });

  test('toPdfError maps PDF.js exceptions', () => {
    const named = (name, message = 'x') => Object.assign(new Error(message), { name });
    assert.equal(toPdfError(named('PasswordException', 'No password given')).code, 'password');
    assert.equal(toPdfError(named('InvalidPDFException', 'Invalid PDF structure.')).code, 'invalid');
    assert.equal(toPdfError(named('MissingPDFException')).code, 'invalid');
    assert.equal(toPdfError(named('UnexpectedResponseException')).code, 'network');
    assert.equal(toPdfError(named('AbortException')).code, 'cancelled');
    assert.equal(toPdfError(named('NotReadableError')).code, 'read');
    assert.equal(toPdfError(new Error('boom')).code, 'unknown');
    assert.equal(toPdfError(new Error('boom'), 'engine').code, 'engine');
    const same = new PdfError('empty');
    assert.equal(toPdfError(same), same);
    assert.match(toPdfError(named('Foo', 'bar')).detail, /Foo: bar/);
    assert.equal(toPdfError('text').code, 'unknown');
  });

  test('cleanText', () => {
    assert.equal(cleanText('  A\u0000B\n\tC­D  '), 'A B CD');
    assert.equal(cleanText(42), '');
    assert.equal(cleanText('x'.repeat(10), 5), 'xxxx…');
  });

  test('flattenOutline: depth first, levels, unresolvable dropped, children kept', async () => {
    const tree = [
      { title: 'One', dest: 'a', items: [{ title: ' Two\n', dest: [0], items: [] }] },
      { title: 'Link only', dest: null, url: 'https://example.org', items: [{ title: 'Child', dest: 'c', items: [] }] },
      { title: '', dest: 'a', items: [] },
      { title: 'Broken', dest: 'boom', items: [] },
    ];
    const pagesOf = { a: 1, c: 7 };
    const out = await flattenOutline(tree, async (dest) => {
      if (dest === 'boom') throw new Error('bad');
      return Array.isArray(dest) ? dest[0] + 3 : pagesOf[dest] ?? null;
    });
    assert.deepEqual(out, [
      { title: 'One', page: 1, level: 1 },
      { title: 'Two', page: 3, level: 2 },
      { title: 'Child', page: 7, level: 2 },
    ]);
  });

  test('flattenOutline: limits and cycles', async () => {
    const deep = { title: 'L', dest: 'x', items: [] };
    let node = deep;
    for (let i = 0; i < 10; i++) {
      const child = { title: `L${i}`, dest: 'x', items: [] };
      node.items.push(child);
      node = child;
    }
    const out = await flattenOutline([deep], async () => 1, { maxLevel: 3 });
    assert.equal(out.length, 11);
    assert.equal(Math.max(...out.map((o) => o.level)), 3);
    const loop = { title: 'Loop', dest: 'x', items: [] };
    loop.items.push(loop);
    assert.equal((await flattenOutline([loop], async () => 1)).length, 1);
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `T${i}`, dest: 'x', items: [] }));
    assert.equal((await flattenOutline(many, async () => 2, { maxItems: 10 })).length, 10);
    assert.deepEqual(await flattenOutline(null, async () => 1), []);
  });
});
