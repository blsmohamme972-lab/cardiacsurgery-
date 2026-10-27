/**
 * Scratchpad scene model (docs/ARCHITECTURE.md §4 "Scratchpad record", §7.16). Pure.
 *
 * A scene is `{ v: 2, page: { w, h, bg }, items: Item[] }` with items in
 * z-order (first = bottom). Every change goes through a *command*; applying
 * a command returns a new scene (items that did not change are shared, never
 * mutated) plus the command that undoes it, so undo/redo is exact.
 *
 * Commands:
 * - `{ type: 'add', items, index? }`        insert items (at `index`, default on top)
 * - `{ type: 'remove', ids }`               remove items
 * - `{ type: 'update', items }`             replace items by id (move, resize, rotate, restyle, edit text)
 * - `{ type: 'style', ids, patch }`         restyle (`color`, `size`) → an update
 * - `{ type: 'transform', ids, dx, dy }`    move items → an update
 * - `{ type: 'order', ids }`                set the full z-order (front/back use {@link reorderIds})
 * - `{ type: 'clear' }`                     remove every item
 * - `{ type: 'page', bg }`                  page template
 * - `{ type: 'insert', entries }`           internal inverse of remove/clear
 *
 * Item coordinates are page units (2000 × 3000 page), rounded to 1 decimal
 * when serialized. Importing this module touches no DOM.
 *
 * @module features/scratch/scene
 */

import { uid } from '../../core/util.js';

/** Page width in units. */
export const PAGE_W = 2000;
/** Page height in units. */
export const PAGE_H = 3000;
/** Scene format version. */
export const SCENE_VERSION = 2;
/** Page templates. */
export const BACKGROUNDS = Object.freeze(['plain', 'dots', 'grid', 'lines']);
/** Shape kinds. */
export const SHAPES = Object.freeze(['line', 'arrow', 'rect', 'ellipse']);
/** Item types. */
export const ITEM_TYPES = Object.freeze(['stroke', 'image', 'text', 'shape']);
/** Undo steps kept. */
export const HISTORY_LIMIT = 300;
/** Most items one scene keeps (a corrupt record can never freeze the app). */
export const MAX_ITEMS = 20000;
/** Most points (x, y, p triples) in one stroke. */
export const MAX_STROKE_POINTS = 6000;
/** Longest text box content. */
export const MAX_TEXT = 5000;

/**
 * The eight scratchpad colours: stored `hex`, and a lighter `dark` twin used
 * to paint the same ink on dark paper.
 * @type {ReadonlyArray<Readonly<{ hex: string, name: string, dark: string }>>}
 */
export const SCRATCH_COLORS = Object.freeze([
  Object.freeze({ hex: '#111827', name: 'Black', dark: '#f3f4f6' }),
  Object.freeze({ hex: '#1d4ed8', name: 'Blue', dark: '#7aa7ff' }),
  Object.freeze({ hex: '#dc2626', name: 'Red', dark: '#ff8a80' }),
  Object.freeze({ hex: '#15803d', name: 'Green', dark: '#5fd68f' }),
  Object.freeze({ hex: '#ea580c', name: 'Orange', dark: '#fdba74' }),
  Object.freeze({ hex: '#eab308', name: 'Yellow', dark: '#fde047' }),
  Object.freeze({ hex: '#db2777', name: 'Pink', dark: '#f9a8d4' }),
  Object.freeze({ hex: '#7c3aed', name: 'Purple', dark: '#c4b5fd' }),
]);

/**
 * The three sizes (setting `scratchSize` 0|1|2) in page units per tool.
 * @type {Readonly<{ names: readonly string[], pen: readonly number[], hl: readonly number[], text: readonly number[], shape: readonly number[] }>}
 */
export const SCRATCH_SIZES = Object.freeze({
  names: Object.freeze(['Thin', 'Medium', 'Thick']),
  pen: Object.freeze([5, 10, 20]),
  hl: Object.freeze([28, 48, 80]),
  text: Object.freeze([56, 80, 120]),
  shape: Object.freeze([6, 10, 18]),
});

const HEX_RE = /^#[0-9a-f]{6}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_COLOR = '#1d4ed8';

/**
 * @typedef {{ id: string, type: 'stroke', tool: 'pen' | 'hl', color: string, size: number, pts: number[] }} StrokeItem
 * @typedef {{ id: string, type: 'image', media: string, x: number, y: number, w: number, h: number, rot: number }} ImageItem
 * @typedef {{ id: string, type: 'text', x: number, y: number, w: number, text: string, color: string, size: number }} TextItem
 * @typedef {{ id: string, type: 'shape', shape: 'line' | 'arrow' | 'rect' | 'ellipse', x1: number, y1: number,
 *   x2: number, y2: number, color: string, size: number, fill: boolean }} ShapeItem
 * @typedef {StrokeItem | ImageItem | TextItem | ShapeItem} Item
 * @typedef {{ w: number, h: number, bg: 'plain' | 'dots' | 'grid' | 'lines' }} Page
 * @typedef {{ v: 2, page: Page, items: Item[] }} Scene
 * @typedef {Record<string, any> & { type: string }} Command
 */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Rounds to 1 decimal (the stored precision); never returns -0.
 * @param {number} n
 * @returns {number}
 */
export function round1(n) {
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
function clampNum(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/** @param {unknown} n */
const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * The colour to paint a stored colour with (palette colours get a lighter
 * twin on dark paper). Unknown or invalid colours fall back to black/white.
 * @param {string} hex
 * @param {boolean} dark
 * @returns {string}
 */
export function paintColor(hex, dark) {
  const c = typeof hex === 'string' ? hex.toLowerCase() : '';
  if (!HEX_RE.test(c)) return dark ? SCRATCH_COLORS[0].dark : SCRATCH_COLORS[0].hex;
  if (!dark) return c;
  const entry = SCRATCH_COLORS.find((e) => e.hex === c);
  return entry ? entry.dark : c;
}

/**
 * A size index (0|1|2) from any value (default 1).
 * @param {unknown} v
 * @returns {0 | 1 | 2}
 */
export function sizeIndex(v) {
  const n = Number(v);
  return /** @type {0 | 1 | 2} */ (n === 0 || n === 1 || n === 2 ? n : 1);
}

/**
 * An empty scene.
 * @param {Page['bg']} [bg='dots']
 * @returns {Scene}
 */
export function emptyScene(bg = 'dots') {
  return { v: SCENE_VERSION, page: { w: PAGE_W, h: PAGE_H, bg: BACKGROUNDS.includes(bg) ? bg : 'dots' }, items: [] };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/** Coordinates may sit a little outside the page (dragged off the edge), never absurdly far. */
const COORD_LIMIT = 20000;

/** @param {unknown} n */
const coord = (n) => (finite(n) && Math.abs(/** @type {number} */ (n)) <= COORD_LIMIT ? round1(/** @type {number} */ (n)) : null);

/**
 * Validates and normalises one item; returns null when unusable.
 * Unknown fields are dropped; numbers are rounded to 1 decimal.
 * @param {any} raw
 * @returns {Item | null}
 */
export function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const color = typeof raw.color === 'string' && HEX_RE.test(raw.color) ? raw.color.toLowerCase() : DEFAULT_COLOR;
  switch (raw.type) {
    case 'stroke': {
      const tool = raw.tool === 'hl' ? 'hl' : raw.tool === 'pen' ? 'pen' : null;
      const size = finite(raw.size) && raw.size > 0 ? round1(clampNum(raw.size, 0.5, 400)) : null;
      if (!tool || !size || !Array.isArray(raw.pts)) return null;
      const n = Math.min(raw.pts.length - (raw.pts.length % 3), MAX_STROKE_POINTS * 3);
      /** @type {number[]} */
      const pts = [];
      for (let i = 0; i < n; i += 3) {
        const x = coord(raw.pts[i]);
        const y = coord(raw.pts[i + 1]);
        if (x === null || y === null) continue;
        const p = finite(raw.pts[i + 2]) ? Math.round(clampNum(raw.pts[i + 2], 0, 1) * 100) / 100 : 0.5;
        pts.push(x, y, p);
      }
      return pts.length ? { id, type: 'stroke', tool, color, size, pts } : null;
    }
    case 'image': {
      const media = typeof raw.media === 'string' && raw.media && raw.media.length <= 128 ? raw.media : null;
      const x = coord(raw.x);
      const y = coord(raw.y);
      const w = coord(raw.w);
      const ht = coord(raw.h);
      if (!media || x === null || y === null || w === null || ht === null || w < 1 || ht < 1) return null;
      const rot = finite(raw.rot) ? normalizeAngle(raw.rot) : 0;
      return { id, type: 'image', media, x, y, w, h: ht, rot: Math.round(rot * 10000) / 10000 };
    }
    case 'text': {
      const x = coord(raw.x);
      const y = coord(raw.y);
      const w = coord(raw.w);
      const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '';
      const size = finite(raw.size) && raw.size > 0 ? round1(clampNum(raw.size, 8, 600)) : null;
      if (x === null || y === null || w === null || w < 10 || !size || !text.trim()) return null;
      return { id, type: 'text', x, y, w, text, color, size };
    }
    case 'shape': {
      const shape = SHAPES.includes(raw.shape) ? raw.shape : null;
      const x1 = coord(raw.x1);
      const y1 = coord(raw.y1);
      const x2 = coord(raw.x2);
      const y2 = coord(raw.y2);
      const size = finite(raw.size) && raw.size > 0 ? round1(clampNum(raw.size, 0.5, 200)) : null;
      if (!shape || x1 === null || y1 === null || x2 === null || y2 === null || !size) return null;
      return { id, type: 'shape', shape, x1, y1, x2, y2, color, size, fill: raw.fill === true };
    }
    default:
      return null;
  }
}

/**
 * An angle in (-π, π].
 * @param {number} a
 * @returns {number}
 */
export function normalizeAngle(a) {
  if (!finite(a)) return 0;
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Reads a stored scene: validates every item (bad ones are dropped, never
 * thrown), drops duplicate ids, keeps the z-order. Anything unusable gives an
 * empty scene.
 * @param {any} raw
 * @param {{ bg?: Page['bg'] }} [opts] Template for a missing/invalid page.
 * @returns {Scene}
 */
export function deserialize(raw, { bg = 'dots' } = {}) {
  const scene = emptyScene(bg);
  if (!raw || typeof raw !== 'object') return scene;
  if (raw.page && typeof raw.page === 'object' && BACKGROUNDS.includes(raw.page.bg)) scene.page.bg = raw.page.bg;
  const list = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  for (const r of list) {
    if (scene.items.length >= MAX_ITEMS) break;
    const it = sanitizeItem(r);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    scene.items.push(it);
  }
  return scene;
}

/**
 * A plain JSON copy of a scene for storage (numbers rounded to 1 decimal).
 * @param {Scene} scene
 * @returns {Scene}
 */
export function serialize(scene) {
  const out = emptyScene(scene?.page?.bg);
  for (const it of Array.isArray(scene?.items) ? scene.items : []) {
    const clean = sanitizeItem(it);
    if (clean) out.items.push(clean);
  }
  return out;
}

/**
 * Converts legacy scratchpad strokes (v1: fractions of a 2000 × 3000 page,
 * size a fraction of the width) into a v2 scene.
 * @param {any[]} strokes
 * @param {{ idFn?: () => string, bg?: Page['bg'] }} [opts]
 * @returns {Scene}
 */
export function migrateV1(strokes, { idFn = uid, bg = 'dots' } = {}) {
  const scene = emptyScene(bg);
  for (const s of Array.isArray(strokes) ? strokes : []) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.pts)) continue;
    const pts = [];
    for (let i = 0; i + 2 < s.pts.length; i += 3) {
      pts.push(s.pts[i] * PAGE_W, s.pts[i + 1] * PAGE_H, s.pts[i + 2]);
    }
    const it = sanitizeItem({
      id: idFn(),
      type: 'stroke',
      tool: s.tool,
      color: s.color,
      size: finite(s.size) ? s.size * PAGE_W : NaN,
      pts,
    });
    if (it) scene.items.push(it);
  }
  return scene;
}

/**
 * Media ids referenced by a scene's images.
 * @param {Scene} scene
 * @returns {Set<string>}
 */
export function mediaIds(scene) {
  const out = new Set();
  for (const it of scene?.items || []) if (it.type === 'image') out.add(it.media);
  return out;
}

/* ------------------------------------------------------------------ */
/* Item helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * A copy of an item moved by (dx, dy).
 * @template {Item} T
 * @param {T} it
 * @param {number} dx
 * @param {number} dy
 * @returns {T}
 */
export function moveItem(it, dx, dy) {
  switch (it.type) {
    case 'stroke': {
      const pts = it.pts.slice();
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] += dx;
        pts[i + 1] += dy;
      }
      return /** @type {T} */ ({ ...it, pts });
    }
    case 'shape':
      return /** @type {T} */ ({ ...it, x1: it.x1 + dx, y1: it.y1 + dy, x2: it.x2 + dx, y2: it.y2 + dy });
    default:
      return /** @type {T} */ ({ ...it, x: /** @type {any} */ (it).x + dx, y: /** @type {any} */ (it).y + dy });
  }
}

/**
 * A copy of an item with a new id (and moved by an offset), for Duplicate.
 * @template {Item} T
 * @param {T} it
 * @param {number} [offset=40]
 * @param {() => string} [idFn]
 * @returns {T}
 */
export function cloneItem(it, offset = 40, idFn = uid) {
  return { ...moveItem(it, offset, offset), id: idFn() };
}

/**
 * Applies a style patch (`color`, `size`) to an item where it makes sense
 * (images have no colour or size).
 * @template {Item} T
 * @param {T} it
 * @param {{ color?: string, size?: number }} patch
 * @returns {T}
 */
export function styleItem(it, patch) {
  if (it.type === 'image') return it;
  const next = /** @type {any} */ ({ ...it });
  if (typeof patch.color === 'string' && HEX_RE.test(patch.color)) next.color = patch.color.toLowerCase();
  if (finite(patch.size) && /** @type {number} */ (patch.size) > 0) next.size = patch.size;
  return next;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * The z-order after moving ids to the front or back.
 * @param {Item[]} items
 * @param {string[]} ids
 * @param {'front' | 'back' | 'forward' | 'backward'} where
 * @returns {string[]}
 */
export function reorderIds(items, ids, where) {
  const sel = new Set(ids);
  const order = items.map((i) => i.id);
  const picked = order.filter((id) => sel.has(id));
  const rest = order.filter((id) => !sel.has(id));
  if (where === 'front') return [...rest, ...picked];
  if (where === 'back') return [...picked, ...rest];
  // One step: swap with the neighbour that is not selected.
  const out = order.slice();
  if (where === 'forward') {
    for (let i = out.length - 2; i >= 0; i--) {
      if (sel.has(out[i]) && !sel.has(out[i + 1])) [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (sel.has(out[i]) && !sel.has(out[i - 1])) [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
  }
  return out;
}

/**
 * Applies a command. Pure: returns a new scene (or the same scene when the
 * command changes nothing) and the inverse command (null when nothing changed).
 * @param {Scene} scene
 * @param {Command} cmd
 * @returns {{ scene: Scene, inverse: Command | null }}
 */
export function applyCommand(scene, cmd) {
  const none = { scene, inverse: null };
  if (!cmd || typeof cmd !== 'object') return none;
  const items = scene.items;
  switch (cmd.type) {
    case 'add': {
      const ids = new Set(items.map((i) => i.id));
      const add = (Array.isArray(cmd.items) ? cmd.items : []).filter((it) => it && typeof it.id === 'string' && !ids.has(it.id));
      if (!add.length) return none;
      const index = Number.isInteger(cmd.index) ? clampNum(cmd.index, 0, items.length) : items.length;
      const next = [...items.slice(0, index), ...add, ...items.slice(index)];
      return { scene: { ...scene, items: next }, inverse: { type: 'remove', ids: add.map((i) => i.id) } };
    }
    case 'insert': {
      const entries = (Array.isArray(cmd.entries) ? cmd.entries : []).slice().sort((a, b) => a.index - b.index);
      if (!entries.length) return none;
      const next = items.slice();
      for (const e of entries) next.splice(clampNum(e.index, 0, next.length), 0, e.item);
      return { scene: { ...scene, items: next }, inverse: { type: 'remove', ids: entries.map((e) => e.item.id) } };
    }
    case 'remove': {
      const ids = new Set(Array.isArray(cmd.ids) ? cmd.ids : []);
      /** @type {{ index: number, item: Item }[]} */
      const entries = [];
      const next = [];
      items.forEach((it, index) => {
        if (ids.has(it.id)) entries.push({ index, item: it });
        else next.push(it);
      });
      if (!entries.length) return none;
      return { scene: { ...scene, items: next }, inverse: { type: 'insert', entries } };
    }
    case 'clear': {
      if (!items.length) return none;
      return {
        scene: { ...scene, items: [] },
        inverse: { type: 'insert', entries: items.map((item, index) => ({ index, item })) },
      };
    }
    case 'update': {
      /** @type {Map<string, Item>} */
      const map = new Map();
      for (const it of Array.isArray(cmd.items) ? cmd.items : []) if (it && typeof it.id === 'string') map.set(it.id, it);
      const before = [];
      let changed = false;
      const next = items.map((it) => {
        const repl = map.get(it.id);
        if (!repl || repl === it) return it;
        before.push(it);
        changed = true;
        return repl;
      });
      if (!changed) return none;
      return { scene: { ...scene, items: next }, inverse: { type: 'update', items: before } };
    }
    case 'style': {
      const ids = new Set(Array.isArray(cmd.ids) ? cmd.ids : []);
      const patch = cmd.patch || {};
      const updated = items.filter((it) => ids.has(it.id)).map((it) => styleItem(it, patch));
      const real = updated.filter((u) => {
        const old = items.find((i) => i.id === u.id);
        return old && (/** @type {any} */ (old).color !== /** @type {any} */ (u).color || /** @type {any} */ (old).size !== /** @type {any} */ (u).size);
      });
      return applyCommand(scene, { type: 'update', items: real });
    }
    case 'transform': {
      const ids = new Set(Array.isArray(cmd.ids) ? cmd.ids : []);
      const dx = finite(cmd.dx) ? cmd.dx : 0;
      const dy = finite(cmd.dy) ? cmd.dy : 0;
      if (!dx && !dy) return none;
      return applyCommand(scene, { type: 'update', items: items.filter((it) => ids.has(it.id)).map((it) => moveItem(it, dx, dy)) });
    }
    case 'order': {
      const order = Array.isArray(cmd.ids) ? cmd.ids : [];
      const byId = new Map(items.map((i) => [i.id, i]));
      const next = [];
      const used = new Set();
      for (const id of order) {
        const it = byId.get(id);
        if (it && !used.has(id)) {
          next.push(it);
          used.add(id);
        }
      }
      for (const it of items) if (!used.has(it.id)) next.push(it);
      if (next.every((it, i) => it === items[i])) return none;
      return { scene: { ...scene, items: next }, inverse: { type: 'order', ids: items.map((i) => i.id) } };
    }
    case 'page': {
      const bg = BACKGROUNDS.includes(cmd.bg) ? cmd.bg : null;
      if (!bg || bg === scene.page.bg) return none;
      return { scene: { ...scene, page: { ...scene.page, bg } }, inverse: { type: 'page', bg: scene.page.bg } };
    }
    default:
      return none;
  }
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

/**
 * Undo/redo over a scene. Every command is undoable.
 * @param {Scene} [initial]
 * @param {{ limit?: number }} [opts]
 * @returns {{
 *   readonly scene: Scene,
 *   apply(cmd: Command): boolean,
 *   undo(): Command | null,
 *   redo(): Command | null,
 *   canUndo(): boolean,
 *   canRedo(): boolean,
 *   reset(scene: Scene): void,
 *   size(): { undo: number, redo: number },
 * }}
 *   `apply` returns true when the scene changed; `undo`/`redo` return the command they applied (null when none).
 */
export function createHistory(initial = emptyScene(), { limit = HISTORY_LIMIT } = {}) {
  let scene = initial;
  /** @type {{ cmd: Command, inverse: Command }[]} */
  const undoStack = [];
  /** @type {{ cmd: Command, inverse: Command }[]} */
  const redoStack = [];
  return {
    get scene() {
      return scene;
    },
    apply(cmd) {
      const res = applyCommand(scene, cmd);
      if (!res.inverse) return false;
      scene = res.scene;
      undoStack.push({ cmd, inverse: res.inverse });
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      return true;
    },
    undo() {
      const e = undoStack.pop();
      if (!e) return null;
      const res = applyCommand(scene, e.inverse);
      scene = res.scene;
      // Re-derive the redo command from the actual result so redo is exact.
      redoStack.push({ cmd: res.inverse || e.cmd, inverse: e.inverse });
      return e.inverse;
    },
    redo() {
      const e = redoStack.pop();
      if (!e) return null;
      const res = applyCommand(scene, e.cmd);
      scene = res.scene;
      undoStack.push({ cmd: e.cmd, inverse: res.inverse || e.inverse });
      return e.cmd;
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    reset(next) {
      scene = next;
      undoStack.length = 0;
      redoStack.length = 0;
    },
    size: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}

/**
 * Builds a new item with a fresh id (helpers for tools).
 * @param {Omit<Item, 'id'> & { id?: string }} fields
 * @param {() => string} [idFn]
 * @returns {Item}
 */
export function makeItem(fields, idFn = uid) {
  return /** @type {Item} */ ({ ...fields, id: fields.id || idFn() });
}
