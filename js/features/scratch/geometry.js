/**
 * Scratchpad geometry (docs/ARCHITECTURE.md §7.16). Pure: bounds (rotation
 * included), hit tests for strokes / shapes / text / images, lasso
 * containment, selection handles, resize and rotate math (aspect lock),
 * snapping and the view math (fit width, zoom around a point, pan limits).
 *
 * All coordinates are page units unless a parameter says "CSS px".
 *
 * @module features/scratch/geometry
 */

import { PAGE_W, PAGE_H } from './scene.js';

/**
 * @typedef {import('./scene.js').Item} Item
 * @typedef {{ x: number, y: number, w: number, h: number }} Box
 * @typedef {{ x: number, y: number }} Point
 * @typedef {'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'} HandleName
 * @typedef {{ scale: number, x: number, y: number }} View  scale = CSS px per page unit; x/y = page point at the viewport's top-left
 */

/** Line height of text boxes, in multiples of the font size. */
export const TEXT_LINE = 1.3;
/** Inner padding of a text box (page units, times the font size). */
export const TEXT_PAD = 0.15;
/** Arrow head length in multiples of the line width (at least {@link ARROW_MIN}). */
export const ARROW_HEAD = 4.5;
/** Shortest arrow head (page units). */
export const ARROW_MIN = 28;
/** Smallest image / shape side after a resize (page units). */
export const MIN_SIDE = 24;
/** Rotation snap step (15°) and tolerance (4°). */
export const ROT_SNAP = Math.PI / 12;
export const ROT_SNAP_TOL = (4 * Math.PI) / 180;

/** Handle directions: x and y sign of each handle from the box centre. */
export const HANDLES = Object.freeze(
  /** @type {Record<HandleName, readonly [number, number]>} */ ({
    nw: [-1, -1],
    n: [0, -1],
    ne: [1, -1],
    e: [1, 0],
    se: [1, 1],
    s: [0, 1],
    sw: [-1, 1],
    w: [-1, 0],
  }),
);

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
export function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Distance from a point to a segment.
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Rotates a point around a centre.
 * @param {number} x
 * @param {number} y
 * @param {number} cx
 * @param {number} cy
 * @param {number} a Radians.
 * @returns {Point}
 */
export function rotatePoint(x, y, cx, cy, a) {
  if (!a) return { x, y };
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/**
 * Corners of a box rotated around its centre (nw, ne, se, sw).
 * @param {Box} b
 * @param {number} [rot=0]
 * @returns {Point[]}
 */
export function boxCorners(b, rot = 0) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ].map(([x, y]) => rotatePoint(x, y, cx, cy, rot));
}

/**
 * Axis-aligned bounds of points.
 * @param {Point[]} pts
 * @returns {Box}
 */
export function pointsBounds(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Union of boxes (null for none).
 * @param {Box[]} boxes
 * @returns {Box | null}
 */
export function unionBounds(boxes) {
  const list = boxes.filter(Boolean);
  if (!list.length) return null;
  return pointsBounds(list.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]));
}

/* ------------------------------------------------------------------ */
/* Text layout                                                         */
/* ------------------------------------------------------------------ */

/**
 * Default text measure (no canvas): an average glyph width.
 * @param {string} s
 * @param {number} size Font size.
 * @returns {number}
 */
export function estimateWidth(s, size) {
  return s.length * size * 0.52;
}

/**
 * Wraps text into lines that fit a width (words longer than the width are
 * broken by character). Explicit newlines are kept. Pure.
 * @param {string} text
 * @param {number} width Available width.
 * @param {number} size Font size.
 * @param {(s: string, size: number) => number} [measure]
 * @returns {string[]}
 */
export function wrapText(text, width, size, measure = estimateWidth) {
  const out = [];
  const max = Math.max(size, width);
  for (const para of String(text ?? '').split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w !== '');
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (measure(candidate.trimEnd(), size) <= max || line === '') {
        if (measure(candidate.trimEnd(), size) > max && line === '') {
          // A single word wider than the box: break it.
          let chunk = '';
          for (const ch of word) {
            if (measure(chunk + ch, size) > max && chunk) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        out.push(line.trimEnd());
        line = /^\s+$/.test(word) ? '' : word;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Height of a text box.
 * @param {import('./scene.js').TextItem} it
 * @param {(s: string, size: number) => number} [measure]
 * @returns {number}
 */
export function textHeight(it, measure = estimateWidth) {
  const pad = it.size * TEXT_PAD;
  const lines = wrapText(it.text, it.w - 2 * pad, it.size, measure).length;
  return Math.max(1, lines) * it.size * TEXT_LINE + 2 * pad;
}

/* ------------------------------------------------------------------ */
/* Bounds                                                              */
/* ------------------------------------------------------------------ */

/**
 * Half the widest drawn width of a stroke.
 * @param {import('./scene.js').StrokeItem} it
 */
function strokeReach(it) {
  return it.tool === 'hl' ? it.size / 2 : (it.size / 2) * 1.25;
}

/**
 * The box an item is drawn in, before rotation (images rotate around its centre).
 * @param {Item} it
 * @param {{ measure?: (s: string, size: number) => number }} [opts]
 * @returns {Box}
 */
export function itemBox(it, { measure } = {}) {
  switch (it.type) {
    case 'image':
      return { x: it.x, y: it.y, w: it.w, h: it.h };
    case 'text':
      return { x: it.x, y: it.y, w: it.w, h: textHeight(it, measure) };
    case 'shape':
      return {
        x: Math.min(it.x1, it.x2),
        y: Math.min(it.y1, it.y2),
        w: Math.abs(it.x2 - it.x1),
        h: Math.abs(it.y2 - it.y1),
      };
    default: {
      const pts = [];
      for (let i = 0; i + 1 < it.pts.length; i += 3) pts.push({ x: it.pts[i], y: it.pts[i + 1] });
      return pointsBounds(pts);
    }
  }
}

/**
 * Axis-aligned bounds of everything an item paints (stroke width, arrow
 * heads and rotation included).
 * @param {Item} it
 * @param {{ measure?: (s: string, size: number) => number }} [opts]
 * @returns {Box}
 */
export function itemBounds(it, opts = {}) {
  const b = itemBox(it, opts);
  if (it.type === 'image') return pointsBounds(boxCorners(b, it.rot));
  let pad = 0;
  if (it.type === 'stroke') pad = strokeReach(it);
  else if (it.type === 'shape') pad = it.size / 2 + (it.shape === 'arrow' ? Math.max(ARROW_MIN, it.size * ARROW_HEAD) : 0);
  return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
}

/* ------------------------------------------------------------------ */
/* Hit tests                                                           */
/* ------------------------------------------------------------------ */

/**
 * Does a circle at (x, y) with radius `r` touch a stroke?
 * @param {import('./scene.js').StrokeItem} it
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @returns {boolean}
 */
export function hitStrokeItem(it, x, y, r) {
  const pts = it.pts;
  const reach = r + strokeReach(it);
  if (pts.length < 3) return false;
  if (pts.length < 6) return Math.hypot(x - pts[0], y - pts[1]) <= reach;
  for (let i = 3; i + 1 < pts.length; i += 3) {
    if (distToSegment(x, y, pts[i - 3], pts[i - 2], pts[i], pts[i + 1]) <= reach) return true;
  }
  return false;
}

/**
 * Is a point inside a box rotated around its centre?
 * @param {Box} b
 * @param {number} rot
 * @param {number} x
 * @param {number} y
 * @param {number} [pad=0]
 * @returns {boolean}
 */
export function pointInBox(b, rot, x, y, pad = 0) {
  const p = rotatePoint(x, y, b.x + b.w / 2, b.y + b.h / 2, -rot);
  return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad;
}

/**
 * Hit test of one item at a point.
 * @param {Item} it
 * @param {number} x
 * @param {number} y
 * @param {number} tol Tolerance (page units).
 * @param {{ inside?: boolean, measure?: (s: string, size: number) => number }} [opts]
 *   `inside` (default true): the inside of rectangles and ellipses counts (select);
 *   false = only the outline (eraser).
 * @returns {boolean}
 */
export function hitItem(it, x, y, tol, { inside = true, measure } = {}) {
  switch (it.type) {
    case 'stroke':
      return hitStrokeItem(it, x, y, tol);
    case 'image':
      return pointInBox(itemBox(it), it.rot, x, y, tol);
    case 'text':
      return pointInBox(itemBox(it, { measure }), 0, x, y, tol);
    case 'shape': {
      const reach = tol + it.size / 2;
      if (it.shape === 'line' || it.shape === 'arrow') return distToSegment(x, y, it.x1, it.y1, it.x2, it.y2) <= reach;
      const b = itemBox(it);
      if (it.shape === 'rect') {
        const inBox = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
        if (inBox && (inside || it.fill)) return true;
        const edges = [
          [b.x, b.y, b.x + b.w, b.y],
          [b.x + b.w, b.y, b.x + b.w, b.y + b.h],
          [b.x + b.w, b.y + b.h, b.x, b.y + b.h],
          [b.x, b.y + b.h, b.x, b.y],
        ];
        return edges.some(([ax, ay, bx, by]) => distToSegment(x, y, ax, ay, bx, by) <= reach);
      }
      const rx = Math.max(b.w / 2, 0.5);
      const ry = Math.max(b.h / 2, 0.5);
      const nx = (x - (b.x + rx)) / rx;
      const ny = (y - (b.y + ry)) / ry;
      const d = Math.hypot(nx, ny);
      if (d <= 1 && (inside || it.fill)) return true;
      return Math.abs(d - 1) * Math.min(rx, ry) <= reach;
    }
    default:
      return false;
  }
}

/**
 * Topmost item at a point (null when none).
 * @param {Item[]} items Z-order, bottom first.
 * @param {number} x
 * @param {number} y
 * @param {number} tol
 * @param {{ inside?: boolean, measure?: (s: string, size: number) => number, filter?: (it: Item) => boolean }} [opts]
 * @returns {Item | null}
 */
export function hitTest(items, x, y, tol, opts = {}) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (opts.filter && !opts.filter(it)) continue;
    if (hitItem(it, x, y, tol, opts)) return it;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Lasso                                                               */
/* ------------------------------------------------------------------ */

/**
 * Even-odd point-in-polygon test.
 * @param {Point[]} poly
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Items enclosed by a lasso: strokes with at least half of their points
 * inside, other items whose centre (and for images 3 of 4 corners) is inside.
 * @param {Item[]} items
 * @param {Point[]} poly
 * @param {{ measure?: (s: string, size: number) => number }} [opts]
 * @returns {string[]} Ids in z-order.
 */
export function lassoSelect(items, poly, opts = {}) {
  if (!Array.isArray(poly) || poly.length < 3) return [];
  const out = [];
  for (const it of items) {
    if (it.type === 'stroke') {
      let n = 0;
      let inside = 0;
      for (let i = 0; i + 1 < it.pts.length; i += 3) {
        n++;
        if (pointInPolygon(poly, it.pts[i], it.pts[i + 1])) inside++;
      }
      if (n && inside / n >= 0.5) out.push(it.id);
      continue;
    }
    const b = itemBox(it, opts);
    const corners = boxCorners(b, it.type === 'image' ? it.rot : 0);
    const cIn = pointInPolygon(poly, b.x + b.w / 2, b.y + b.h / 2);
    const k = corners.filter((p) => pointInPolygon(poly, p.x, p.y)).length;
    if (cIn && k >= 3) out.push(it.id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Handles, resize, rotate                                             */
/* ------------------------------------------------------------------ */

/**
 * Handle positions of a (possibly rotated) box, plus the rotate handle
 * placed `rotOffset` units above the top edge.
 * @param {Box} b
 * @param {number} [rot=0]
 * @param {number} [rotOffset=0] 0 = no rotate handle.
 * @returns {Record<string, Point>}
 */
export function handlePoints(b, rot = 0, rotOffset = 0) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  /** @type {Record<string, Point>} */
  const out = {};
  for (const [name, [sx, sy]] of Object.entries(HANDLES)) {
    out[name] = rotatePoint(cx + (sx * b.w) / 2, cy + (sy * b.h) / 2, cx, cy, rot);
  }
  if (rotOffset > 0) out.rotate = rotatePoint(cx, b.y - rotOffset, cx, cy, rot);
  return out;
}

/**
 * The handle under a point (null when none).
 * @param {Record<string, Point>} handles
 * @param {number} x
 * @param {number} y
 * @param {number} r Hit radius.
 * @returns {string | null}
 */
export function hitHandle(handles, x, y, r) {
  let best = null;
  let bestD = Infinity;
  for (const [name, p] of Object.entries(handles)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= r && d < bestD) {
      best = name;
      bestD = d;
    }
  }
  return best;
}

/**
 * Resizes a box (rotated around its centre) by dragging a handle to a page
 * point. The opposite handle stays fixed on the page. With `keepAspect`
 * the width/height ratio is kept (edge handles grow the other side evenly).
 * @param {Box} b
 * @param {number} rot
 * @param {HandleName} handle
 * @param {number} px Pointer x (page).
 * @param {number} py Pointer y (page).
 * @param {{ keepAspect?: boolean, min?: number }} [opts]
 * @returns {Box}
 */
export function resizeBox(b, rot, handle, px, py, { keepAspect = false, min = MIN_SIDE } = {}) {
  const dir = HANDLES[handle];
  if (!dir) return { ...b };
  const [sx, sy] = dir;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  // Pointer in the box's local (unrotated, centre-origin) frame.
  const lp = rotatePoint(px, py, cx, cy, -rot);
  const lx = lp.x - cx;
  const ly = lp.y - cy;
  const ax = (-sx * b.w) / 2;
  const ay = (-sy * b.h) / 2;
  let w = sx ? Math.max(min, (lx - ax) * sx) : b.w;
  let ht = sy ? Math.max(min, (ly - ay) * sy) : b.h;
  if (keepAspect && b.w > 0 && b.h > 0) {
    const ratio = b.w / b.h;
    if (sx && sy) {
      const s = Math.max(w / b.w, ht / b.h);
      w = b.w * s;
      ht = b.h * s;
    } else if (sx) ht = w / ratio;
    else w = ht * ratio;
    if (w < min) {
      w = min;
      ht = w / ratio;
    }
    if (ht < min) {
      ht = min;
      w = ht * ratio;
    }
  }
  // New centre in the local frame: anchored side stays put; a free axis stays centred.
  const ncx = sx ? ax + (sx * w) / 2 : 0;
  const ncy = sy ? ay + (sy * ht) / 2 : 0;
  const c = rotatePoint(cx + ncx, cy + ncy, cx, cy, rot);
  return { x: c.x - w / 2, y: c.y - ht / 2, w, h: ht };
}

/**
 * Snaps an angle to the nearest multiple of `step` when within `tol`.
 * @param {number} a
 * @param {number} [step=ROT_SNAP]
 * @param {number} [tol=ROT_SNAP_TOL]
 * @returns {number}
 */
export function snapAngle(a, step = ROT_SNAP, tol = ROT_SNAP_TOL) {
  const k = Math.round(a / step) * step;
  return Math.abs(a - k) <= tol ? k : a;
}

/**
 * The rotation that points a box's top towards a page point (rotate handle).
 * @param {Box} b
 * @param {number} px
 * @param {number} py
 * @param {{ snap?: boolean }} [opts]
 * @returns {number} Radians in (-π, π].
 */
export function rotationTowards(b, px, py, { snap = true } = {}) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  let a = Math.atan2(py - cy, px - cx) + Math.PI / 2;
  if (a > Math.PI) a -= 2 * Math.PI;
  if (snap) a = snapAngle(a);
  if (a <= -Math.PI) a += 2 * Math.PI;
  return Object.is(a, -0) ? 0 : a;
}

/**
 * Snaps a value to the nearest target within `tol`.
 * @param {number} v
 * @param {number[]} targets
 * @param {number} tol
 * @returns {{ value: number, target: number | null }}
 */
export function snapValue(v, targets, tol) {
  let best = null;
  let bestD = tol;
  for (const t of targets) {
    const d = Math.abs(v - t);
    if (d <= bestD) {
      best = t;
      bestD = d;
    }
  }
  return best === null ? { value: v, target: null } : { value: best, target: best };
}

/**
 * Snaps a moved box to the page's centre lines and edges: returns the
 * correction (dx, dy) to add and the guides that matched.
 * @param {Box} b The box after the move.
 * @param {number} tol
 * @param {{ w?: number, h?: number }} [page]
 * @returns {{ dx: number, dy: number, guides: { x: number | null, y: number | null } }}
 */
export function snapBoxToPage(b, tol, { w = PAGE_W, h = PAGE_H } = {}) {
  const xs = [
    { v: b.x + b.w / 2, t: [w / 2] },
    { v: b.x, t: [0] },
    { v: b.x + b.w, t: [w] },
  ];
  const ys = [
    { v: b.y + b.h / 2, t: [h / 2] },
    { v: b.y, t: [0] },
    { v: b.y + b.h, t: [h] },
  ];
  let dx = 0;
  let gx = null;
  for (const c of xs) {
    const s = snapValue(c.v, c.t, tol);
    if (s.target !== null) {
      dx = s.value - c.v;
      gx = s.target;
      break;
    }
  }
  let dy = 0;
  let gy = null;
  for (const c of ys) {
    const s = snapValue(c.v, c.t, tol);
    if (s.target !== null) {
      dy = s.value - c.v;
      gy = s.target;
      break;
    }
  }
  return { dx, dy, guides: { x: gx, y: gy } };
}

/**
 * Constrains a shape's end point: lines/arrows to 45° steps, rectangles and
 * ellipses to squares/circles (Shift, or a snap while drawing).
 * @param {'line' | 'arrow' | 'rect' | 'ellipse'} shape
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {Point}
 */
export function constrainShape(shape, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (shape === 'line' || shape === 'arrow') {
    const len = Math.hypot(dx, dy);
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: x1 + Math.cos(a) * len, y: y1 + Math.sin(a) * len };
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: x1 + Math.sign(dx || 1) * s, y: y1 + Math.sign(dy || 1) * s };
}

/**
 * Scales items from one box to another (multi-selection resize; images keep
 * their rotation, text scales its width and font size).
 * @param {Item[]} items
 * @param {Box} from
 * @param {Box} to
 * @returns {Item[]}
 */
export function scaleItems(items, from, to) {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  const mx = (/** @type {number} */ x) => to.x + (x - from.x) * sx;
  const my = (/** @type {number} */ y) => to.y + (y - from.y) * sy;
  const k = Math.sqrt(Math.abs(sx * sy)) || 1;
  return items.map((it) => {
    switch (it.type) {
      case 'stroke': {
        const pts = it.pts.slice();
        for (let i = 0; i + 1 < pts.length; i += 3) {
          pts[i] = mx(pts[i]);
          pts[i + 1] = my(pts[i + 1]);
        }
        return { ...it, pts };
      }
      case 'shape':
        return { ...it, x1: mx(it.x1), y1: my(it.y1), x2: mx(it.x2), y2: my(it.y2) };
      case 'text':
        return { ...it, x: mx(it.x), y: my(it.y), w: Math.max(40, it.w * sx), size: clamp(it.size * k, 8, 600) };
      case 'image': {
        const cx = mx(it.x + it.w / 2);
        const cy = my(it.y + it.h / 2);
        const w = Math.max(MIN_SIDE, it.w * sx);
        const ht = Math.max(MIN_SIDE, it.h * sy);
        return { ...it, x: cx - w / 2, y: cy - ht / 2, w, h: ht };
      }
      default:
        return it;
    }
  });
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

/**
 * Clamps a pan offset so the page stays in view (centred when smaller than
 * the viewport).
 * @param {number} pan Page coordinate at the viewport's edge.
 * @param {number} viewport Viewport size, CSS px.
 * @param {number} scale CSS px per page unit.
 * @param {number} page Page size, units.
 * @param {number} [margin=0] Extra room beyond the page edges, CSS px.
 * @returns {number}
 */
export function clampPan(pan, viewport, scale, page, margin = 0) {
  const visible = viewport / scale;
  const m = margin / scale;
  if (visible >= page + 2 * m) return -(visible - page) / 2;
  return clamp(pan, -m, page + m - visible);
}

/**
 * Zooms around an anchor so the page point under it stays put.
 * @param {{ zoom: number, x: number, y: number }} view `zoom` in any unit (scale or relative).
 * @param {number} nextZoom
 * @param {number} ax Anchor, CSS px from the viewport's left.
 * @param {number} ay Anchor, CSS px from the viewport's top.
 * @param {{ min?: number, max?: number, unit?: number }} [opts] Bounds of `zoom`; `unit` = CSS px per page
 *   unit at zoom 1 (default 1).
 * @returns {{ zoom: number, x: number, y: number }}
 */
export function zoomAround(view, nextZoom, ax, ay, { min = 0.25, max = 5, unit = 1 } = {}) {
  const zoom = clamp(nextZoom, min, max);
  const s0 = view.zoom * unit;
  const s1 = zoom * unit;
  const px = view.x + ax / s0;
  const py = view.y + ay / s0;
  return { zoom, x: px - ax / s1, y: py - ay / s1 };
}

/**
 * Scale (CSS px per page unit) at which the page width fits the viewport.
 * @param {number} viewportW CSS px.
 * @param {number} [margin=0] CSS px left free on each side.
 * @param {number} [pageW=PAGE_W]
 * @returns {number}
 */
export function fitWidthScale(viewportW, margin = 0, pageW = PAGE_W) {
  return Math.max(0.01, (viewportW - 2 * margin) / pageW);
}

/**
 * A centred insert box for an image of natural size (px) inside the
 * visible page area: never wider than 80 % of the visible width (or 70 % of
 * its height), never upscaled beyond 1 image px per CSS px.
 * @param {number} imgW
 * @param {number} imgH
 * @param {Box} visible Visible page area (units).
 * @param {number} scale CSS px per unit.
 * @returns {Box}
 */
export function insertBox(imgW, imgH, visible, scale) {
  const w0 = Math.max(1, imgW);
  const h0 = Math.max(1, imgH);
  const maxW = visible.w * 0.8;
  const maxH = visible.h * 0.7;
  const natural = 1 / Math.max(scale, 1e-6); // units per image px at 1:1 on screen
  let k = Math.min(maxW / w0, maxH / h0, natural);
  if (w0 * k < MIN_SIDE * 4) k = (MIN_SIDE * 4) / w0;
  const w = w0 * k;
  const h = h0 * k;
  const cx = clamp(visible.x + visible.w / 2, w / 2, PAGE_W - w / 2);
  const cy = clamp(visible.y + visible.h / 2, Math.min(h / 2, PAGE_H / 2), Math.max(PAGE_H - h / 2, PAGE_H / 2));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
