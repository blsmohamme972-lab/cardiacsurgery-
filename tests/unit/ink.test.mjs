// Unit tests for the pure parts of js/features/annotate/ink.js and the pure
// view math of js/features/annotate/scratchpad.js. Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  INK_COLORS,
  INK_SIZES,
  HL_ALPHA,
  roundFrac,
  displayColor,
  simulatePressure,
  smoothPoint,
  sanitizeStroke,
  strokeRadius,
  strokeToPath,
  hitStroke,
  createInkHistory,
  renderStrokes,
} from '../../js/features/annotate/ink.js';

/** @returns {{tool:'pen'|'hl', color:string, size:number, pts:number[]}} */
const pen = (pts, extra = {}) => ({ tool: 'pen', color: '#1d4ed8', size: 0.01, pts, ...extra });

/** Signed polygon area (shoelace). */
function area(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

describe('constants', () => {
  test('six colours with valid hex, three sizes incl. the default 0.006', () => {
    assert.equal(INK_COLORS.length, 6);
    for (const c of INK_COLORS) {
      assert.match(c.hex, /^#[0-9a-f]{6}$/);
      assert.match(c.dark, /^#[0-9a-f]{6}$/);
    }
    assert.ok(INK_COLORS.some((c) => c.hex === '#1d4ed8'), 'default inkColor is in the palette');
    assert.equal(INK_SIZES.length, 3);
    assert.ok(INK_SIZES.some((s) => s.value === 0.006));
    assert.equal(HL_ALPHA, 0.35);
  });
});

describe('roundFrac', () => {
  test('rounds to 4 decimals by default, no negative zero', () => {
    assert.equal(roundFrac(0.123456), 0.1235);
    assert.equal(roundFrac(1 / 3, 2), 0.33);
    assert.ok(Object.is(roundFrac(-0.00001), 0));
  });
});

describe('displayColor', () => {
  test('light keeps the colour; dark swaps palette colours for their light twin', () => {
    assert.equal(displayColor('#1D4ED8', false), '#1d4ed8');
    assert.equal(displayColor('#111827', true), '#f3f4f6');
    assert.equal(displayColor('#abcdef', true), '#abcdef');
  });
  test('invalid colour falls back to black / its dark twin', () => {
    assert.equal(displayColor('red', false), '#111827');
    assert.equal(displayColor(undefined, true), '#f3f4f6');
  });
});

describe('simulatePressure', () => {
  test('slow strokes get fuller, fast strokes thinner, always within 0.3..1', () => {
    let slow = 0.6;
    let fast = 0.6;
    for (let i = 0; i < 30; i++) {
      slow = simulatePressure(slow, 0.05);
      fast = simulatePressure(fast, 5);
    }
    assert.ok(slow > 0.9, `slow ${slow}`);
    assert.ok(fast <= 0.31, `fast ${fast}`);
    assert.ok(fast >= 0.3);
  });
  test('eases (never jumps) and tolerates bad input', () => {
    const p = simulatePressure(0.6, 10);
    assert.ok(p < 0.6 && p > 0.4);
    assert.ok(Number.isFinite(simulatePressure(NaN, NaN)));
  });
});

describe('smoothPoint', () => {
  test('first point is the raw point; later points move part way', () => {
    assert.deepEqual(smoothPoint(null, { x: 3, y: 4 }, 0.5), { x: 3, y: 4 });
    assert.deepEqual(smoothPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
    assert.deepEqual(smoothPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, 0), { x: 10, y: 0 });
  });
});

describe('sanitizeStroke', () => {
  test('keeps valid strokes, normalises colour case and clamps pressure', () => {
    const s = sanitizeStroke({ tool: 'hl', color: '#AABBCC', size: 0.02, pts: [0.1, 0.2, 2, 0.3, 0.4, -1] });
    assert.deepEqual(s, { tool: 'hl', color: '#aabbcc', size: 0.02, pts: [0.1, 0.2, 1, 0.3, 0.4, 0] });
  });
  test('rejects bad tool, colour, size, empty points; drops non-finite triples and trailing values', () => {
    assert.equal(sanitizeStroke(null), null);
    assert.equal(sanitizeStroke({ tool: 'eraser', color: '#000000', size: 0.01, pts: [0, 0, 0.5] }), null);
    assert.equal(sanitizeStroke({ tool: 'pen', color: 'blue', size: 0.01, pts: [0, 0, 0.5] }), null);
    assert.equal(sanitizeStroke({ tool: 'pen', color: '#000000', size: 0, pts: [0, 0, 0.5] }), null);
    assert.equal(sanitizeStroke({ tool: 'pen', color: '#000000', size: 0.01, pts: [] }), null);
    const s = sanitizeStroke({ tool: 'pen', color: '#000000', size: 0.01, pts: [NaN, 0, 0.5, 0.5, 0.5, null, 0.9] });
    assert.deepEqual(s?.pts, [0.5, 0.5, 0.5]);
  });
});

describe('strokeToPath', () => {
  test('empty stroke or zero size → no polygon', () => {
    assert.deepEqual(strokeToPath(pen([]), 100, 100), []);
    assert.deepEqual(strokeToPath(pen([0.5, 0.5, 0.5]), 0, 100), []);
    assert.deepEqual(strokeToPath(/** @type {any} */ (null), 100, 100), []);
  });

  test('a single point becomes a round dot of the stroke radius', () => {
    const s = pen([0.5, 0.5, 1]);
    const poly = strokeToPath(s, 200, 100);
    assert.ok(poly.length >= 12);
    const r = strokeRadius(s, 200, 1);
    for (const [x, y] of poly) assert.ok(Math.abs(Math.hypot(x - 100, y - 50) - r) < 1e-6);
  });

  test('a horizontal line has its edges at ±radius and round caps beyond the ends', () => {
    const s = pen([0.1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.5, 0.5]);
    const poly = strokeToPath(s, 100, 100);
    const r = strokeRadius(s, 100, 0.5);
    const ys = poly.map((p) => p[1]);
    const xs = poly.map((p) => p[0]);
    assert.ok(Math.abs(Math.max(...ys) - (50 + r)) < 1e-6);
    assert.ok(Math.abs(Math.min(...ys) - (50 - r)) < 1e-6);
    assert.ok(Math.min(...xs) < 10 && Math.min(...xs) >= 10 - r - 1e-6, 'start cap');
    assert.ok(Math.max(...xs) > 90 && Math.max(...xs) <= 90 + r + 1e-6, 'end cap');
    assert.ok(Math.abs(area(poly)) > 80 * 2 * r * 0.9, 'encloses the stroke body');
  });

  test('pressure changes pen width; the highlighter ignores pressure', () => {
    const light = pen([0.1, 0.5, 0.1, 0.9, 0.5, 0.1]);
    const heavy = pen([0.1, 0.5, 1, 0.9, 0.5, 1]);
    assert.ok(Math.abs(area(strokeToPath(heavy, 100, 100))) > Math.abs(area(strokeToPath(light, 100, 100))) * 2);
    assert.equal(strokeRadius({ ...light, tool: 'hl' }, 100, 0.1), strokeRadius({ ...light, tool: 'hl' }, 100, 1));
  });

  test('scales with the surface size (fractions are resolution independent)', () => {
    const s = pen([0.2, 0.2, 0.5, 0.8, 0.6, 0.5]);
    const a = strokeToPath(s, 100, 100);
    const b = strokeToPath(s, 200, 200);
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Math.abs(b[i][0] - a[i][0] * 2) < 1e-6 && Math.abs(b[i][1] - a[i][1] * 2) < 1e-6);
    }
  });

  test('duplicate points and non-finite values never produce NaN', () => {
    const s = pen([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, NaN, 0.2, 0.5, 0.6, 0.6, NaN]);
    const poly = strokeToPath(s, 300, 300);
    assert.ok(poly.length > 0);
    for (const [x, y] of poly) assert.ok(Number.isFinite(x) && Number.isFinite(y));
  });

  test('is pure: same input → same output, input untouched', () => {
    const s = pen([0.1, 0.1, 0.4, 0.3, 0.5, 0.8, 0.7, 0.2, 0.6]);
    const copy = JSON.parse(JSON.stringify(s));
    assert.deepEqual(strokeToPath(s, 120, 80), strokeToPath(s, 120, 80));
    assert.deepEqual(s, copy);
  });
});

describe('hitStroke', () => {
  const s = pen([0.1, 0.5, 0.5, 0.9, 0.5, 0.5], { size: 0.02 });
  test('touches along the segment, misses away from it', () => {
    assert.equal(hitStroke(s, 50, 50, 5, 100, 100), true);
    assert.equal(hitStroke(s, 50, 56, 5, 100, 100), true, 'within eraser radius + stroke radius');
    assert.equal(hitStroke(s, 50, 70, 5, 100, 100), false);
    assert.equal(hitStroke(s, 0, 50, 5, 100, 100), false, 'beyond the start');
  });
  test('single-point strokes and empty strokes', () => {
    assert.equal(hitStroke(pen([0.5, 0.5, 0.5]), 52, 50, 3, 100, 100), true);
    assert.equal(hitStroke(pen([]), 50, 50, 50, 100, 100), false);
  });
});

describe('createInkHistory', () => {
  const a = pen([0.1, 0.1, 0.5]);
  const b = pen([0.2, 0.2, 0.5]);
  const c = pen([0.3, 0.3, 0.5]);

  test('add → undo → redo', () => {
    const hst = createInkHistory();
    assert.equal(hst.canUndo(), false);
    assert.deepEqual(hst.add('stem', a), ['stem']);
    hst.add('stem', b);
    assert.deepEqual(hst.strokes('stem'), [a, b]);
    assert.deepEqual(hst.undo(), ['stem']);
    assert.deepEqual(hst.strokes('stem'), [a]);
    assert.equal(hst.canRedo(), true);
    hst.redo();
    assert.deepEqual(hst.strokes('stem'), [a, b]);
    assert.equal(hst.redo(), null);
  });

  test('a new action clears redo', () => {
    const hst = createInkHistory();
    hst.add('x', a);
    hst.undo();
    hst.add('x', b);
    assert.equal(hst.canRedo(), false);
    assert.deepEqual(hst.strokes('x'), [b]);
  });

  test('erase is one undo step per gesture and restores exact positions', () => {
    const hst = createInkHistory();
    hst.load('x', [a, b, c]);
    assert.equal(hst.erase('x', b), true);
    assert.equal(hst.erase('x', a), true);
    assert.equal(hst.erase('x', a), false, 'already gone');
    assert.deepEqual(hst.endErase(), ['x']);
    assert.deepEqual(hst.strokes('x'), [c]);
    hst.undo();
    assert.deepEqual(hst.strokes('x'), [a, b, c]);
    hst.redo();
    assert.deepEqual(hst.strokes('x'), [c]);
    assert.deepEqual(hst.endErase(), [], 'nothing pending');
  });

  test('clear covers the given blocks only, returns a token, and undoes exactly', () => {
    const hst = createInkHistory();
    hst.load('one', [a]);
    hst.load('two', [b]);
    hst.load('hidden', [c]);
    const res = hst.clear(['one', 'two', 'empty']);
    assert.ok(res && res.token);
    assert.deepEqual(res.changed.sort(), ['one', 'two']);
    assert.deepEqual(hst.strokes('one'), []);
    assert.deepEqual(hst.strokes('hidden'), [c]);
    assert.equal(hst.clear(['one', 'two']), null, 'nothing left to clear');
    hst.undo(res.token);
    assert.deepEqual(hst.strokes('one'), [a]);
    assert.deepEqual(hst.strokes('two'), [b]);
    hst.redo();
    assert.deepEqual(hst.strokes('one'), []);
  });

  test('undo(token) is a no-op when another action is on top', () => {
    const hst = createInkHistory();
    hst.load('x', [a]);
    const res = hst.clear(['x']);
    hst.add('x', b);
    assert.equal(hst.undo(res?.token), null);
    assert.deepEqual(hst.strokes('x'), [b]);
  });

  test('load prepends stored strokes before strokes drawn while loading', () => {
    const hst = createInkHistory();
    hst.add('x', c);
    hst.load('x', [a, b]);
    assert.deepEqual(hst.strokes('x'), [a, b, c]);
    hst.undo();
    assert.deepEqual(hst.strokes('x'), [a, b]);
  });

  test('history is capped', () => {
    const hst = createInkHistory({ limit: 3 });
    for (let i = 0; i < 5; i++) hst.add('x', pen([i / 10, 0, 0.5]));
    let n = 0;
    while (hst.undo()) n++;
    assert.equal(n, 3);
    assert.equal(hst.strokes('x').length, 2);
  });
});

describe('renderStrokes', () => {
  /** A recording fake 2D context. */
  function fakeCtx() {
    const calls = [];
    const ctx = {
      canvas: { width: 200, height: 100 },
      calls,
      set globalAlpha(v) { calls.push(['alpha', v]); },
      set globalCompositeOperation(v) { calls.push(['blend', v]); },
      set fillStyle(v) { calls.push(['fillStyle', v]); },
      set strokeStyle(v) { calls.push(['strokeStyle', v]); },
      set lineWidth(v) { calls.push(['lineWidth', v]); },
      lineCap: '',
      lineJoin: '',
    };
    for (const m of ['setTransform', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath', 'fill', 'stroke']) {
      ctx[m] = (...args) => calls.push([m, ...args]);
    }
    return ctx;
  }

  test('draws highlighter strokes (35% alpha) before pen strokes, with theme colours', () => {
    const ctx = fakeCtx();
    const strokes = [pen([0.1, 0.1, 0.5, 0.5, 0.5, 0.5]), { tool: 'hl', color: '#eab308', size: 0.04, pts: [0.2, 0.5, 0.5, 0.8, 0.5, 0.5] }];
    renderStrokes(/** @type {any} */ (ctx), strokes, 200, 100, 2, { dark: true, hlBlend: 'multiply' });
    const names = ctx.calls.map((c) => c[0]);
    assert.equal(names[0], 'setTransform');
    assert.equal(names[1], 'clearRect');
    const strokeIdx = names.indexOf('stroke');
    const fillIdx = names.indexOf('fill');
    assert.ok(strokeIdx > -1 && fillIdx > strokeIdx, 'highlighter first');
    assert.ok(ctx.calls.some((c) => c[0] === 'alpha' && c[1] === 0.35));
    assert.ok(ctx.calls.some((c) => c[0] === 'blend' && c[1] === 'multiply'));
    assert.ok(ctx.calls.some((c) => c[0] === 'fillStyle' && c[1] === '#7aa7ff'), 'dark blue twin');
    assert.ok(ctx.calls.some((c) => c[0] === 'setTransform' && c[1] === 2 && c[4] === 2), 'dpr scale');
  });

  test('applies zoom and pan; skips the clear when asked; tolerates empty input', () => {
    const ctx = fakeCtx();
    renderStrokes(/** @type {any} */ (ctx), [pen([0.5, 0.5, 0.5])], 100, 100, 1, { zoom: 2, panX: 10, panY: 5, clear: false });
    assert.ok(!ctx.calls.some((c) => c[0] === 'clearRect'));
    assert.ok(ctx.calls.some((c) => c[0] === 'setTransform' && c[1] === 2 && c[5] === -20 && c[6] === -10));
    const empty = fakeCtx();
    renderStrokes(/** @type {any} */ (empty), [], 100, 100, 1);
    assert.deepEqual(empty.calls.map((c) => c[0]), ['setTransform', 'clearRect']);
  });
});

describe('scratchpad view math', async () => {
  // scratchpad.js imports components (no DOM access at import time).
  const { clampPan, zoomAround, MIN_ZOOM, MAX_ZOOM } = await import('../../js/features/annotate/scratchpad.js');

  test('clampPan keeps the page in view and centres it when smaller', () => {
    assert.equal(clampPan(-50, 400, 1, 2000), 0);
    assert.equal(clampPan(5000, 400, 1, 2000), 1600);
    assert.equal(clampPan(300, 400, 1, 2000), 300);
    assert.equal(clampPan(0, 1200, 0.5, 2000), -200, 'centred: 2400 visible units for a 2000 page');
  });

  test('zoomAround keeps the anchor point fixed and clamps the zoom', () => {
    const v = zoomAround({ zoom: 1, x: 100, y: 200 }, 2, 50, 80);
    assert.equal(v.zoom, 2);
    // Page point under the anchor before: (150, 280); after: x + 50/2, y + 80/2.
    assert.equal(v.x + 50 / 2, 150);
    assert.equal(v.y + 80 / 2, 280);
    assert.equal(zoomAround({ zoom: 1, x: 0, y: 0 }, 99, 0, 0).zoom, MAX_ZOOM);
    assert.equal(zoomAround({ zoom: 1, x: 0, y: 0 }, 0.01, 0, 0).zoom, MIN_ZOOM);
  });
});
