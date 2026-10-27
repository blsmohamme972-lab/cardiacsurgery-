// Unit tests for js/features/scratch/geometry.js. Run: node --test tests/unit/
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as g from '../../js/features/scratch/geometry.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const nearBox = (a, b, eps = 1e-6) => ['x', 'y', 'w', 'h'].forEach((k) => near(a[k], b[k], eps));
const stroke = (pts, extra = {}) => ({ id: 's', type: 'stroke', tool: 'pen', color: '#000000', size: 10, pts, ...extra });
const image = (extra = {}) => ({ id: 'i', type: 'image', media: 'm', x: 100, y: 100, w: 200, h: 100, rot: 0, ...extra });
const text = (extra = {}) => ({ id: 't', type: 'text', x: 0, y: 0, w: 500, text: 'one two three', color: '#000000', size: 50, ...extra });
const shape = (kind, extra = {}) => ({ id: 'sh', type: 'shape', shape: kind, x1: 0, y1: 0, x2: 100, y2: 100, color: '#000000', size: 10, fill: false, ...extra });

describe('basics', () => {
  test('distToSegment', () => {
    near(g.distToSegment(5, 5, 0, 0, 10, 0), 5);
    near(g.distToSegment(-3, 4, 0, 0, 10, 0), 5);
    near(g.distToSegment(3, 4, 0, 0, 0, 0), 5);
  });
  test('rotatePoint / boxCorners', () => {
    const p = g.rotatePoint(1, 0, 0, 0, Math.PI / 2);
    near(p.x, 0);
    near(p.y, 1);
    assert.deepEqual(g.rotatePoint(3, 4, 0, 0, 0), { x: 3, y: 4 });
    const c = g.boxCorners({ x: 0, y: 0, w: 2, h: 2 }, Math.PI / 2);
    near(c[0].x, 2);
    near(c[0].y, 0);
  });
  test('pointsBounds / unionBounds', () => {
    assert.deepEqual(g.pointsBounds([]), { x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual(g.unionBounds([{ x: 0, y: 0, w: 1, h: 1 }, { x: 5, y: -1, w: 1, h: 1 }]), { x: 0, y: -1, w: 6, h: 2 });
    assert.equal(g.unionBounds([]), null);
  });
});

describe('text layout', () => {
  test('wrapText keeps newlines and breaks long words', () => {
    const m = (s) => s.length * 10;
    assert.deepEqual(g.wrapText('aa bb cc', 50, 10, m), ['aa bb', 'cc']);
    assert.deepEqual(g.wrapText('a\nb', 100, 10, m), ['a', 'b']);
    assert.deepEqual(g.wrapText('abcdefghij', 30, 10, m), ['abc', 'def', 'ghi', 'j']);
    assert.deepEqual(g.wrapText('', 30, 10, m), ['']);
  });
  test('textHeight grows with lines', () => {
    const one = g.textHeight(text({ text: 'a' }));
    const many = g.textHeight(text({ text: 'word '.repeat(40) }));
    assert.ok(many > one * 3);
    near(one, 50 * g.TEXT_LINE + 2 * 50 * g.TEXT_PAD);
  });
});

describe('bounds', () => {
  test('stroke bounds include the line width', () => {
    const b = g.itemBounds(stroke([10, 10, 0.5, 110, 60, 0.5]));
    near(b.x, 10 - 6.25);
    near(b.w, 100 + 12.5);
    const hl = g.itemBounds(stroke([0, 0, 1], { tool: 'hl', size: 40 }));
    near(hl.w, 40);
  });
  test('rotated image bounds', () => {
    const b = g.itemBounds(image({ rot: Math.PI / 2 }));
    nearBox(b, { x: 150, y: 50, w: 100, h: 200 });
    assert.deepEqual(g.itemBox(image({ rot: 1 })), { x: 100, y: 100, w: 200, h: 100 });
  });
  test('shape bounds normalise and include arrow heads', () => {
    const b = g.itemBox(shape('rect', { x1: 100, y1: 50, x2: 0, y2: 0 }));
    assert.deepEqual(b, { x: 0, y: 0, w: 100, h: 50 });
    const a = g.itemBounds(shape('arrow'));
    assert.ok(a.x <= -g.ARROW_MIN);
  });
  test('text bounds', () => {
    const b = g.itemBounds(text());
    assert.equal(b.w, 500);
    assert.ok(b.h > 50);
  });
});

describe('hit tests', () => {
  test('strokes', () => {
    const s = stroke([0, 0, 0.5, 100, 0, 0.5]);
    assert.ok(g.hitItem(s, 50, 3, 1));
    assert.ok(!g.hitItem(s, 50, 30, 1));
    assert.ok(g.hitItem(stroke([10, 10, 0.5]), 12, 12, 2), 'single dot');
  });
  test('images (rotated) and text', () => {
    assert.ok(g.hitItem(image(), 150, 150, 0));
    assert.ok(!g.hitItem(image(), 50, 50, 0));
    const r = image({ rot: Math.PI / 2 });
    assert.ok(g.hitItem(r, 200, 60, 0), 'inside after rotation');
    assert.ok(!g.hitItem(r, 110, 110, 0), 'outside after rotation');
    assert.ok(g.hitItem(text(), 10, 10, 0));
  });
  test('shapes: inside vs outline', () => {
    const rect = shape('rect');
    assert.ok(g.hitItem(rect, 50, 50, 1));
    assert.ok(!g.hitItem(rect, 50, 50, 1, { inside: false }));
    assert.ok(g.hitItem(rect, 100, 50, 1, { inside: false }));
    const el = shape('ellipse');
    assert.ok(g.hitItem(el, 50, 50, 1));
    assert.ok(!g.hitItem(el, 50, 50, 1, { inside: false }));
    assert.ok(g.hitItem(el, 100, 50, 1, { inside: false }));
    assert.ok(!g.hitItem(el, 2, 2, 1));
    assert.ok(g.hitItem(shape('line'), 50, 52, 1));
    assert.ok(!g.hitItem(shape('line'), 50, 80, 1));
    assert.ok(g.hitItem(shape('rect', { fill: true }), 50, 50, 1, { inside: false }));
  });
  test('hitTest returns the topmost and honours a filter', () => {
    const a = image({ id: 'a' });
    const b = image({ id: 'b' });
    assert.equal(g.hitTest([a, b], 150, 150, 0).id, 'b');
    assert.equal(g.hitTest([a, b], 150, 150, 0, { filter: (it) => it.id === 'a' }).id, 'a');
    assert.equal(g.hitTest([a, b], 0, 0, 0), null);
  });
});

describe('lasso', () => {
  const square = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }, { x: 0, y: 300 }];
  test('pointInPolygon', () => {
    assert.ok(g.pointInPolygon(square, 10, 10));
    assert.ok(!g.pointInPolygon(square, 310, 10));
  });
  test('selects strokes mostly inside and items fully inside', () => {
    const items = [
      stroke([10, 10, 0.5, 20, 20, 0.5], { id: 'in' }),
      stroke([10, 10, 0.5, 400, 400, 0.5, 500, 500, 0.5], { id: 'out' }),
      image({ id: 'img', x: 50, y: 50, w: 100, h: 100 }),
      image({ id: 'big', x: 50, y: 50, w: 600, h: 100 }),
    ];
    assert.deepEqual(g.lassoSelect(items, square), ['in', 'img']);
    assert.deepEqual(g.lassoSelect(items, square.slice(0, 2)), []);
  });
});

describe('handles, resize, rotate', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  test('handlePoints and hitHandle', () => {
    const hp = g.handlePoints(box, 0, 40);
    assert.deepEqual(hp.se, { x: 200, y: 100 });
    assert.deepEqual(hp.n, { x: 100, y: 0 });
    assert.deepEqual(hp.rotate, { x: 100, y: -40 });
    assert.equal(g.hitHandle(hp, 198, 103, 10), 'se');
    assert.equal(g.hitHandle(hp, 60, 50, 10), null);
    assert.equal(g.handlePoints(box).rotate, undefined);
  });
  test('free resize from the se corner keeps nw fixed', () => {
    nearBox(g.resizeBox(box, 0, 'se', 300, 300), { x: 0, y: 0, w: 300, h: 300 });
  });
  test('aspect-locked corner resize', () => {
    nearBox(g.resizeBox(box, 0, 'se', 400, 110, { keepAspect: true }), { x: 0, y: 0, w: 400, h: 200 });
    nearBox(g.resizeBox(box, 0, 'nw', -200, 90, { keepAspect: true }), { x: -200, y: -100, w: 400, h: 200 });
  });
  test('edge handles: free and locked', () => {
    nearBox(g.resizeBox(box, 0, 'e', 250, 999), { x: 0, y: 0, w: 250, h: 100 });
    nearBox(g.resizeBox(box, 0, 'e', 400, 0, { keepAspect: true }), { x: 0, y: -50, w: 400, h: 200 });
    nearBox(g.resizeBox(box, 0, 'n', 0, -100), { x: 0, y: -100, w: 200, h: 200 });
  });
  test('minimum size', () => {
    const b = g.resizeBox(box, 0, 'se', -500, -500);
    assert.equal(b.w, g.MIN_SIDE);
    assert.equal(b.h, g.MIN_SIDE);
  });
  test('rotated resize keeps the opposite corner fixed on the page', () => {
    const rot = Math.PI / 2;
    const before = g.handlePoints(box, rot);
    const target = g.rotatePoint(260, 160, 100, 50, rot); // somewhere beyond se in local space
    const after = g.resizeBox(box, rot, 'se', target.x, target.y);
    const hp = g.handlePoints(after, rot);
    near(hp.nw.x, before.nw.x);
    near(hp.nw.y, before.nw.y);
    near(after.w, 260);
    near(after.h, 160);
  });
  test('rotationTowards + snapping', () => {
    near(g.rotationTowards(box, 100, -100), 0);
    near(g.rotationTowards(box, 300, 50), Math.PI / 2);
    near(g.rotationTowards(box, 300, 55), Math.PI / 2, 1e-9);
    assert.ok(g.rotationTowards(box, 300, 120, { snap: false }) > Math.PI / 2 + 0.1);
    near(g.snapAngle(0.03), 0);
    near(g.snapAngle(0.4), 0.4);
    near(g.rotationTowards(box, 100, 300), Math.PI);
  });
  test('snapValue / snapBoxToPage / constrainShape', () => {
    assert.deepEqual(g.snapValue(98, [100, 0], 5), { value: 100, target: 100 });
    assert.deepEqual(g.snapValue(50, [100], 5), { value: 50, target: null });
    const s = g.snapBoxToPage({ x: 896, y: 30, w: 200, h: 100 }, 10);
    assert.equal(s.dx, 4);
    assert.equal(s.guides.x, 1000);
    assert.equal(s.dy, 0);
    const p = g.constrainShape('line', 0, 0, 100, 10);
    near(p.y, 0);
    const q = g.constrainShape('rect', 0, 0, 100, -40);
    assert.deepEqual(q, { x: 100, y: -100 });
  });
  test('scaleItems maps every type', () => {
    const from = { x: 0, y: 0, w: 100, h: 100 };
    const to = { x: 0, y: 0, w: 200, h: 200 };
    const [s, sh, t, im] = g.scaleItems([stroke([50, 50, 0.5]), shape('line'), text({ x: 10 }), image({ x: 0, y: 0, w: 100, h: 50 })], from, to);
    assert.deepEqual(s.pts, [100, 100, 0.5]);
    assert.equal(sh.x2, 200);
    assert.equal(t.x, 20);
    assert.equal(t.size, 100);
    assert.deepEqual([im.x, im.y, im.w, im.h], [0, 0, 200, 100]);
  });
});

describe('view math', () => {
  test('clampPan keeps the page in view and centres it when smaller', () => {
    assert.equal(g.clampPan(-50, 400, 1, 2000), 0);
    assert.equal(g.clampPan(5000, 400, 1, 2000), 1600);
    assert.equal(g.clampPan(0, 1200, 0.5, 2000), -200);
    assert.equal(g.clampPan(-50, 400, 1, 2000, 20), -20, 'margin');
  });
  test('zoomAround keeps the anchor fixed', () => {
    const v = g.zoomAround({ zoom: 1, x: 100, y: 200 }, 2, 50, 80, { unit: 0.5 });
    near(v.x + 50 / 1, 100 + 50 / 0.5);
    near(v.y + 80 / 1, 200 + 80 / 0.5);
    assert.equal(g.zoomAround({ zoom: 1, x: 0, y: 0 }, 99, 0, 0).zoom, 5);
    assert.equal(g.zoomAround({ zoom: 1, x: 0, y: 0 }, 0, 0, 0).zoom, 0.25);
  });
  test('fitWidthScale and insertBox', () => {
    near(g.fitWidthScale(400), 0.2);
    near(g.fitWidthScale(420, 10), 0.2);
    const b = g.insertBox(1000, 500, { x: 0, y: 0, w: 2000, h: 3000 }, 0.2);
    near(b.w, 1600);
    near(b.h, 800);
    near(b.x + b.w / 2, 1000);
    const small = g.insertBox(100, 100, { x: 0, y: 0, w: 2000, h: 3000 }, 1);
    assert.ok(small.w >= g.MIN_SIDE * 4);
    const tall = g.insertBox(100, 4000, { x: 0, y: 0, w: 2000, h: 1000 }, 0.1);
    near(tall.h, 700);
  });
});
