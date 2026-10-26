/**
 * Ink engine (docs/ARCHITECTURE.md §7.7 "annotate/ink.js", §4 Stroke / inkRepo).
 *
 * Three layers, from pure to DOM:
 *
 * 1. **Pure geometry** (unit-tested in Node): {@link strokeToPath} turns a
 *    stored stroke into a variable-width outline polygon, {@link hitStroke}
 *    tests the eraser, {@link simulatePressure} / {@link smoothPoint} shape
 *    raw input, {@link createInkHistory} is the undo/redo model.
 * 2. **Rendering**: {@link renderStrokes} draws strokes on a 2D context
 *    (highlighter under pen, cached `Path2D` per stroke). Shared by the
 *    per-block layers and the scratchpad.
 * 3. **Engine + layers**: {@link createInkEngine} owns input (Pointer Events,
 *    pressure, palm rejection, two-finger scroll), history and saving to
 *    `inkRepo` for any number of drawing *surfaces*. {@link initInk} lays one
 *    transparent `<canvas class="ink-layer">` over every `[data-block]`
 *    element of a question and returns its controller.
 *
 * Stored coordinates are fractions of the surface's width/height rounded to
 * 4 decimals (§4), so ink stays in place after rotation, a different screen or
 * a font-size change. Stroke `size` is a fraction of the surface width.
 *
 * Never lose ink: every change is saved (debounced 400 ms) and flushed on
 * disable, destroy, `pagehide` and when the page is hidden. A failed save
 * keeps the strokes dirty and offers "Retry".
 *
 * Importing this module does not touch `document` or `window`.
 *
 * @module features/annotate/ink
 */

import { h } from '../../core/dom.js';
import { bus } from '../../core/events.js';
import { inkRepo } from '../../core/store/repo.js';
import { getSetting } from '../../core/settings.js';
import { toast } from '../../ui/components.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/**
 * The six ink colours: stored `hex` and the lighter `dark` variant used to
 * display the same ink on a dark background.
 * @type {ReadonlyArray<Readonly<{ hex: string, name: string, dark: string }>>}
 */
export const INK_COLORS = Object.freeze([
  Object.freeze({ hex: '#111827', name: 'Black', dark: '#f3f4f6' }),
  Object.freeze({ hex: '#1d4ed8', name: 'Blue', dark: '#7aa7ff' }),
  Object.freeze({ hex: '#dc2626', name: 'Red', dark: '#ff8a80' }),
  Object.freeze({ hex: '#15803d', name: 'Green', dark: '#5fd68f' }),
  Object.freeze({ hex: '#eab308', name: 'Yellow', dark: '#fde047' }),
  Object.freeze({ hex: '#db2777', name: 'Pink', dark: '#f9a8d4' }),
]);

/**
 * The three pen sizes (fractions of the reference width, see settings `inkSize`).
 * @type {ReadonlyArray<Readonly<{ value: number, name: string }>>}
 */
export const INK_SIZES = Object.freeze([
  Object.freeze({ value: 0.003, name: 'Thin' }),
  Object.freeze({ value: 0.006, name: 'Medium' }),
  Object.freeze({ value: 0.012, name: 'Thick' }),
]);

/** Tools a controller accepts. */
export const INK_TOOLS = Object.freeze(['pen', 'hl', 'eraser']);

/** Highlighter opacity. */
export const HL_ALPHA = 0.35;

/** The highlighter is this many times wider than the pen at the same size. */
export const HL_SIZE_FACTOR = 4;

/** Ink block id used by the scratchpad. */
export const SCRATCH_BLOCK = 'scratch';

/** Debounce for saving to IndexedDB. */
export const SAVE_DELAY_MS = 400;

/** Undo steps kept per controller. */
const HISTORY_LIMIT = 200;

/** Max points (x, y, p triples) in one stroke before it is split. */
const MAX_STROKE_POINTS = 4000;

/** Max pixels of one layer canvas (iOS has a tight total canvas budget). */
const MAX_CANVAS_PIXELS = 4_000_000;

/** Eraser radius in CSS pixels. */
const ERASER_RADIUS_PX = 12;

const HEX_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = '#1d4ed8';
const DEFAULT_SIZE = 0.006;

/* ------------------------------------------------------------------ */
/* Typedefs                                                            */
/* ------------------------------------------------------------------ */

/**
 * A stored stroke (§4). Coordinates are fractions of the surface size.
 * @typedef {{ tool: 'pen' | 'hl', color: string, size: number, pts: number[] }} Stroke
 */

/**
 * A drawing surface the engine can drive: a per-block layer or the scratchpad.
 * All coordinates are *logical* units of that surface (CSS px for layers,
 * page units for the scratchpad).
 * @typedef {object} Surface
 * @property {string} block Ink block id this surface stores to.
 * @property {HTMLElement} el Element that receives pointer events.
 * @property {() => { w: number, h: number }} size Logical size (stroke fractions refer to it).
 * @property {(clientX: number, clientY: number) => { x: number, y: number }} toLocal Client → logical.
 * @property {() => number} scale CSS pixels per logical unit (zoom).
 * @property {() => number} refWidth Logical width that `inkSize` is a fraction of.
 * @property {(strokes: Stroke[], dark: boolean) => void} render Full redraw of committed strokes.
 * @property {() => void} beginLive Prepare the live overlay.
 * @property {(stroke: Stroke | null, cursor: { x: number, y: number, r: number } | null, dark: boolean) => void} drawLive
 * @property {() => void} endLive Remove the live overlay.
 * @property {(active: boolean, touchAction: string, tool: string) => void} setInteractive
 * @property {boolean} [handlesGestures] Surface does its own pinch/pan (scratchpad).
 * @property {(pts: { x: number, y: number }[]) => void} [gestureStart]
 * @property {(pts: { x: number, y: number }[]) => void} [gestureMove]
 * @property {() => void} [gestureEnd]
 * @property {() => void} destroy
 */

/**
 * Controller returned by {@link initInk} and {@link createInkEngine}.
 * @typedef {object} InkController
 * @property {() => void} enable
 * @property {() => Promise<void>} disable Commits a stroke in progress and saves.
 * @property {() => boolean} isEnabled
 * @property {(tool: 'pen' | 'hl' | 'eraser') => void} setTool
 * @property {(hex: string) => void} setColor
 * @property {(frac: number) => void} setSize
 * @property {() => { tool: string, color: string, size: number, enabled: boolean }} getState
 * @property {(token?: object) => boolean} undo With a token (from clearAll), undoes only that action.
 * @property {() => boolean} redo
 * @property {() => boolean} canUndo
 * @property {() => boolean} canRedo
 * @property {() => boolean} isEmpty True when no visible surface has ink.
 * @property {() => object | null} clearAll Undoable; returns an undo token or null when nothing was cleared.
 * @property {() => string[]} staleBlocks Blocks whose ink was drawn on another question version.
 * @property {() => Promise<void>} flush Saves pending changes now.
 * @property {() => void} refresh Re-scans `[data-block]` elements (layers only; also automatic).
 * @property {Promise<void>} ready Resolves when saved ink has loaded (never rejects).
 * @property {() => Promise<void>} destroy Saves, removes layers and listeners.
 * @property {(event: string, fn: (payload: any) => void) => () => void} on
 *   Events: `change` {canUndo, canRedo, empty}, `tool` {tool, color, size}, `enable` {enabled},
 *   `strokestart` {block}, `stale` {blocks} (replayed to late subscribers when non-empty),
 *   `ready`, `saved` {blocks}, `error` {error}, `destroy`.
 */

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Rounds to a fixed number of decimals (default 4, the stored precision).
 * @param {number} n
 * @param {number} [decimals=4]
 * @returns {number}
 */
export function roundFrac(n, decimals = 4) {
  const f = 10 ** decimals;
  const r = Math.round(n * f) / f;
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

/**
 * The colour to paint a stored ink colour with in the current theme
 * (palette colours get a lighter twin on dark backgrounds).
 * @param {string} hex
 * @param {boolean} dark
 * @returns {string}
 */
export function displayColor(hex, dark) {
  const c = typeof hex === 'string' ? hex.toLowerCase() : '';
  if (!HEX_RE.test(c)) return dark ? INK_COLORS[0].dark : INK_COLORS[0].hex;
  if (!dark) return c;
  const entry = INK_COLORS.find((e) => e.hex === c);
  return entry ? entry.dark : c;
}

/**
 * Simulated pressure for touch and mouse from drawing speed: slow strokes are
 * fuller, fast strokes thinner, eased so the width never jumps.
 * @param {number} prev Previous pressure (0..1).
 * @param {number} speed CSS px per millisecond.
 * @returns {number} 0.3..1, rounded to 2 decimals.
 */
export function simulatePressure(prev, speed) {
  const p0 = Number.isFinite(prev) ? prev : 0.6;
  const v = Number.isFinite(speed) && speed > 0 ? speed : 0;
  const target = clampNum(1.05 - v * 0.32, 0.3, 1);
  return roundFrac(clampNum(p0 + (target - p0) * 0.28, 0.3, 1), 2);
}

/**
 * Streamline smoothing: moves the previous smoothed point part of the way
 * toward the raw input (higher `amount` = smoother, laggier).
 * @param {{ x: number, y: number } | null} prev
 * @param {{ x: number, y: number }} raw
 * @param {number} amount 0..0.95
 * @returns {{ x: number, y: number }}
 */
export function smoothPoint(prev, raw, amount) {
  if (!prev) return { x: raw.x, y: raw.y };
  const t = 1 - clampNum(amount, 0, 0.95);
  return { x: prev.x + (raw.x - prev.x) * t, y: prev.y + (raw.y - prev.y) * t };
}

/**
 * Validates and normalises a stored stroke; returns null when unusable.
 * @param {any} s
 * @returns {Stroke | null}
 */
export function sanitizeStroke(s) {
  if (!s || typeof s !== 'object') return null;
  const tool = s.tool === 'hl' ? 'hl' : s.tool === 'pen' ? 'pen' : null;
  if (!tool) return null;
  const color = typeof s.color === 'string' && HEX_RE.test(s.color) ? s.color.toLowerCase() : null;
  const size = typeof s.size === 'number' && Number.isFinite(s.size) && s.size > 0 && s.size <= 1 ? s.size : null;
  if (!color || !size || !Array.isArray(s.pts)) return null;
  const n = s.pts.length - (s.pts.length % 3);
  if (n < 3) return null;
  /** @type {number[]} */
  const pts = [];
  for (let i = 0; i < n; i += 3) {
    const x = s.pts[i];
    const y = s.pts[i + 1];
    const p = s.pts[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 10 || Math.abs(y) > 10) continue;
    pts.push(x, y, Number.isFinite(p) ? clampNum(p, 0, 1) : 0.5);
  }
  return pts.length ? { tool, color, size, pts } : null;
}

/**
 * Stroke points in pixels, without near-duplicates (< 0.4 px apart).
 * @param {Stroke} stroke
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, p: number }[]}
 */
function pixelPoints(stroke, width, height) {
  const src = stroke && Array.isArray(stroke.pts) ? stroke.pts : [];
  /** @type {{ x: number, y: number, p: number }[]} */
  const out = [];
  for (let i = 0; i + 2 < src.length; i += 3) {
    const x = src[i] * width;
    const y = src[i + 1] * height;
    const p = Number.isFinite(src[i + 2]) ? clampNum(src[i + 2], 0, 1) : 0.5;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (last && Math.hypot(x - last.x, y - last.y) < 0.4) {
      last.p = Math.max(last.p, p);
      continue;
    }
    out.push({ x, y, p });
  }
  return out;
}

/**
 * Half the drawn width of a stroke at a given pressure, in pixels.
 * Pen: pressure-sensitive (0.3–1.25× the base). Highlighter: constant.
 * @param {Stroke} stroke
 * @param {number} width Surface width in pixels.
 * @param {number} p Pressure 0..1.
 * @returns {number}
 */
export function strokeRadius(stroke, width, p) {
  const base = Math.max(0.35, ((Number(stroke?.size) || DEFAULT_SIZE) * width) / 2);
  if (stroke?.tool === 'hl') return base;
  return base * (0.3 + 0.95 * clampNum(Number.isFinite(p) ? p : 0.5, 0, 1));
}

/**
 * Points on a circle (used for dots and caps).
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {number} from Start angle.
 * @param {number} to End angle.
 * @param {number} steps
 * @returns {number[][]}
 */
function arc(cx, cy, r, from, to, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/**
 * Variable-width outline of a stroke as a closed polygon in pixels
 * (pressure shapes the width; simulated pressure already encodes speed).
 * Round caps at both ends; a single point becomes a dot. Pure.
 *
 * @param {Stroke} stroke
 * @param {number} width Surface width in pixels.
 * @param {number} height Surface height in pixels.
 * @returns {number[][]} `[[x, y], ...]` (empty for an empty stroke).
 */
export function strokeToPath(stroke, width, height) {
  if (!(width > 0) || !(height > 0)) return [];
  const pts = pixelPoints(stroke, width, height);
  if (pts.length === 0) return [];
  // Ease the radius along the stroke so pressure noise never looks jagged.
  const raw = pts.map((q) => strokeRadius(stroke, width, q.p));
  const rad = raw.map((r, i) => {
    const a = raw[Math.max(0, i - 1)];
    const b = raw[Math.min(raw.length - 1, i + 1)];
    return (a + 2 * r + b) / 4;
  });
  if (pts.length === 1) {
    const r = rad[0];
    return arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2, 16).slice(0, 16);
  }
  const n = pts.length;
  /** @type {number[][]} */
  const left = [];
  /** @type {number[][]} */
  const right = [];
  /** @type {number[]} */
  const angles = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    left.push([pts[i].x + nx * rad[i], pts[i].y + ny * rad[i]]);
    right.push([pts[i].x - nx * rad[i], pts[i].y - ny * rad[i]]);
    angles.push(Math.atan2(ny, nx));
  }
  const capSteps = 6;
  const a0 = angles[0];
  const an = angles[n - 1];
  // End cap: from the left edge around the front to the right edge.
  const endCap = arc(pts[n - 1].x, pts[n - 1].y, rad[n - 1], an, an - Math.PI, capSteps).slice(1, -1);
  // Start cap: from the right edge around the back to the left edge.
  const startCap = arc(pts[0].x, pts[0].y, rad[0], a0 - Math.PI, a0 - 2 * Math.PI, capSteps).slice(1, -1);
  return [...left, ...endCap, ...right.reverse(), ...startCap];
}

/**
 * Distance from a point to a segment.
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 */
function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clampNum(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Does an eraser circle at (x, y) touch the stroke? Pure.
 * @param {Stroke} stroke
 * @param {number} x Eraser centre, pixels.
 * @param {number} y
 * @param {number} radius Eraser radius, pixels.
 * @param {number} width Surface width, pixels.
 * @param {number} height Surface height, pixels.
 * @returns {boolean}
 */
export function hitStroke(stroke, x, y, radius, width, height) {
  const pts = pixelPoints(stroke, width, height);
  if (!pts.length) return false;
  const reach = radius + strokeRadius(stroke, width, 1);
  if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= reach) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* History (pure)                                                      */
/* ------------------------------------------------------------------ */

/**
 * Undo/redo model over strokes grouped by block. Strokes are tracked by
 * identity, so the same object goes back exactly where it was. Pure.
 *
 * @param {{ limit?: number }} [opts]
 * @returns {{
 *   strokes(block: string): Stroke[],
 *   blocks(): string[],
 *   load(block: string, strokes: Stroke[]): void,
 *   add(block: string, stroke: Stroke): string[],
 *   erase(block: string, stroke: Stroke): boolean,
 *   endErase(): string[],
 *   clear(blocks: string[]): { token: object, changed: string[] } | null,
 *   undo(token?: object): string[] | null,
 *   redo(): string[] | null,
 *   canUndo(): boolean,
 *   canRedo(): boolean,
 * }}
 */
export function createInkHistory({ limit = HISTORY_LIMIT } = {}) {
  /** @type {Map<string, Stroke[]>} */
  const map = new Map();
  /** @type {any[]} */
  const undoStack = [];
  /** @type {any[]} */
  const redoStack = [];
  /** @type {{ block: string, stroke: Stroke, index: number }[]} */
  let pendingErase = [];

  /** @param {string} block */
  const list = (block) => {
    let arr = map.get(block);
    if (!arr) {
      arr = [];
      map.set(block, arr);
    }
    return arr;
  };
  /** @param {any} action */
  const push = (action) => {
    undoStack.push(action);
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
  };
  /**
   * @param {string} block
   * @param {Stroke} stroke
   */
  const removeStroke = (block, stroke) => {
    const arr = list(block);
    const i = arr.lastIndexOf(stroke);
    if (i !== -1) arr.splice(i, 1);
    return i;
  };
  /** @param {any} a */
  const blocksOf = (a) =>
    a.type === 'add' ? [a.block] : [...new Set(a.items.map((/** @type {any} */ it) => it.block))];

  return {
    strokes: (block) => list(block),
    blocks: () => [...map.keys()],
    load(block, strokes) {
      const arr = list(block);
      arr.unshift(...strokes);
    },
    add(block, stroke) {
      list(block).push(stroke);
      push({ type: 'add', block, stroke });
      return [block];
    },
    erase(block, stroke) {
      const index = removeStroke(block, stroke);
      if (index === -1) return false;
      pendingErase.push({ block, stroke, index });
      return true;
    },
    endErase() {
      const items = pendingErase;
      pendingErase = [];
      if (!items.length) return [];
      const action = { type: 'erase', items };
      push(action);
      return blocksOf(action);
    },
    clear(blocks) {
      const items = [];
      for (const block of blocks) {
        const arr = list(block);
        if (!arr.length) continue;
        items.push({ block, strokes: arr.slice() });
        arr.length = 0;
      }
      if (!items.length) return null;
      const action = { type: 'clear', items };
      push(action);
      return { token: action, changed: blocksOf(action) };
    },
    undo(token) {
      const a = undoStack[undoStack.length - 1];
      if (!a || (token && a !== token)) return null;
      undoStack.pop();
      if (a.type === 'add') removeStroke(a.block, a.stroke);
      else if (a.type === 'erase') {
        for (let i = a.items.length - 1; i >= 0; i--) {
          const it = a.items[i];
          const arr = list(it.block);
          arr.splice(Math.min(it.index, arr.length), 0, it.stroke);
        }
      } else if (a.type === 'clear') {
        for (const it of a.items) {
          const arr = list(it.block);
          arr.unshift(...it.strokes);
        }
      }
      redoStack.push(a);
      return blocksOf(a);
    },
    redo() {
      const a = redoStack.pop();
      if (!a) return null;
      if (a.type === 'add') list(a.block).push(a.stroke);
      else if (a.type === 'erase') for (const it of a.items) removeStroke(it.block, it.stroke);
      else if (a.type === 'clear') {
        for (const it of a.items) {
          const gone = new Set(it.strokes);
          const arr = list(it.block);
          const keep = arr.filter((s) => !gone.has(s));
          arr.length = 0;
          arr.push(...keep);
        }
      }
      undoStack.push(a);
      return blocksOf(a);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** @type {WeakMap<Stroke, { w: number, h: number, path: any }>} */
const pathCache = new WeakMap();

/**
 * Traces a polygon with quadratic curves through edge midpoints (smooth outline).
 * @param {any} ctx CanvasRenderingContext2D or Path2D.
 * @param {number[][]} poly
 */
function traceSmoothPolygon(ctx, poly) {
  const n = poly.length;
  if (n < 3) return;
  const mid = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(poly[n - 1], poly[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const m = mid(p, poly[(i + 1) % n]);
    ctx.quadraticCurveTo(p[0], p[1], m[0], m[1]);
  }
  ctx.closePath();
}

/**
 * Traces the centre line of a stroke with quadratic curves (highlighter).
 * @param {any} ctx
 * @param {{ x: number, y: number }[]} pts
 */
function traceCenterLine(ctx, pts) {
  if (!pts.length) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) {
    ctx.lineTo(pts[0].x + 0.01, pts[0].y);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
}

/**
 * Path of a stroke (cached as Path2D when available and not live).
 * @param {Stroke} stroke
 * @param {number} width
 * @param {number} height
 * @param {boolean} live
 * @returns {any} Path2D or a replay function.
 */
function strokePath(stroke, width, height, live) {
  const P2D = /** @type {any} */ (globalThis).Path2D;
  if (!live) {
    const hit = pathCache.get(stroke);
    if (hit && hit.w === width && hit.h === height) return hit.path;
  }
  /** @type {(ctx: any) => void} */
  const trace =
    stroke.tool === 'hl'
      ? (ctx) => traceCenterLine(ctx, pixelPoints(stroke, width, height))
      : (ctx) => traceSmoothPolygon(ctx, strokeToPath(stroke, width, height));
  let path;
  if (typeof P2D === 'function') {
    path = new P2D();
    trace(path);
  } else {
    path = trace;
  }
  if (!live) pathCache.set(stroke, { w: width, h: height, path });
  return path;
}

/**
 * Draws strokes on a 2D context: highlighter strokes first (35% alpha, round
 * wide line), then pen strokes (filled variable-width outlines). Shared by
 * the block layers and the scratchpad.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Stroke[]} strokes
 * @param {number} width Logical width the stroke fractions refer to.
 * @param {number} height Logical height.
 * @param {number} dpr Device pixels per CSS pixel of the canvas backing store.
 * @param {object} [opts]
 * @param {boolean} [opts.clear=true] Clear the whole canvas first.
 * @param {boolean} [opts.dark=false] Use dark-theme ink colours.
 * @param {number} [opts.zoom=1] CSS px per logical unit.
 * @param {number} [opts.panX=0] Logical x at the canvas's left edge.
 * @param {number} [opts.panY=0] Logical y at the canvas's top edge.
 * @param {GlobalCompositeOperation} [opts.hlBlend='source-over'] Blend for highlighter strokes.
 * @param {boolean} [opts.live=false] Do not cache paths (stroke still changing).
 */
export function renderStrokes(ctx, strokes, width, height, dpr, opts = {}) {
  const { clear = true, dark = false, zoom = 1, panX = 0, panY = 0, hlBlend = 'source-over', live = false } = opts;
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (clear) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (!Array.isArray(strokes) || !strokes.length || !(width > 0) || !(height > 0)) return;
  const k = (dpr > 0 ? dpr : 1) * (zoom > 0 ? zoom : 1);
  ctx.setTransform(k, 0, 0, k, -panX * k, -panY * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  /** @param {any} path @param {'fill' | 'stroke'} how */
  const paint = (path, how) => {
    if (typeof path === 'function') {
      ctx.beginPath();
      path(ctx);
      ctx[how]();
    } else {
      ctx[how](path);
    }
  };
  // Highlighter first, so pen ink always sits on top.
  ctx.globalAlpha = HL_ALPHA;
  ctx.globalCompositeOperation = hlBlend;
  for (const s of strokes) {
    if (!s || s.tool !== 'hl') continue;
    ctx.strokeStyle = displayColor(s.color, dark);
    ctx.lineWidth = strokeRadius(s, width, 1) * 2;
    paint(strokePath(s, width, height, live), 'stroke');
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  for (const s of strokes) {
    if (!s || s.tool !== 'pen') continue;
    ctx.fillStyle = displayColor(s.color, dark);
    paint(strokePath(s, width, height, live), 'fill');
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/* ------------------------------------------------------------------ */
/* Environment helpers (DOM; only called at run time)                  */
/* ------------------------------------------------------------------ */

/** Once a pen is seen this app session, touch scrolls instead of drawing (drawInput 'auto'). */
let penSeenThisSession = false;

/** @returns {boolean} */
function isDarkTheme() {
  const root = globalThis.document?.documentElement;
  if (root?.dataset?.theme) return root.dataset.theme === 'dark';
  try {
    return Boolean(globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches);
  } catch {
    return false;
  }
}

/** @returns {number} */
function devicePixelRatioNow() {
  const d = Number(globalThis.devicePixelRatio);
  return d > 0 && Number.isFinite(d) ? Math.min(d, 3) : 1;
}

/**
 * The element that scrolls for a block (nearest scrollable ancestor or the page).
 * @param {Element} el
 * @returns {Element}
 */
function scrollParent(el) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * @param {string} key
 * @param {any} fallback
 */
function setting(key, fallback) {
  try {
    const v = getSetting(key);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

/**
 * Creates an ink engine for one question: input, history and persistence for
 * any number of surfaces. {@link initInk} and the scratchpad build on it.
 *
 * @param {object} opts
 * @param {string} opts.qid Question id.
 * @param {number} [opts.qversion=1] Question version saved with the ink.
 * @param {(block: string) => boolean} [opts.include] Which stored blocks this engine owns.
 * @returns {InkController & { attach(surface: Surface): void, detach(block: string): void,
 *   surfaces(): Surface[], requestRender(block: string): void }}
 */
export function createInkEngine({ qid, qversion = 1, include = () => true }) {
  if (typeof qid !== 'string' || !qid) throw new TypeError('ink: question id required');
  const version = Number.isInteger(qversion) && qversion > 0 ? qversion : 1;
  const history = createInkHistory();
  /** @type {Map<string, Surface>} */
  const surfaces = new Map();
  /** @type {Map<string, Set<(p: any) => void>>} */
  const listeners = new Map();
  /** Blocks with unsaved changes. */
  const dirty = new Set();
  /** Stored qversion per block. */
  /** @type {Map<string, number>} */
  const storedVersion = new Map();
  /** @type {Set<string>} */
  const renderQueue = new Set();
  let rafId = 0;
  let liveRaf = 0;
  let enabled = false;
  let destroyed = false;
  let tool = INK_TOOLS.includes(setting('inkTool', 'pen')) ? setting('inkTool', 'pen') : 'pen';
  let color = HEX_RE.test(setting('inkColor', DEFAULT_COLOR)) ? setting('inkColor', DEFAULT_COLOR).toLowerCase() : DEFAULT_COLOR;
  let size = clampNum(Number(setting('inkSize', DEFAULT_SIZE)) || DEFAULT_SIZE, 0.001, 0.05);
  /** @type {string[]} */
  let staleList = [];
  let lastErrorToast = 0;
  /** @type {Promise<void>} */
  let saveChain = Promise.resolve();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;

  /**
   * The gesture in progress.
   * @type {null | { pointerId: number, pointerType: string, surface: Surface, mode: 'draw' | 'erase',
   *   stroke: Stroke | null, last: { x: number, y: number, t: number, p: number } | null,
   *   lastStored: { x: number, y: number } | null, lastRaw: { x: number, y: number } | null,
   *   cursor: { x: number, y: number, r: number } | null, erased: boolean }}
   */
  let active = null;
  /** Touch pointers currently down: id → client point + surface. */
  /** @type {Map<number, { x: number, y: number, surface: Surface }>} */
  const touches = new Map();
  /** @type {null | { surface: Surface, kind: 'scroll' | 'surface', lastMid: { x: number, y: number } | null, scroller: Element | null }} */
  let gesture = null;
  /** After a multi-touch gesture, ignore touches until every finger lifts. */
  let touchLock = false;

  /* ---------- events ---------- */

  /**
   * @param {string} name
   * @param {any} [payload]
   */
  function emit(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[ink] "${name}" listener failed`, err);
      }
    }
  }

  function emitChange() {
    emit('change', { canUndo: history.canUndo(), canRedo: history.canRedo(), empty: isEmpty() });
  }

  function emitTool() {
    emit('tool', { tool, color, size });
  }

  function isEmpty() {
    for (const block of surfaces.keys()) if (history.strokes(block).length) return false;
    return true;
  }

  /* ---------- rendering ---------- */

  /** @param {string} block */
  function requestRender(block) {
    renderQueue.add(block);
    if (rafId || destroyed) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') return flushRender();
    rafId = raf(flushRender);
  }

  function flushRender() {
    rafId = 0;
    const dark = isDarkTheme();
    for (const block of renderQueue) {
      const s = surfaces.get(block);
      if (s) {
        try {
          s.render(history.strokes(block), dark);
        } catch (err) {
          console.error('[ink] render failed', err);
        }
      }
    }
    renderQueue.clear();
  }

  function renderAll() {
    for (const block of surfaces.keys()) requestRender(block);
  }

  function requestLive() {
    if (liveRaf || !active) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      if (!active) return;
      active.surface.drawLive(active.stroke, active.cursor, isDarkTheme());
    });
  }

  /* ---------- saving ---------- */

  /** @param {string} block */
  function markDirty(block) {
    dirty.add(block);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, SAVE_DELAY_MS);
  }

  function computeStale() {
    const next = [];
    for (const [block, v] of storedVersion) {
      if (v !== version && history.strokes(block).length) next.push(block);
    }
    next.sort();
    const changed = next.length !== staleList.length || next.some((b, i) => b !== staleList[i]);
    staleList = next;
    if (changed) emit('stale', { blocks: staleList.slice() });
  }

  /** @param {unknown} err */
  function reportSaveError(err) {
    emit('error', { error: err });
    const now = Date.now();
    if (now - lastErrorToast < 8000) return;
    lastErrorToast = now;
    try {
      toast("Your drawing couldn't be saved. Free up some storage space, then tap Retry.", {
        kind: 'danger',
        duration: 8000,
        action: { label: 'Retry', onClick: () => void flush() },
      });
    } catch {
      /* no toast slot (tests) */
    }
  }

  /**
   * Saves every dirty block now. Waits for the initial load first, so a save
   * can never overwrite stored ink that was not loaded yet.
   * @returns {Promise<void>}
   */
  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveChain = saveChain.then(async () => {
      await ready;
      if (!dirty.size) return;
      const blocks = [...dirty];
      dirty.clear();
      const saved = [];
      let failure = null;
      for (const block of blocks) {
        try {
          await inkRepo.set(qid, block, { qversion: version, strokes: history.strokes(block).slice() });
          storedVersion.set(block, version);
          saved.push(block);
        } catch (err) {
          dirty.add(block);
          failure = err;
        }
      }
      if (saved.length) {
        computeStale();
        emit('saved', { blocks: saved });
      }
      if (failure) {
        console.warn('[ink] save failed', failure);
        reportSaveError(failure);
      }
    });
    return saveChain;
  }

  /* ---------- loading ---------- */

  /** @type {Promise<void>} */
  const ready = (async () => {
    try {
      const records = await inkRepo.byQid(qid);
      if (destroyed) return;
      for (const rec of Array.isArray(records) ? records : []) {
        if (!rec || typeof rec.block !== 'string' || !include(rec.block)) continue;
        const strokes = (Array.isArray(rec.strokes) ? rec.strokes : []).map(sanitizeStroke).filter(Boolean);
        if (!strokes.length) continue;
        history.load(rec.block, /** @type {Stroke[]} */ (strokes));
        storedVersion.set(rec.block, Number(rec.qversion) || 1);
        requestRender(rec.block);
      }
      computeStale();
      emitChange();
    } catch (err) {
      console.warn('[ink] could not load drawings', err);
      emit('error', { error: err });
      try {
        toast("Your saved drawings couldn't be loaded. Reload the app to try again.", { kind: 'danger' });
      } catch {
        /* ignore */
      }
    } finally {
      emit('ready');
    }
  })();

  /* ---------- input ---------- */

  function fingersDraw() {
    const mode = setting('drawInput', 'auto');
    if (mode === 'finger') return true;
    if (mode === 'pen') return false;
    return !penSeenThisSession;
  }

  function applyInteractivity() {
    const ta = enabled && fingersDraw() ? 'none' : 'manipulation';
    for (const s of surfaces.values()) s.setInteractive(enabled, s.handlesGestures ? 'none' : ta, tool);
  }

  function markPenSeen() {
    if (penSeenThisSession) return;
    penSeenThisSession = true;
    applyInteractivity();
  }

  /**
   * @param {Surface} surface
   * @param {number} cx
   * @param {number} cy
   * @param {number} t
   * @param {number} pressure
   * @param {string} type
   */
  function addPoint(surface, cx, cy, t, pressure, type) {
    const a = active;
    if (!a || !a.stroke) return;
    const { w, h: ht } = surface.size();
    if (!(w > 0) || !(ht > 0)) return;
    const raw = surface.toLocal(cx, cy);
    const scale = surface.scale() || 1;
    let p;
    if (type === 'pen') {
      const pr = pressure > 0 ? pressure : 0.5;
      p = a.last ? a.last.p + (pr - a.last.p) * 0.6 : pr;
    } else if (a.last) {
      const dt = Math.max(1, t - a.last.t);
      const speed = (Math.hypot(raw.x - (a.lastRaw?.x ?? raw.x), raw.y - (a.lastRaw?.y ?? raw.y)) * scale) / dt;
      p = simulatePressure(a.last.p, speed);
    } else {
      p = 0.6;
    }
    const sm = smoothPoint(a.last, raw, type === 'pen' ? 0.3 : 0.5);
    a.last = { x: sm.x, y: sm.y, t, p };
    a.lastRaw = raw;
    if (a.lastStored && Math.hypot(sm.x - a.lastStored.x, sm.y - a.lastStored.y) * scale < 0.6) return;
    a.lastStored = sm;
    a.stroke.pts.push(roundFrac(sm.x / w), roundFrac(sm.y / ht), roundFrac(p, 2));
    if (a.stroke.pts.length >= MAX_STROKE_POINTS * 3) splitStroke();
  }

  /** Commits a very long stroke and continues seamlessly with a new one. */
  function splitStroke() {
    const a = active;
    if (!a || !a.stroke) return;
    const pts = a.stroke.pts;
    const tail = pts.slice(-3);
    commitStroke();
    a.stroke = { ...a.stroke, pts: tail };
  }

  function commitStroke() {
    const a = active;
    if (!a || !a.stroke || a.stroke.pts.length < 3) return;
    const block = a.surface.block;
    history.add(block, a.stroke);
    requestRender(block);
    markDirty(block);
    emitChange();
  }

  /**
   * @param {Surface} surface
   * @param {number} cx
   * @param {number} cy
   */
  function eraseAt(surface, cx, cy) {
    const a = active;
    if (!a) return;
    const { w, h: ht } = surface.size();
    const pt = surface.toLocal(cx, cy);
    const r = ERASER_RADIUS_PX / (surface.scale() || 1);
    const prev = a.cursor;
    a.cursor = { x: pt.x, y: pt.y, r };
    // Sample along the movement so fast swipes never skip a thin stroke.
    const steps = prev ? Math.min(40, Math.ceil(Math.hypot(pt.x - prev.x, pt.y - prev.y) / (r / 2))) : 0;
    const strokes = history.strokes(surface.block);
    let hit = false;
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 1;
      const x = prev ? prev.x + (pt.x - prev.x) * t : pt.x;
      const y = prev ? prev.y + (pt.y - prev.y) * t : pt.y;
      for (let j = strokes.length - 1; j >= 0; j--) {
        const s = strokes[j];
        if (hitStroke(s, x, y, r, w, ht) && history.erase(surface.block, s)) hit = true;
      }
    }
    if (hit) {
      a.erased = true;
      requestRender(surface.block);
    }
    requestLive();
  }

  /**
   * @param {Surface} surface
   * @param {PointerEvent} e
   */
  function begin(surface, e) {
    const isEraserButton = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) === 32);
    const mode = tool === 'eraser' || isEraserButton ? 'erase' : 'draw';
    const { w } = surface.size();
    /** @type {Stroke | null} */
    let stroke = null;
    if (mode === 'draw') {
      const t = tool === 'hl' ? 'hl' : 'pen';
      const base = t === 'hl' ? size * HL_SIZE_FACTOR : size;
      const frac = w > 0 ? (base * surface.refWidth()) / w : base;
      stroke = { tool: t, color, size: roundFrac(clampNum(frac, 0.0001, 0.5), 5), pts: [] };
    }
    active = {
      pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse',
      surface,
      mode,
      stroke,
      last: null,
      lastStored: null,
      lastRaw: null,
      cursor: null,
      erased: false,
    };
    surface.beginLive();
    emit('strokestart', { block: surface.block });
    if (mode === 'erase') eraseAt(surface, e.clientX, e.clientY);
    else addPoint(surface, e.clientX, e.clientY, e.timeStamp, e.pressure, active.pointerType);
    requestLive();
  }

  /**
   * Ends the active gesture.
   * @param {boolean} keep Commit the stroke (false = discard, e.g. it became a two-finger scroll).
   */
  function finish(keep) {
    const a = active;
    if (!a) return;
    if (a.mode === 'draw' && a.stroke && keep) {
      // End exactly where the pointer lifted.
      const { w, h: ht } = a.surface.size();
      if (a.lastRaw && a.lastStored && w > 0 && ht > 0) {
        const d = Math.hypot(a.lastRaw.x - a.lastStored.x, a.lastRaw.y - a.lastStored.y) * (a.surface.scale() || 1);
        if (d >= 0.6) a.stroke.pts.push(roundFrac(a.lastRaw.x / w), roundFrac(a.lastRaw.y / ht), roundFrac(a.last?.p ?? 0.5, 2));
      }
      commitStroke();
    } else if (a.mode === 'erase') {
      const changed = history.endErase();
      for (const b of changed) markDirty(b);
      // A cancelled erase is kept too: it already happened visibly.
      if (changed.length) emitChange();
    }
    if (liveRaf) {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
    }
    try {
      a.surface.endLive();
    } catch {
      /* ignore */
    }
    try {
      a.surface.el.releasePointerCapture?.(a.pointerId);
    } catch {
      /* ignore */
    }
    active = null;
  }

  /** @returns {{ x: number, y: number }[]} */
  function touchPoints() {
    return [...touches.values()].map((t) => ({ x: t.x, y: t.y }));
  }

  /** @param {Surface} surface */
  function startGesture(surface) {
    if (surface.handlesGestures) {
      gesture = { surface, kind: 'surface', lastMid: null, scroller: null };
      surface.gestureStart?.(touchPoints());
    } else {
      gesture = { surface, kind: 'scroll', lastMid: midpoint(), scroller: scrollParent(surface.el) };
    }
  }

  function midpoint() {
    const pts = touchPoints();
    if (!pts.length) return null;
    return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  }

  function endGesture() {
    if (!gesture) return;
    if (gesture.kind === 'surface') gesture.surface.gestureEnd?.();
    gesture = null;
  }

  /**
   * @param {Surface} surface
   * @param {PointerEvent} e
   */
  function onDown(surface, e) {
    if (!enabled || destroyed) return;
    const type = e.pointerType || 'mouse';
    if (type === 'pen') markPenSeen();
    if (type === 'touch') {
      // A primary touch means no other finger is down: drop entries whose
      // pointerup never reached us (e.g. the page scrolled natively).
      if (e.isPrimary) {
        touches.clear();
        touchLock = false;
        if (gesture) endGesture();
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY, surface });
      const draws = fingersDraw();
      if (!draws && !surface.handlesGestures) return; // palm rejection: the page scrolls natively
      e.preventDefault();
      try {
        surface.el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (touchLock) {
        if (gesture?.kind === 'surface') {
          endGesture();
          startGesture(surface);
        } else if (gesture) {
          gesture.lastMid = midpoint();
        }
        return;
      }
      if (active && active.pointerType !== 'touch') return; // a pen is drawing: this is a palm
      if (touches.size >= 2 || !draws) {
        if (active) finish(false); // the first finger was the start of a two-finger gesture
        endGesture();
        touchLock = touches.size >= 2;
        startGesture(surface);
        return;
      }
      if (active) return;
    } else {
      if (type === 'mouse' && e.button !== 0) return;
      if (active) {
        if (active.pointerType === 'touch' && type === 'pen') finish(false);
        else return;
      }
      endGesture();
      e.preventDefault();
      try {
        surface.el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    begin(surface, e);
  }

  /** @param {PointerEvent} e */
  function onMove(e) {
    const t = touches.get(e.pointerId);
    if (t) {
      t.x = e.clientX;
      t.y = e.clientY;
      if (gesture) {
        if (gesture.kind === 'surface') gesture.surface.gestureMove?.(touchPoints());
        else {
          const mid = midpoint();
          if (mid && gesture.lastMid && gesture.scroller) {
            gesture.scroller.scrollBy(gesture.lastMid.x - mid.x, gesture.lastMid.y - mid.y);
          }
          gesture.lastMid = mid;
        }
        return;
      }
    }
    const a = active;
    if (!a || a.pointerId !== e.pointerId) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    for (const ev of list) {
      if (a.mode === 'erase') eraseAt(a.surface, ev.clientX, ev.clientY);
      else addPoint(a.surface, ev.clientX, ev.clientY, ev.timeStamp || e.timeStamp, ev.pressure, a.pointerType);
    }
    requestLive();
  }

  /** @param {PointerEvent} e */
  function onUp(e) {
    const wasTouch = touches.delete(e.pointerId);
    if (wasTouch && gesture) {
      if (touches.size === 0) {
        endGesture();
        touchLock = false;
      } else if (gesture.kind === 'scroll') {
        gesture.lastMid = midpoint();
      } else {
        gesture.surface.gestureEnd?.();
        gesture.surface.gestureStart?.(touchPoints());
      }
      return;
    }
    if (touches.size === 0) touchLock = false;
    const a = active;
    if (!a || a.pointerId !== e.pointerId) return;
    // A cancelled touch stroke is usually the start of a scroll or a palm; a
    // cancelled pen stroke is kept (never lose ink).
    finish(!(e.type === 'pointercancel' && a.pointerType === 'touch'));
  }

  /**
   * iOS Safari and Chrome may start scrolling for a pen even when touch-action
   * allows panning for fingers; cancelling the touch events of an active pen
   * gesture prevents that.
   * @param {TouchEvent} e
   */
  function onTouch(e) {
    if (!enabled) return;
    const stylus = [...(e.touches || [])].some((t) => /** @type {any} */ (t).touchType === 'stylus');
    if ((active && active.pointerType !== 'touch') || stylus) {
      if (e.cancelable) e.preventDefault();
    }
  }

  /** @type {WeakMap<Surface, () => void>} */
  const unbinders = new WeakMap();

  /** @param {Surface} surface */
  function bind(surface) {
    const el = surface.el;
    const down = (/** @type {PointerEvent} */ e) => onDown(surface, e);
    const opts = { passive: false };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('touchstart', onTouch, opts);
    el.addEventListener('touchmove', onTouch, opts);
    const ctx = (/** @type {Event} */ e) => {
      if (enabled) e.preventDefault();
    };
    el.addEventListener('contextmenu', ctx);
    unbinders.set(surface, () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('touchstart', onTouch);
      el.removeEventListener('touchmove', onTouch);
      el.removeEventListener('contextmenu', ctx);
    });
  }

  /* ---------- page lifecycle ---------- */

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  const onPageHide = () => void flush();
  const themeObserver =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => renderAll())
      : null;
  const colorQuery = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  const onScheme = () => renderAll();
  document.addEventListener('visibilitychange', onHidden);
  globalThis.addEventListener('pagehide', onPageHide);
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  colorQuery?.addEventListener?.('change', onScheme);
  const offSettings = bus.on('settings:change', ({ key } = /** @type {any} */ ({})) => {
    if (key === 'drawInput') applyInteractivity();
  });

  /* ---------- public API ---------- */

  const api = {
    ready,

    /** @param {Surface} surface */
    attach(surface) {
      if (destroyed) return;
      const old = surfaces.get(surface.block);
      if (old && old !== surface) api.detach(surface.block);
      surfaces.set(surface.block, surface);
      bind(surface);
      surface.setInteractive(enabled, surface.handlesGestures ? 'none' : enabled && fingersDraw() ? 'none' : 'manipulation', tool);
      requestRender(surface.block);
    },

    /** @param {string} block */
    detach(block) {
      const s = surfaces.get(block);
      if (!s) return;
      if (active && active.surface === s) finish(true);
      unbinders.get(s)?.();
      surfaces.delete(block);
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    },

    surfaces: () => [...surfaces.values()],
    requestRender,

    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      applyInteractivity();
      emit('enable', { enabled: true });
    },

    disable() {
      if (active) finish(true);
      endGesture();
      touches.clear();
      if (enabled) {
        enabled = false;
        applyInteractivity();
        emit('enable', { enabled: false });
      }
      return flush();
    },

    isEnabled: () => enabled,

    /** @param {string} t */
    setTool(t) {
      if (!INK_TOOLS.includes(t) || t === tool) return;
      tool = /** @type {any} */ (t);
      applyInteractivity();
      emitTool();
    },

    /** @param {string} hex */
    setColor(hex) {
      if (typeof hex !== 'string' || !HEX_RE.test(hex)) return;
      const c = hex.toLowerCase();
      if (c === color) return;
      color = c;
      emitTool();
    },

    /** @param {number} frac */
    setSize(frac) {
      const n = Number(frac);
      if (!Number.isFinite(n)) return;
      const s = clampNum(n, 0.001, 0.05);
      if (s === size) return;
      size = s;
      emitTool();
    },

    getState: () => ({ tool, color, size, enabled }),

    /** @param {object} [token] */
    undo(token) {
      if (active) finish(true);
      const changed = history.undo(token);
      if (!changed) return false;
      for (const b of changed) {
        requestRender(b);
        markDirty(b);
      }
      emitChange();
      return true;
    },

    redo() {
      if (active) finish(true);
      const changed = history.redo();
      if (!changed) return false;
      for (const b of changed) {
        requestRender(b);
        markDirty(b);
      }
      emitChange();
      return true;
    },

    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    isEmpty,

    clearAll() {
      if (active) finish(true);
      const res = history.clear([...surfaces.keys()]);
      if (!res) return null;
      for (const b of res.changed) {
        requestRender(b);
        markDirty(b);
      }
      emitChange();
      return res.token;
    },

    staleBlocks: () => staleList.slice(),
    flush,
    refresh() {},

    /**
     * @param {string} name
     * @param {(p: any) => void} fn
     * @returns {() => void}
     */
    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(fn);
      if (name === 'stale' && staleList.length) {
        queueMicrotask(() => set?.has(fn) && fn({ blocks: staleList.slice() }));
      }
      return () => set?.delete(fn);
    },

    async destroy() {
      if (destroyed) return saveChain;
      const done = api.disable();
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      for (const block of [...surfaces.keys()]) api.detach(block);
      document.removeEventListener('visibilitychange', onHidden);
      globalThis.removeEventListener('pagehide', onPageHide);
      themeObserver?.disconnect();
      colorQuery?.removeEventListener?.('change', onScheme);
      offSettings();
      emit('destroy');
      listeners.clear();
      return done;
    },
  };
  return api;
}

/* ------------------------------------------------------------------ */
/* Block layers                                                        */
/* ------------------------------------------------------------------ */

/**
 * A transparent canvas over one `[data-block]` element.
 * @param {HTMLElement} host
 * @param {string} block
 * @param {() => number} refWidth
 * @returns {Surface & { resize(): void, host: HTMLElement }}
 */
function createLayerSurface(host, block, refWidth) {
  const canvas = /** @type {HTMLCanvasElement} */ (
    h('canvas', { class: 'ink-layer', 'data-anchor-skip': '', 'aria-hidden': 'true' })
  );
  /** @type {HTMLCanvasElement | null} */
  let live = null;
  let w = 0;
  let ht = 0;
  let dpr = 1;
  let hasInk = false;
  /** @type {Stroke[]} */
  let lastStrokes = [];
  let lastDark = false;
  /** Canvas rect cached for the duration of a stroke. @type {DOMRect | null} */
  let rectCache = null;
  /** @type {string[]} */
  const addedClasses = [];
  const rect = () => rectCache || canvas.getBoundingClientRect();

  const cs = getComputedStyle(host);
  if (cs.position === 'static') addedClasses.push('ink-host');
  if (cs.display === 'inline') addedClasses.push('ink-host-inline');
  host.classList.add(...addedClasses);
  host.append(canvas);

  /** Backing-store scale that keeps a canvas inside the pixel budget. */
  function scaleFor(cw, ch) {
    const d = devicePixelRatioNow();
    const area = cw * ch * d * d;
    return area > MAX_CANVAS_PIXELS ? Math.max(0.5, Math.sqrt(MAX_CANVAS_PIXELS / (cw * ch))) : d;
  }

  /**
   * @param {HTMLCanvasElement} c
   * @param {boolean} needed
   */
  function sizeCanvas(c, needed) {
    const bw = needed ? Math.max(1, Math.round(w * dpr)) : 0;
    const bh = needed ? Math.max(1, Math.round(ht * dpr)) : 0;
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
  }

  const surface = {
    block,
    el: canvas,
    host,
    size: () => ({ w, h: ht }),
    toLocal(cx, cy) {
      const r = rect();
      return {
        x: (cx - r.left) * (r.width ? w / r.width : 1),
        y: (cy - r.top) * (r.height ? ht / r.height : 1),
      };
    },
    scale() {
      const r = rect();
      return w > 0 && r.width > 0 ? r.width / w : 1;
    },
    refWidth: () => refWidth() || w,
    resize() {
      const nw = host.clientWidth;
      const nh = host.clientHeight;
      const nd = scaleFor(nw, nh);
      if (nw === w && nh === ht && nd === dpr) return;
      w = nw;
      ht = nh;
      dpr = nd;
      surface.render(lastStrokes, lastDark);
    },
    render(strokes, dark) {
      lastStrokes = strokes;
      lastDark = dark;
      hasInk = strokes.length > 0;
      // Empty layers keep a 0×0 backing store (saves memory on long questions).
      sizeCanvas(canvas, hasInk && w > 0 && ht > 0);
      if (!hasInk || !w || !ht) return;
      const ctx = canvas.getContext('2d');
      if (ctx) renderStrokes(ctx, strokes, w, ht, dpr, { dark });
    },
    beginLive() {
      rectCache = canvas.getBoundingClientRect();
      if (live) return;
      live = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'ink-live', 'data-anchor-skip': '', 'aria-hidden': 'true' }));
      host.append(live);
      sizeCanvas(live, w > 0 && ht > 0);
    },
    drawLive(stroke, cursor, dark) {
      if (!live) return;
      const ctx = live.getContext('2d');
      if (!ctx) return;
      renderStrokes(ctx, stroke ? [stroke] : [], w, ht, dpr, { dark, live: true });
      if (cursor) drawEraserCursor(ctx, cursor, dpr, 1, 0, 0, dark);
    },
    endLive() {
      rectCache = null;
      live?.remove();
      live = null;
    },
    setInteractive(on, touchAction, t) {
      canvas.classList.toggle('is-active', on);
      canvas.dataset.tool = t;
      canvas.style.touchAction = on ? touchAction : '';
    },
    destroy() {
      live?.remove();
      canvas.remove();
      host.classList.remove(...addedClasses);
    },
  };
  return surface;
}

/**
 * Draws the eraser ring on a live canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, r: number }} c
 * @param {number} dpr
 * @param {number} zoom
 * @param {number} panX
 * @param {number} panY
 * @param {boolean} dark
 */
export function drawEraserCursor(ctx, c, dpr, zoom, panX, panY, dark) {
  const k = dpr * zoom;
  ctx.setTransform(k, 0, 0, k, -panX * k, -panY * k);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.lineWidth = 1.5 / zoom;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)';
  ctx.stroke();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Lays an ink layer over every `[data-block]` element in `root` and loads the
 * question's saved ink. New blocks (for example the explanation revealed
 * after answering) get a layer automatically; removed blocks lose theirs
 * (their ink stays stored).
 *
 * @param {HTMLElement} root
 * @param {{ id: string, version?: number }} question
 * @returns {InkController}
 */
export function initInk(root, question) {
  if (!root || typeof root.querySelectorAll !== 'function') throw new TypeError('initInk: root element required');
  const engine = createInkEngine({
    qid: question?.id,
    qversion: question?.version ?? 1,
    include: (b) => b !== SCRATCH_BLOCK,
  });
  /** @type {Map<string, ReturnType<typeof createLayerSurface>>} */
  const layers = new Map();
  const refWidth = () => root.clientWidth || 0;

  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          for (const entry of entries) {
            for (const layer of layers.values()) if (layer.host === entry.target) layer.resize();
          }
        })
      : null;

  const onWindowResize = () => {
    for (const layer of layers.values()) layer.resize();
  };
  globalThis.addEventListener('resize', onWindowResize);

  function scan() {
    /** @type {Map<string, HTMLElement>} */
    const found = new Map();
    const els = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-block]')]);
    if (root.matches?.('[data-block]')) els.unshift(root);
    for (const el of els) {
      const block = el.dataset.block;
      if (!block || block === SCRATCH_BLOCK || found.has(block)) continue;
      found.set(block, el);
    }
    for (const [block, layer] of layers) {
      if (found.get(block) !== layer.host || !layer.host.isConnected) {
        ro?.unobserve(layer.host);
        layers.delete(block);
        engine.detach(block);
      }
    }
    for (const [block, el] of found) {
      if (layers.has(block)) {
        const layer = layers.get(block);
        // The block re-rendered its children and dropped our canvas: put it back.
        if (layer && !layer.el.isConnected) {
          ro?.unobserve(layer.host);
          layers.delete(block);
          engine.detach(block);
        } else continue;
      }
      const layer = createLayerSurface(el, block, refWidth);
      layers.set(block, layer);
      layer.resize();
      ro?.observe(el);
      engine.attach(layer);
    }
  }

  let scanRaf = 0;
  const mo =
    typeof MutationObserver === 'function'
      ? new MutationObserver((records) => {
          // Ignore our own canvases coming and going, but notice when a block
          // re-render removed a layer we still own.
          const ours = (/** @type {Node} */ n) =>
            n instanceof HTMLCanvasElement && (n.classList.contains('ink-layer') || n.classList.contains('ink-live'));
          const owned = (/** @type {Node} */ n) => [...layers.values()].some((l) => l.el === n);
          const relevant = records.some(
            (r) => [...r.addedNodes].some((n) => !ours(n)) || [...r.removedNodes].some((n) => !ours(n) || owned(n)),
          );
          if (!relevant || scanRaf) return;
          scanRaf = requestAnimationFrame(() => {
            scanRaf = 0;
            scan();
          });
        })
      : null;

  scan();
  mo?.observe(root, { childList: true, subtree: true });

  const destroyEngine = engine.destroy;
  return Object.assign(engine, {
    refresh: scan,
    async destroy() {
      mo?.disconnect();
      ro?.disconnect();
      if (scanRaf) cancelAnimationFrame(scanRaf);
      globalThis.removeEventListener('resize', onWindowResize);
      layers.clear();
      return destroyEngine();
    },
  });
}
