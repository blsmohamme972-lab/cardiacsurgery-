// Unit tests for js/features/scratch/scene.js (scratchpad v2 model). Run: node --test tests/unit/
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_W,
  PAGE_H,
  SCRATCH_COLORS,
  SCRATCH_SIZES,
  emptyScene,
  sanitizeItem,
  deserialize,
  serialize,
  migrateV1,
  mediaIds,
  moveItem,
  cloneItem,
  styleItem,
  reorderIds,
  applyCommand,
  createHistory,
  paintColor,
  sizeIndex,
  normalizeAngle,
  round1,
  makeItem,
  pageSize,
  sizeScale,
  scaleItem,
  voiceIds,
  ITEM_TYPES,
  MIN_PAGE_SIDE,
  MAX_PAGE_SIDE,
} from '../../js/features/scratch/scene.js';
import { itemBox, itemBounds, hitItem, lassoSelect, scaleItems, insertBox } from '../../js/features/scratch/geometry.js';

let n = 0;
const idFn = () => `id${++n}`;
const stroke = (id, extra = {}) => ({ id, type: 'stroke', tool: 'pen', color: '#1d4ed8', size: 10, pts: [10, 10, 0.5, 20, 30, 0.6], ...extra });
const image = (id, extra = {}) => ({ id, type: 'image', media: 'm1', x: 100, y: 100, w: 400, h: 300, rot: 0, ...extra });
const text = (id, extra = {}) => ({ id, type: 'text', x: 50, y: 60, w: 600, text: 'Hello', color: '#111827', size: 80, ...extra });
const shape = (id, extra = {}) => ({ id, type: 'shape', shape: 'rect', x1: 0, y1: 0, x2: 100, y2: 50, color: '#dc2626', size: 10, fill: false, ...extra });
const scene = (...items) => ({ ...emptyScene('dots'), items });

describe('constants', () => {
  test('page and palette', () => {
    assert.equal(PAGE_W, 2000);
    assert.equal(PAGE_H, 3000);
    assert.equal(SCRATCH_COLORS.length, 8);
    for (const c of SCRATCH_COLORS) assert.match(c.hex, /^#[0-9a-f]{6}$/);
    assert.equal(new Set(SCRATCH_COLORS.map((c) => c.hex)).size, 8);
    for (const k of ['pen', 'hl', 'text', 'shape']) assert.equal(SCRATCH_SIZES[k].length, 3);
  });
  test('paintColor / sizeIndex / round1 / normalizeAngle', () => {
    assert.equal(paintColor('#1D4ED8', false), '#1d4ed8');
    assert.equal(paintColor('#1d4ed8', true), '#7aa7ff');
    assert.equal(paintColor('#123456', true), '#123456');
    assert.equal(paintColor('nope', false), '#111827');
    assert.equal(sizeIndex(2), 2);
    assert.equal(sizeIndex('0'), 0);
    assert.equal(sizeIndex(7), 1);
    assert.equal(round1(1.26), 1.3);
    assert.ok(Object.is(round1(-0.01), 0));
    assert.ok(Math.abs(normalizeAngle(3 * Math.PI) - Math.PI) < 1e-9);
    assert.ok(Math.abs(normalizeAngle(-3 * Math.PI / 2) - Math.PI / 2) < 1e-9);
    assert.equal(normalizeAngle(NaN), 0);
  });
});

describe('sanitizeItem', () => {
  test('keeps valid items and rounds numbers', () => {
    const s = sanitizeItem({ ...stroke('a'), pts: [1.234, 2.345, 0.555, 3, 4, 2], extra: 1 });
    assert.deepEqual(s, { id: 'a', type: 'stroke', tool: 'pen', color: '#1d4ed8', size: 10, pts: [1.2, 2.3, 0.56, 3, 4, 1] });
    assert.deepEqual(sanitizeItem(image('b')), image('b'));
    assert.deepEqual(sanitizeItem(text('c')), text('c'));
    assert.deepEqual(sanitizeItem(shape('d')), shape('d'));
  });
  test('rejects broken items', () => {
    assert.equal(sanitizeItem(null), null);
    assert.equal(sanitizeItem({ ...stroke('a'), id: '' }), null);
    assert.equal(sanitizeItem({ ...stroke('a'), id: 'bad id!' }), null);
    assert.equal(sanitizeItem({ ...stroke('a'), tool: 'brush' }), null);
    assert.equal(sanitizeItem({ ...stroke('a'), pts: [] }), null);
    assert.equal(sanitizeItem({ ...stroke('a'), pts: [NaN, 1, 1] }), null);
    assert.equal(sanitizeItem({ ...image('a'), media: '' }), null);
    assert.equal(sanitizeItem({ ...image('a'), w: 0 }), null);
    assert.equal(sanitizeItem({ ...text('a'), text: '   ' }), null);
    assert.equal(sanitizeItem({ ...shape('a'), shape: 'star' }), null);
    assert.equal(sanitizeItem({ ...shape('a'), x1: 1e9 }), null);
    assert.equal(sanitizeItem({ id: 'x', type: 'video' }), null);
  });
  test('defaults: bad colour → blue, missing rot → 0, fill only true when true', () => {
    assert.equal(sanitizeItem({ ...stroke('a'), color: 'red' }).color, '#1d4ed8');
    assert.equal(sanitizeItem({ ...image('a'), rot: undefined }).rot, 0);
    assert.equal(sanitizeItem({ ...shape('a'), fill: 'yes' }).fill, false);
  });
});

describe('deserialize / serialize', () => {
  test('round trip and validation', () => {
    const raw = { v: 2, page: { w: 1, h: 1, bg: 'grid' }, items: [stroke('a'), { junk: 1 }, image('b'), stroke('a')] };
    const s = deserialize(raw);
    assert.equal(s.page.bg, 'grid');
    assert.equal(s.page.w, PAGE_W);
    assert.deepEqual(s.items.map((i) => i.id), ['a', 'b']);
    assert.deepEqual(deserialize(JSON.parse(JSON.stringify(serialize(s)))), s);
  });
  test('garbage gives an empty scene with the default template', () => {
    assert.deepEqual(deserialize(null, { bg: 'lines' }), emptyScene('lines'));
    assert.deepEqual(deserialize({ items: 'x' }).items, []);
    assert.equal(deserialize({ page: { bg: 'wallpaper' } }).page.bg, 'dots');
  });
  test('serialize rounds', () => {
    const out = serialize(scene({ ...image('a'), x: 1.26, rot: 0.123456 }));
    assert.equal(out.items[0].x, 1.3);
    assert.equal(out.items[0].rot, 0.1235);
  });
});

describe('migrateV1', () => {
  test('converts fractions of 2000×3000 to page units', () => {
    const s = migrateV1([{ tool: 'pen', color: '#dc2626', size: 0.003, pts: [0.5, 0.5, 0.7, 0.25, 0.1, 0.5] }, { tool: 'x' }, null], { idFn });
    assert.equal(s.v, 2);
    assert.equal(s.items.length, 1);
    const it = s.items[0];
    assert.equal(it.type, 'stroke');
    assert.equal(it.size, 6);
    assert.deepEqual(it.pts, [1000, 1500, 0.7, 500, 300, 0.5]);
  });
  test('empty input', () => {
    assert.deepEqual(migrateV1(undefined).items, []);
  });
});

describe('item helpers', () => {
  test('moveItem for every type, never mutating', () => {
    const s = stroke('a');
    const m = moveItem(s, 5, -5);
    assert.deepEqual(m.pts, [15, 5, 0.5, 25, 25, 0.6]);
    assert.deepEqual(s.pts, [10, 10, 0.5, 20, 30, 0.6]);
    assert.deepEqual([moveItem(shape('b'), 1, 2).x1, moveItem(shape('b'), 1, 2).y2], [1, 52]);
    assert.equal(moveItem(image('c'), 10, 0).x, 110);
    assert.equal(moveItem(text('d'), 0, 10).y, 70);
  });
  test('cloneItem / styleItem / mediaIds / makeItem', () => {
    const c = cloneItem(image('a'), 40, () => 'new');
    assert.equal(c.id, 'new');
    assert.equal(c.x, 140);
    assert.equal(styleItem(image('a'), { color: '#000000' }).color, undefined);
    assert.equal(styleItem(stroke('a'), { color: '#ABCDEF', size: 3 }).color, '#abcdef');
    assert.equal(styleItem(stroke('a'), { color: 'bad' }).color, '#1d4ed8');
    assert.deepEqual([...mediaIds(scene(image('a'), image('b', { media: 'm2' }), stroke('c')))], ['m1', 'm2']);
    assert.equal(makeItem({ type: 'text' }, () => 'z').id, 'z');
  });
  test('reorderIds', () => {
    const items = ['a', 'b', 'c', 'd'].map((id) => stroke(id));
    assert.deepEqual(reorderIds(items, ['b'], 'front'), ['a', 'c', 'd', 'b']);
    assert.deepEqual(reorderIds(items, ['c'], 'back'), ['c', 'a', 'b', 'd']);
    assert.deepEqual(reorderIds(items, ['b'], 'forward'), ['a', 'c', 'b', 'd']);
    assert.deepEqual(reorderIds(items, ['b'], 'backward'), ['b', 'a', 'c', 'd']);
    assert.deepEqual(reorderIds(items, ['a', 'c'], 'front'), ['b', 'd', 'a', 'c']);
  });
});

describe('applyCommand', () => {
  const base = scene(stroke('a'), image('b'), text('c'));

  test('add on top, at an index, ignores duplicate ids', () => {
    let r = applyCommand(base, { type: 'add', items: [shape('d')] });
    assert.deepEqual(r.scene.items.map((i) => i.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(r.inverse, { type: 'remove', ids: ['d'] });
    r = applyCommand(base, { type: 'add', items: [shape('d')], index: 1 });
    assert.deepEqual(r.scene.items.map((i) => i.id), ['a', 'd', 'b', 'c']);
    r = applyCommand(base, { type: 'add', items: [stroke('a')] });
    assert.equal(r.inverse, null);
    assert.equal(r.scene, base);
  });

  test('remove + its inverse restore the exact positions', () => {
    const r = applyCommand(base, { type: 'remove', ids: ['a', 'c'] });
    assert.deepEqual(r.scene.items.map((i) => i.id), ['b']);
    const back = applyCommand(r.scene, r.inverse);
    assert.deepEqual(back.scene.items, base.items);
    assert.equal(back.scene.items[0], base.items[0], 'same objects come back');
    assert.equal(applyCommand(base, { type: 'remove', ids: ['zz'] }).inverse, null);
  });

  test('update / style / transform', () => {
    const moved = moveItem(base.items[1], 10, 10);
    let r = applyCommand(base, { type: 'update', items: [moved] });
    assert.equal(r.scene.items[1], moved);
    assert.equal(r.scene.items[0], base.items[0], 'unchanged items are shared');
    assert.deepEqual(r.inverse, { type: 'update', items: [base.items[1]] });
    r = applyCommand(base, { type: 'style', ids: ['a', 'b'], patch: { color: '#dc2626' } });
    assert.equal(r.scene.items[0].color, '#dc2626');
    assert.equal(r.scene.items[1], base.items[1], 'images are not restyled');
    assert.equal(applyCommand(base, { type: 'style', ids: ['a'], patch: { color: '#1d4ed8' } }).inverse, null);
    r = applyCommand(base, { type: 'transform', ids: ['c'], dx: 5, dy: 0 });
    assert.equal(r.scene.items[2].x, 55);
    assert.equal(applyCommand(base, { type: 'transform', ids: ['c'], dx: 0, dy: 0 }).inverse, null);
  });

  test('order / clear / page / unknown', () => {
    let r = applyCommand(base, { type: 'order', ids: ['c', 'a', 'b'] });
    assert.deepEqual(r.scene.items.map((i) => i.id), ['c', 'a', 'b']);
    assert.deepEqual(applyCommand(r.scene, r.inverse).scene.items.map((i) => i.id), ['a', 'b', 'c']);
    assert.equal(applyCommand(base, { type: 'order', ids: ['a', 'b', 'c'] }).inverse, null);
    r = applyCommand(base, { type: 'clear' });
    assert.equal(r.scene.items.length, 0);
    assert.deepEqual(applyCommand(r.scene, r.inverse).scene.items, base.items);
    assert.equal(applyCommand(r.scene, { type: 'clear' }).inverse, null);
    r = applyCommand(base, { type: 'page', bg: 'lines' });
    assert.equal(r.scene.page.bg, 'lines');
    assert.deepEqual(r.inverse, { type: 'page', bg: 'dots' });
    assert.equal(applyCommand(base, { type: 'page', bg: 'nope' }).inverse, null);
    assert.equal(applyCommand(base, { type: 'explode' }).inverse, null);
    assert.equal(applyCommand(base, null).inverse, null);
  });
});

describe('createHistory', () => {
  test('undo/redo every command exactly', () => {
    const h = createHistory(scene(stroke('a')));
    assert.equal(h.canUndo(), false);
    assert.equal(h.apply({ type: 'add', items: [image('b')] }), true);
    assert.equal(h.apply({ type: 'transform', ids: ['b'], dx: 10, dy: 0 }), true);
    assert.equal(h.apply({ type: 'remove', ids: ['a'] }), true);
    assert.equal(h.apply({ type: 'page', bg: 'grid' }), true);
    assert.equal(h.apply({ type: 'clear' }), true);
    assert.equal(h.apply({ type: 'clear' }), false, 'a no-op is not recorded');
    const states = [];
    while (h.canUndo()) {
      h.undo();
      states.push(JSON.stringify(h.scene));
    }
    assert.deepEqual(h.scene, scene(stroke('a')));
    assert.equal(h.undo(), null);
    while (h.canRedo()) h.redo();
    assert.equal(h.scene.items.length, 0);
    assert.equal(h.scene.page.bg, 'grid');
    h.undo();
    assert.deepEqual(h.scene.items.map((i) => [i.id, i.x ?? null]), [['b', 110]]);
  });

  test('a new command clears redo; limit trims the oldest', () => {
    const h = createHistory(emptyScene(), { limit: 3 });
    for (let i = 0; i < 5; i++) h.apply({ type: 'add', items: [stroke(`s${i}`)] });
    assert.deepEqual(h.size(), { undo: 3, redo: 0 });
    h.undo();
    assert.equal(h.canRedo(), true);
    h.apply({ type: 'add', items: [stroke('x')] });
    assert.equal(h.canRedo(), false);
    h.reset(emptyScene('lines'));
    assert.deepEqual(h.size(), { undo: 0, redo: 0 });
    assert.equal(h.scene.page.bg, 'lines');
  });

  test('redo after undo of a remove restores the item at its index', () => {
    const h = createHistory(scene(stroke('a'), stroke('b'), stroke('c')));
    h.apply({ type: 'remove', ids: ['b'] });
    h.undo();
    assert.deepEqual(h.scene.items.map((i) => i.id), ['a', 'b', 'c']);
    h.redo();
    assert.deepEqual(h.scene.items.map((i) => i.id), ['a', 'c']);
    h.undo();
    assert.deepEqual(h.scene.items.map((i) => i.id), ['a', 'b', 'c']);
  });
});

/* ---------------- book pages (§7.17): page size + point items ---------------- */

const note = (id, extra = {}) => ({ id, type: 'note', x: 100, y: 200, text: 'Placeholder', color: '#eab308', ...extra });
const audio = (id, extra = {}) => ({ id, type: 'audio', x: 300, y: 400, voice: 'v1', durationMs: 2100, ...extra });

describe('point items: note and audio', () => {
  test('types are known', () => {
    assert.ok(ITEM_TYPES.includes('note') && ITEM_TYPES.includes('audio'));
  });
  test('sanitize keeps valid notes (empty text allowed) and voice pins', () => {
    assert.deepEqual(sanitizeItem(note('n', { x: 10.26, extra: 1 })), { id: 'n', type: 'note', x: 10.3, y: 200, text: 'Placeholder', color: '#eab308' });
    assert.equal(sanitizeItem(note('n', { text: '' })).text, '');
    assert.equal(sanitizeItem(note('n', { text: 5 })).text, '');
    assert.equal(sanitizeItem(note('n', { color: 'red' })).color, '#1d4ed8');
    assert.equal(sanitizeItem(note('n', { text: 'x'.repeat(9000) })).text.length, 5000);
    assert.deepEqual(sanitizeItem(audio('a', { durationMs: 2100.6 })), { id: 'a', type: 'audio', x: 300, y: 400, voice: 'v1', durationMs: 2101 });
    assert.equal(sanitizeItem(audio('a', { durationMs: -5 })).durationMs, 0);
    assert.equal(sanitizeItem(audio('a', { durationMs: 'x' })).durationMs, 0);
  });
  test('sanitize rejects broken point items', () => {
    assert.equal(sanitizeItem(note('n', { x: NaN })), null);
    assert.equal(sanitizeItem(note('n', { y: 99999 })), null);
    assert.equal(sanitizeItem(audio('a', { voice: '' })), null);
    assert.equal(sanitizeItem(audio('a', { voice: 'bad id!' })), null);
    assert.equal(sanitizeItem(audio('a', { x: undefined })), null);
  });
  test('move, clone, style; voiceIds', () => {
    const n = note('n');
    const moved = moveItem(n, 5, -10);
    assert.deepEqual([moved.x, moved.y], [105, 190]);
    assert.equal(n.x, 100);
    const c = cloneItem(audio('a'), 10, () => 'c1');
    assert.equal(c.id, 'c1');
    assert.equal(c.voice, 'v1');
    assert.equal(styleItem(note('n'), { color: '#dc2626', size: 9 }).color, '#dc2626');
    assert.equal(styleItem(note('n'), { size: 9 }).size, undefined);
    const a = audio('a');
    assert.equal(styleItem(a, { color: '#dc2626' }), a);
    assert.deepEqual([...voiceIds(scene(audio('a'), audio('b', { voice: 'v2' }), stroke('s')))], ['v1', 'v2']);
  });
  test('commands work with point items (add/remove/update/undo)', () => {
    const h = createHistory(scene());
    assert.ok(h.apply({ type: 'add', items: [note('n'), audio('a')] }));
    assert.ok(h.apply({ type: 'update', items: [{ ...note('n'), text: 'Edited' }] }));
    assert.ok(h.apply({ type: 'remove', ids: ['a'] }));
    h.undo();
    assert.deepEqual(h.scene.items.map((i) => i.id), ['n', 'a']);
    h.undo();
    assert.equal(h.scene.items[0].text, 'Placeholder');
  });
  test('geometry: zero-size box at the anchor, tap tolerance, lasso, group scale', () => {
    assert.deepEqual(itemBox(note('n')), { x: 100, y: 200, w: 0, h: 0 });
    assert.deepEqual(itemBounds(audio('a')), { x: 300, y: 400, w: 0, h: 0 });
    assert.ok(hitItem(note('n'), 104, 203, 6));
    assert.ok(!hitItem(note('n'), 120, 200, 6));
    const poly = [{ x: 50, y: 150 }, { x: 150, y: 150 }, { x: 150, y: 250 }, { x: 50, y: 250 }];
    assert.deepEqual(lassoSelect([note('n'), audio('a')], poly), ['n']);
    const [s] = scaleItems([note('n')], { x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 200, h: 50 });
    assert.deepEqual([s.x, s.y], [200, 100]);
  });
});

describe('page size (book pages)', () => {
  test('pageSize validates; sizeScale follows the page width', () => {
    assert.deepEqual(pageSize({ w: 612, h: 792 }), { w: 612, h: 792 });
    assert.equal(pageSize({ w: MIN_PAGE_SIDE - 1, h: 792 }), null);
    assert.equal(pageSize({ w: 612, h: MAX_PAGE_SIDE + 1 }), null);
    assert.equal(pageSize(null), null);
    assert.equal(sizeScale({ w: 2000 }), 1);
    assert.equal(sizeScale({ w: 612 }), 0.306);
    assert.equal(sizeScale(null), 1);
    assert.equal(sizeScale({ w: 1 }), 1);
  });
  test('emptyScene with a size; the scratchpad default is unchanged', () => {
    assert.deepEqual(emptyScene('plain', { w: 612, h: 792 }).page, { w: 612, h: 792, bg: 'plain' });
    assert.deepEqual(emptyScene('plain', { w: 2, h: 2 }).page, { w: PAGE_W, h: PAGE_H, bg: 'plain' });
    assert.deepEqual(emptyScene().page, { w: PAGE_W, h: PAGE_H, bg: 'dots' });
  });
  test('serialize keeps the page size; deserialize reads it back', () => {
    const s = { ...emptyScene('plain', { w: 612, h: 792 }), items: [note('n'), stroke('s')] };
    const out = serialize(s);
    assert.deepEqual(out.page, { w: 612, h: 792, bg: 'plain' });
    assert.deepEqual(deserialize(JSON.parse(JSON.stringify(out))), s);
    assert.deepEqual(deserialize(out, { size: { w: 612, h: 792 } }), s);
  });
  test('deserialize with another size scales the items to it', () => {
    const stored = serialize({ ...emptyScene('plain', { w: 600, h: 800 }), items: [stroke('s'), image('i'), text('t'), shape('h'), note('n')] });
    const s = deserialize(stored, { bg: 'plain', size: { w: 300, h: 400 } });
    assert.deepEqual(s.page, { w: 300, h: 400, bg: 'plain' });
    const [st, im, tx, sh, nt] = s.items;
    assert.deepEqual(st.pts, [5, 5, 0.5, 10, 15, 0.6]);
    assert.equal(st.size, 5);
    assert.deepEqual([im.x, im.y, im.w, im.h], [50, 50, 200, 150]);
    assert.deepEqual([tx.x, tx.w, tx.size], [25, 300, 40]);
    assert.deepEqual([sh.x2, sh.y2, sh.size], [50, 25, 5]);
    assert.deepEqual([nt.x, nt.y], [50, 100]);
  });
  test('scaleItem returns null when the result is invalid', () => {
    assert.equal(scaleItem(text('t', { w: 20 }), 0.1, 0.1), null);
    assert.equal(scaleItem(note('n'), 2, 3).x, 200);
  });
  test('insertBox stays on a book page', () => {
    const b = insertBox(1000, 500, { x: 0, y: 0, w: 612, h: 792 }, 0.6, { w: 612, h: 792 });
    assert.ok(b.x >= 0 && b.x + b.w <= 612 + 1e-6);
    assert.ok(Math.abs(b.w / b.h - 2) < 1e-6);
  });
});
