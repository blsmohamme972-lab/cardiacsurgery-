/**
 * Virtualized, continuous-scroll PDF viewer (docs/ARCHITECTURE.md §7.17
 * "features/book/viewer.js"), built on the vendored PDF.js (./pdf.js).
 *
 * DOM (inside the caller's `container`, which gets class `pdfv-host`):
 * ```
 * div.pdfv  [role=document, tabindex=0]            ← the scroller
 *   div.pdfv-pages                                  ← zoom layer (CSS transform during a gesture)
 *     div.pdfv-page [role=group, aria-label="Page N of M", data-page=N]   ← one per page, sized from its viewport
 *       canvas.pdfv-canvas    z 0  whole page (backing store capped by a pixel budget)
 *       canvas.pdfv-detail    z 1  high-zoom sharp tile of the visible part (only when the page canvas is capped)
 *       div.pdfv-hits         z 2  search highlights (current match: .is-current)
 *       div.textLayer         z 3  PDF.js text layer: real text for selection, copy, search and screen readers
 *       div.pdfv-overlay      z 4  annotation layer (pointer-events: none until the editor enables them)
 * ```
 *
 * Performance
 * - All page sizes are known up front (first page first, the rest in the background), so
 *   placeholders have the right size and positions never jump.
 * - Only the visible pages ±1 are mounted and rendered, by a priority queue (the current page
 *   first). Renders of pages scrolled away are cancelled; at most {@link MAX_ALIVE_PAGES} page
 *   canvases stay alive (an LRU); evicted pages free their canvas (0×0) and PDF.js page data.
 * - devicePixelRatio aware with a per-canvas pixel budget ({@link canvasBudget}: lower on phones).
 *   When the budget caps a zoomed page, a second canvas renders just the visible region sharply.
 * - Zoom gestures (two-finger pinch, ctrl/⌘-wheel, trackpad pinch, Safari gesture events) only
 *   scale the page layer with a CSS transform; on release the layout is recomputed at the new
 *   scale around the focal point and the visible pages are re-rendered crisply.
 * - Text layers (and sharp tiles, and off-screen neighbours) wait until scrolling pauses; a text
 *   layer is then built one adaptive chunk (~8 ms) per frame, so long pages never block scrolling.
 *
 * Every pure helper (layout, fit, ranges, LRU, focal zoom, search text) is exported for
 * tests/unit/viewer.test.mjs; importing this module touches no DOM.
 *
 * @module features/book/viewer
 */

import { h } from '../../core/dom.js';
import { loadPdfJs, readOutline, PdfError, toPdfError } from './pdf.js';

/** Smallest zoom (CSS px per PDF point). */
export const MIN_SCALE = 0.25;
/** Largest zoom (CSS px per PDF point). */
export const MAX_SCALE = 6;
/** Zoom in/out button factor. */
export const ZOOM_STEP = 1.25;
/** Page canvases kept alive (more only when that many pages are on screen at once). */
export const MAX_ALIVE_PAGES = 6;
/** Text items handed to the PDF.js text layer in its first chunk (later chunks adapt to ~8 ms each). */
export const TEXT_CHUNK = 64;

const WHEEL_COMMIT_MS = 180;
/** Quiet time after scrolling before sharp tiles and text layers are built. */
const DETAIL_SETTLE_MS = 140;
/** Quiet time after scrolling before off-screen neighbours are pre-rendered. */
const PREFETCH_SETTLE_MS = 90;
const SELECTION_SETTLE_MS = 120;
const SMOOTH_MAX_PAGES = 3;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ w: number, h: number }} Size
 * @typedef {{ gap: number, padX: number, padY: number }} Spacing
 * @typedef {{ scale: number, n: number, tops: number[], lefts: number[], widths: number[], heights: number[],
 *             totalW: number, totalH: number } & Spacing} Layout
 * @typedef {{ index: number, fx: number, fy: number }} PageLoc  Point as fractions of a page box.
 * @typedef {[number, number, number, number]} Rect  [x, y, w, h]
 */

/**
 * Clamps a zoom value to [{@link MIN_SCALE}, {@link MAX_SCALE}].
 * @param {number} s
 * @returns {number}
 */
export function clampScale(s) {
  if (!Number.isFinite(s)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Space around pages for a viewport width (phones get thin margins).
 * @param {number} viewW
 * @returns {Spacing}
 */
export function spacingFor(viewW) {
  return viewW < 600 ? { gap: 10, padX: 8, padY: 10 } : { gap: 16, padX: 20, padY: 20 };
}

/**
 * Zoom that fits a page into the viewport.
 * @param {'fit-width' | 'fit-page'} mode
 * @param {Size} page Page size in PDF points.
 * @param {Size} view Viewport size in CSS px.
 * @param {Spacing} spacing
 * @returns {number}
 */
export function fitScale(mode, page, view, spacing) {
  const availW = Math.max(1, view.w - 2 * spacing.padX);
  const availH = Math.max(1, view.h - 2 * spacing.padY);
  const byWidth = availW / Math.max(1, page.w);
  if (mode === 'fit-page') return clampScale(Math.min(byWidth, availH / Math.max(1, page.h)));
  return clampScale(byWidth);
}

/**
 * Positions of every page at a zoom: one column, pages centred, integer CSS px.
 * @param {Size[]} sizes Page sizes in PDF points.
 * @param {number} scale
 * @param {number} viewW Viewport width (CSS px).
 * @param {Spacing} spacing
 * @returns {Layout}
 */
export function computeLayout(sizes, scale, viewW, spacing) {
  const n = sizes.length;
  const widths = new Array(n);
  const heights = new Array(n);
  let maxW = 0;
  for (let i = 0; i < n; i++) {
    widths[i] = Math.max(1, Math.floor(sizes[i].w * scale));
    heights[i] = Math.max(1, Math.floor(sizes[i].h * scale));
    if (widths[i] > maxW) maxW = widths[i];
  }
  const totalW = Math.max(Math.floor(viewW), maxW + 2 * spacing.padX);
  const tops = new Array(n);
  const lefts = new Array(n);
  let y = spacing.padY;
  for (let i = 0; i < n; i++) {
    tops[i] = y;
    lefts[i] = Math.floor((totalW - widths[i]) / 2);
    y += heights[i] + spacing.gap;
  }
  const totalH = n ? y - spacing.gap + spacing.padY : 2 * spacing.padY;
  return { scale, n, tops, lefts, widths, heights, totalW, totalH, ...spacing };
}

/**
 * Index of the last page whose top is at or above `y` (0 when `y` is above the first page).
 * @param {Layout} layout
 * @param {number} y
 * @returns {number}
 */
function pageAtY(layout, y) {
  let lo = 0;
  let hi = layout.n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Pages overlapping the viewport (0-based, inclusive); `{first: -1, last: -1}` when none.
 * @param {Layout} layout
 * @param {number} scrollTop
 * @param {number} viewH
 * @returns {{ first: number, last: number }}
 */
export function visibleRange(layout, scrollTop, viewH) {
  if (!layout.n || viewH <= 0) return { first: -1, last: -1 };
  const bottom = scrollTop + viewH;
  let first = pageAtY(layout, scrollTop);
  if (layout.tops[first] + layout.heights[first] <= scrollTop) first += 1; // in the gap below it
  if (first >= layout.n || layout.tops[first] >= bottom) return { first: -1, last: -1 };
  let last = first;
  while (last + 1 < layout.n && layout.tops[last + 1] < bottom) last += 1;
  return { first, last };
}

/**
 * The page occupying most of the viewport (ties go to the earlier page).
 * @param {Layout} layout
 * @param {number} scrollTop
 * @param {number} viewH
 * @returns {number} 0-based index (nearest page when none is visible).
 */
export function mostVisiblePage(layout, scrollTop, viewH) {
  if (!layout.n) return 0;
  const { first, last } = visibleRange(layout, scrollTop, viewH);
  if (first < 0) return Math.min(layout.n - 1, pageAtY(layout, scrollTop));
  let best = first;
  let bestH = -1;
  for (let i = first; i <= last; i++) {
    const top = Math.max(scrollTop, layout.tops[i]);
    const bottom = Math.min(scrollTop + viewH, layout.tops[i] + layout.heights[i]);
    const seen = bottom - top;
    if (seen > bestH + 0.5) {
      best = i;
      bestH = seen;
    }
  }
  return best;
}

/**
 * Pages to keep rendered: the visible ones plus `extra` on each side.
 * @param {{ first: number, last: number }} visible
 * @param {number} count Page count.
 * @param {number} [extra=1]
 * @returns {{ first: number, last: number }}
 */
export function renderRange(visible, count, extra = 1) {
  if (visible.first < 0 || !count) return { first: -1, last: -1 };
  return { first: Math.max(0, visible.first - extra), last: Math.min(count - 1, visible.last + extra) };
}

/**
 * Canvas pixels per CSS px for a page box: the device pixel ratio, lowered so the
 * backing store stays within `maxPixels`.
 * @param {number} cssW
 * @param {number} cssH
 * @param {number} dpr
 * @param {number} maxPixels
 * @returns {number}
 */
export function outputScaleFor(cssW, cssH, dpr, maxPixels) {
  const area = Math.max(1, cssW * cssH);
  return Math.max(0.1, Math.min(dpr, Math.sqrt(maxPixels / area)));
}

/**
 * Pixel budget for one canvas: smaller on phones/tablets and low-memory devices.
 * @param {{ deviceMemory?: number, coarse?: boolean }} [device]
 * @returns {number}
 */
export function canvasBudget({ deviceMemory, coarse = false } = {}) {
  if (deviceMemory && deviceMemory <= 2) return 3e6;
  if (coarse || (deviceMemory && deviceMemory <= 4)) return 5e6;
  return 12e6;
}

/**
 * Where a content point falls, as fractions of the page box it belongs to
 * (the page at or above the point; values may leave 0..1 in gaps and margins).
 * @param {Layout} layout
 * @param {number} x Content x (CSS px).
 * @param {number} y Content y (CSS px).
 * @returns {PageLoc}
 */
export function locatePoint(layout, x, y) {
  if (!layout.n) return { index: 0, fx: 0, fy: 0 };
  const index = pageAtY(layout, y);
  return {
    index,
    fx: (x - layout.lefts[index]) / layout.widths[index],
    fy: (y - layout.tops[index]) / layout.heights[index],
  };
}

/**
 * Content coordinates of a {@link PageLoc} in a layout.
 * @param {Layout} layout
 * @param {PageLoc} loc
 * @returns {{ x: number, y: number }}
 */
export function pointOf(layout, loc) {
  const i = Math.min(Math.max(0, loc.index), Math.max(0, layout.n - 1));
  if (!layout.n) return { x: 0, y: 0 };
  return { x: layout.lefts[i] + loc.fx * layout.widths[i], y: layout.tops[i] + loc.fy * layout.heights[i] };
}

/**
 * Scroll position after a zoom that keeps the content under `focal` (viewport px, before)
 * under `focalAfter` (viewport px, after; e.g. where the pinch midpoint moved to).
 * @param {Layout} before
 * @param {Layout} after
 * @param {{ left: number, top: number }} scroll Scroll position before the zoom.
 * @param {{ x: number, y: number }} focal
 * @param {{ x: number, y: number }} [focalAfter]
 * @returns {{ left: number, top: number }} Unclamped (the browser clamps).
 */
export function zoomScroll(before, after, scroll, focal, focalAfter = focal) {
  const loc = locatePoint(before, scroll.left + focal.x, scroll.top + focal.y);
  const p = pointOf(after, loc);
  return { left: p.x - focalAfter.x, top: p.y - focalAfter.y };
}

/**
 * Next zoom for the + / − buttons; stops at the fit scales on the way.
 * @param {number} scale
 * @param {1 | -1} dir
 * @param {number[]} [stops] Scales to stop at (fit width, fit page).
 * @returns {number}
 */
export function nextZoom(scale, dir, stops = []) {
  const target = dir > 0 ? scale * ZOOM_STEP : scale / ZOOM_STEP;
  let best = target;
  for (const s of stops) {
    if (!Number.isFinite(s)) continue;
    if (dir > 0 && s > scale * 1.02 && s < best) best = s;
    if (dir < 0 && s < scale / 1.02 && s > best) best = s;
  }
  return clampScale(best);
}

/** Least-recently-used set of keys (page indexes). */
export class Lru {
  /** @type {Map<number, true>} */
  #order = new Map();

  /** @param {number} key Marks `key` as just used. */
  touch(key) {
    this.#order.delete(key);
    this.#order.set(key, true);
  }

  /** @param {number} key */
  delete(key) {
    this.#order.delete(key);
  }

  /** @param {number} key */
  has(key) {
    return this.#order.has(key);
  }

  /** Number of keys. */
  get size() {
    return this.#order.size;
  }

  /** @returns {number[]} Keys, least recently used first. */
  keys() {
    return [...this.#order.keys()];
  }

  /**
   * Keys to drop so that at most `cap` remain, oldest first, never one in `keep`.
   * @param {number} cap
   * @param {{ has(key: number): boolean }} [keep]
   * @returns {number[]}
   */
  victims(cap, keep = new Set()) {
    let over = this.#order.size - cap;
    const out = [];
    if (over <= 0) return out;
    for (const key of this.#order.keys()) {
      if (over <= 0) break;
      if (keep.has(key)) continue;
      out.push(key);
      over -= 1;
    }
    return out;
  }
}

/**
 * Part of a page to render sharply when the page canvas is capped: the visible
 * part, grown by a margin as far as the pixel budget allows (at full dpr).
 * @param {Size} box Page box (CSS px).
 * @param {{ x: number, y: number, w: number, h: number }} seen Visible part (page-local CSS px).
 * @param {number} dpr
 * @param {number} maxPixels
 * @returns {{ x: number, y: number, w: number, h: number, os: number }}
 */
export function detailRegion(box, seen, dpr, maxPixels) {
  const area = Math.max(1, seen.w * seen.h);
  const maxArea = maxPixels / (dpr * dpr);
  if (area >= maxArea) {
    return { x: seen.x, y: seen.y, w: seen.w, h: seen.h, os: Math.max(0.1, Math.sqrt(maxPixels / area)) };
  }
  const grow = Math.min(1.6, Math.sqrt(maxArea / area));
  const mx = ((grow - 1) * seen.w) / 2;
  const my = ((grow - 1) * seen.h) / 2;
  const x = Math.max(0, Math.floor(seen.x - mx));
  const y = Math.max(0, Math.floor(seen.y - my));
  const w = Math.min(box.w, Math.ceil(seen.x + seen.w + mx)) - x;
  const h = Math.min(box.h, Math.ceil(seen.y + seen.h + my)) - y;
  return { x, y, w, h, os: Math.min(dpr, Math.sqrt(maxPixels / Math.max(1, w * h))) };
}

/**
 * Whether rect `outer` contains rect `inner` (objects with x, y, w, h).
 * @param {{ x: number, y: number, w: number, h: number }} outer
 * @param {{ x: number, y: number, w: number, h: number }} inner
 * @returns {boolean}
 */
export function containsRect(outer, inner) {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.w <= outer.x + outer.w + 0.5 &&
    inner.y + inner.h <= outer.y + outer.h + 0.5
  );
}

/**
 * Tidies client rects of a text selection or match: drops empty and contained
 * rects (browsers report element and text rects twice) and joins neighbours on
 * the same line.
 * @param {Rect[]} rects
 * @returns {Rect[]}
 */
export function mergeRects(rects) {
  const list = rects
    .filter((r) => r && r[2] > 0.5 && r[3] > 0.5)
    .map((r) => /** @type {Rect} */ ([r[0], r[1], r[2], r[3]]))
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  /** @type {Rect[]} */
  const out = [];
  for (const r of list) {
    let merged = false;
    for (let k = out.length - 1; k >= 0 && k >= out.length - 4; k--) {
      const o = out[k];
      const top = Math.max(o[1], r[1]);
      const bottom = Math.min(o[1] + o[3], r[1] + r[3]);
      const overlapY = bottom - top;
      if (overlapY < 0.6 * Math.min(o[3], r[3])) continue;
      const gap = Math.max(o[0], r[0]) - Math.min(o[0] + o[2], r[0] + r[2]);
      if (gap > Math.max(2, 0.4 * Math.min(o[3], r[3]))) continue;
      const x = Math.min(o[0], r[0]);
      const y = Math.min(o[1], r[1]);
      o[2] = Math.max(o[0] + o[2], r[0] + r[2]) - x;
      o[3] = Math.max(o[1] + o[3], r[1] + r[3]) - y;
      o[0] = x;
      o[1] = y;
      merged = true;
      break;
    }
    if (!merged) out.push(r);
  }
  return out;
}

const COMBINING_MARKS = /[̀-ͯ]/g;
const SPACE = /\s/;

/**
 * Search form of one character: compatibility-decomposed (ligatures split),
 * accents removed, lower case. May return '' or several characters.
 * @param {string} ch
 * @returns {string}
 */
export function foldChar(ch) {
  return ch.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}

/**
 * Search form of a query: folded, whitespace collapsed, trimmed.
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  let out = '';
  for (const ch of String(query ?? '')) out += SPACE.test(ch) ? ' ' : foldChar(ch);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * @typedef {{ text: string, item: Int32Array, off: Int32Array, raw: string, rawPos: Int32Array }} SearchText
 * `text` is the folded page text; for each of its characters `item`/`off` give the source text item and
 * offset, and `rawPos` its position in `raw` (the readable text, whitespace collapsed).
 */

/**
 * Builds the searchable text of a page from its text items. Whitespace runs and
 * line ends become one space; a hyphen at a line end followed by a lowercase
 * letter is treated as a word break ("cardi-␤ac" matches "cardiac").
 * @param {string[]} strs Text item strings, in order.
 * @param {boolean[]} eols Whether each item ends a line.
 * @returns {SearchText}
 */
export function buildSearchText(strs, eols) {
  let text = '';
  let raw = '';
  /** @type {number[]} */
  const item = [];
  /** @type {number[]} */
  const off = [];
  /** @type {number[]} */
  const rawPos = [];
  let lastSpace = true;
  /**
   * @param {string} c
   * @param {number} i
   * @param {number} k
   * @param {string} rawChar
   */
  const push = (c, i, k, rawChar) => {
    for (let j = 0; j < c.length; j++) {
      if (j === 0) raw += rawChar;
      text += c[j];
      item.push(i);
      off.push(k);
      rawPos.push(raw.length - 1);
    }
  };
  for (let i = 0; i < strs.length; i++) {
    const s = strs[i] || '';
    const next = strs[i + 1] || '';
    const hyphenBreak = Boolean(eols[i]) && /[-­]$/.test(s) && /^[a-z]/.test(next);
    for (let k = 0; k < s.length; k++) {
      let ch = s[k];
      const code = ch.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff && k + 1 < s.length) ch += s[k + 1];
      if (hyphenBreak && k === s.length - 1) break;
      if (ch === '­') continue;
      if (SPACE.test(ch)) {
        if (!lastSpace) {
          push(' ', i, k, ' ');
          lastSpace = true;
        }
      } else {
        const folded = foldChar(ch);
        if (folded) {
          push(folded, i, k, ch);
          lastSpace = false;
        }
      }
      if (ch.length === 2) k += 1;
    }
    if (eols[i] && !hyphenBreak && !lastSpace) {
      push(' ', i, s.length, ' ');
      lastSpace = true;
    }
  }
  return { text, item: Int32Array.from(item), off: Int32Array.from(off), raw, rawPos: Int32Array.from(rawPos) };
}

/**
 * Non-overlapping matches of an already normalized query.
 * @param {string} text Folded page text.
 * @param {string} q Normalized query ({@link normalizeQuery}).
 * @returns {{ start: number, end: number }[]}
 */
export function findMatches(text, q) {
  const out = [];
  if (!q) return out;
  let at = text.indexOf(q);
  while (at !== -1) {
    out.push({ start: at, end: at + q.length });
    at = text.indexOf(q, at + q.length);
  }
  return out;
}

/**
 * The text-item pieces a match covers.
 * @param {SearchText} st
 * @param {number} start
 * @param {number} end
 * @returns {{ item: number, from: number, to: number }[]}
 */
export function matchSegments(st, start, end) {
  /** @type {{ item: number, from: number, to: number }[]} */
  const out = [];
  for (let p = start; p < end; p++) {
    const it = st.item[p];
    const o = st.off[p];
    const last = out[out.length - 1];
    if (last && last.item === it) {
      if (o < last.from) last.from = o;
      if (o + 1 > last.to) last.to = o + 1;
    } else {
      out.push({ item: it, from: o, to: o + 1 });
    }
  }
  // Separator spaces at item ends (offset = length) carry no glyphs.
  return out;
}

/**
 * Readable context around a match.
 * @param {SearchText} st
 * @param {number} start
 * @param {number} end
 * @param {number} [around=40]
 * @returns {{ before: string, match: string, after: string }}
 */
export function matchExcerpt(st, start, end, around = 40) {
  const a = st.rawPos[start];
  const b = st.rawPos[end - 1] + 1;
  let before = st.raw.slice(Math.max(0, a - around), a);
  let after = st.raw.slice(b, b + around);
  if (a - around > 0) before = `…${before.replace(/^\S*\s/, '')}`;
  if (b + around < st.raw.length) after = `${after.replace(/\s\S*$/, '')}…`;
  return { before, match: st.raw.slice(a, b), after };
}

/**
 * Multiplies two affine transforms (PDF.js `Util.transform`).
 * @param {number[]} m1
 * @param {number[]} m2
 * @returns {number[]}
 */
export function multiplyTransform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Approximate box of characters `from..to` of a text item, from its geometry
 * (used for pages whose text layer is not mounted), as fractions of the page.
 * @param {number[]} vpTransform Viewport transform at scale 1.
 * @param {{ str: string, transform: number[], width: number }} item PDF.js text item.
 * @param {number} from
 * @param {number} to
 * @param {Size} page Page size in points (viewport at scale 1).
 * @returns {Rect | null}
 */
export function textItemRect(vpTransform, item, from, to, page) {
  const len = item.str.length;
  if (!len || !page.w || !page.h) return null;
  const tx = multiplyTransform(vpTransform, item.transform);
  const fontH = Math.hypot(tx[2], tx[3]) || 1;
  const angle = Math.atan2(tx[1], tx[0]);
  const scaleX = Math.hypot(vpTransform[0], vpTransform[1]) || 1;
  const width = item.width * scaleX;
  const a = Math.max(0, Math.min(len, from));
  const b = Math.max(a, Math.min(len, to));
  const u = [Math.cos(angle), Math.sin(angle)];
  const v = [Math.sin(angle), -Math.cos(angle)]; // "up" for the glyphs
  const x0 = (width * a) / len;
  const x1 = (width * b) / len;
  const asc = fontH * 0.85;
  const desc = fontH * 0.2;
  const xs = [];
  const ys = [];
  for (const along of [x0, x1]) {
    for (const up of [asc, -desc]) {
      xs.push(tx[4] + u[0] * along + v[0] * up);
      ys.push(tx[5] + u[1] * along + v[1] * up);
    }
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return [left / page.w, top / page.h, (Math.max(...xs) - left) / page.w, (Math.max(...ys) - top) / page.h];
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/** @returns {number} */
function dprNow() {
  const d = Number(globalThis.devicePixelRatio);
  return d > 0 ? Math.min(d, 4) : 1;
}

/** @returns {boolean} */
function reduceMotion() {
  const flag = document.documentElement.dataset.reduceMotion;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return Boolean(globalThis.matchMedia && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** @returns {number} */
function deviceBudget() {
  const nav = /** @type {any} */ (globalThis.navigator || {});
  const coarse = Boolean(globalThis.matchMedia && globalThis.matchMedia('(pointer: coarse)').matches);
  return canvasBudget({ deviceMemory: Number(nav.deviceMemory) || undefined, coarse });
}

/** @param {HTMLCanvasElement | null | undefined} canvas Frees a canvas's memory now (iOS keeps it otherwise). */
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
  canvas.remove();
}

/** @param {unknown} err */
function isCancel(err) {
  const name = err && typeof err === 'object' ? /** @type {any} */ (err).name : '';
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

/** @returns {Promise<void>} Resolves after the next frame has been painted (one chunk of work per frame). */
function afterNextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 16);
  });
}

/**
 * Next chunk size for incremental work: grows while chunks are cheap, shrinks when one ran long.
 * @param {number} size Current chunk size.
 * @param {number} tookMs Time the last chunk took.
 * @param {{ target?: number, min?: number, max?: number }} [limits]
 * @returns {number}
 */
export function nextChunkSize(size, tookMs, { target = 8, min = 16, max = 1024 } = {}) {
  if (tookMs < target / 2) return Math.min(max, size * 2);
  if (tookMs > target * 1.5) return Math.max(min, Math.floor(size / 2));
  return size;
}

/**
 * A text-content stream that hands PDF.js the items in chunks, at most one per
 * frame, sized so that each takes about 8 ms (span creation + font measuring).
 * @param {{ items: any[], styles: object, lang?: string | null }} content
 * @returns {ReadableStream}
 */
function chunkedTextSource(content) {
  let at = 0;
  let size = TEXT_CHUNK;
  let sentAt = 0;
  return new ReadableStream(
    {
      async pull(controller) {
        if (at > 0) {
          // PDF.js asks for the next chunk right after processing the previous one.
          size = nextChunkSize(size, performance.now() - sentAt);
          await afterNextFrame();
        }
        const items = content.items.slice(at, at + size);
        controller.enqueue({ items, styles: at === 0 ? content.styles : {}, lang: content.lang ?? null });
        at += size;
        sentAt = performance.now();
        if (at >= content.items.length) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

/** @param {number} f */
const pct = (f) => `${(f * 100).toFixed(4)}%`;

/** @param {EventTarget | null} t */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  return Boolean(el && el.closest && el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

/**
 * @typedef {(pageNumber: number, pageEl: HTMLElement, size: Size, overlayEl: HTMLElement) => ({ destroy(): void } | null | void)} OverlayHook
 *
 * @typedef {object} PdfMatch
 * @property {number} page    1-based page.
 * @property {Rect[]} rects   Boxes as fractions of the page ([x, y, w, h]).
 * @property {number} index   Position in this search's results (for showMatch).
 * @property {{ before: string, match: string, after: string }} excerpt  Readable context.
 *
 * @typedef {object} TextSelection
 * @property {number} page    1-based page of the selection (clipped to its first page).
 * @property {string} text    Selected text (whitespace collapsed).
 * @property {Rect[]} rects   Line boxes as fractions of the page.
 * @property {DOMRect} bounds Viewport rect of the selection (to place a toolbar).
 *
 * @typedef {object} PdfViewer
 * @property {Promise<void>} ready   Resolves once the first layout is on screen (rejects with a PdfError).
 * @property {HTMLElement} el        The scroller (focus it for keyboard navigation).
 * @property {(page: number, opts?: { smooth?: boolean }) => void} goTo
 * @property {() => number} page       Current page (1-based).
 * @property {() => number} pageCount
 * @property {(s: number | 'fit-width' | 'fit-page') => void} setScale
 * @property {() => number} scale      CSS px per PDF point.
 * @property {() => void} zoomIn
 * @property {() => void} zoomOut
 * @property {(query: string) => AsyncIterable<PdfMatch>} search   Pages in order; highlights every match.
 * @property {(match: PdfMatch | number) => boolean} showMatch      Scrolls to a match and marks it current.
 * @property {() => void} clearSearch
 * @property {(page: number) => Promise<string>} textOf
 * @property {() => Promise<{ title: string, page: number, level: number }[]>} outline
 * @property {(page: number, width?: number) => Promise<HTMLCanvasElement>} thumbnail
 * @property {(event: 'page' | 'scale' | 'textselect' | 'render', fn: (payload: any) => void) => () => void} on
 * @property {() => void} destroy
 */

/**
 * @typedef {object} PageState
 * @property {number} index
 * @property {HTMLElement} el
 * @property {Size} size
 * @property {number} rotation
 * @property {Promise<any> | null} proxyP
 * @property {boolean} mounted
 * @property {HTMLCanvasElement | null} canvas
 * @property {number} os
 * @property {number} renderedScale
 * @property {number} failedScale
 * @property {HTMLElement | null} textDiv
 * @property {any} textLayer
 * @property {'none' | 'loading' | 'ready' | 'failed'} textState
 * @property {HTMLElement | null} hitsDiv
 * @property {HTMLElement | null} overlayDiv
 * @property {{ destroy(): void } | null} overlayHandle
 * @property {{ canvas: HTMLCanvasElement, rect: { x: number, y: number, w: number, h: number }, scale: number } | null} detail
 * @property {HTMLElement | null} endOfContent
 */

/**
 * A view of a PDFDocumentProxy restricted to the pages `from..to` (1-based,
 * inclusive), renumbered 1..(to − from + 1). The viewer, its search, text,
 * thumbnails and outline only ever see these pages, so nothing outside the range
 * (e.g. a book's front matter) is ever rendered, read for search or listed.
 * Outline entries pointing outside the range resolve to no page (and are dropped).
 * Pure: touches nothing until a method is called. `destroy()` is not forwarded
 * (the caller owns `doc`).
 * @param {any} doc PDFDocumentProxy (or anything with `numPages` and `getPage`).
 * @param {{ from: number, to: number }} range
 * @returns {any} `{ numPages, offset, getPage(n), getOutline(), getDestination(d), getPageIndex(ref), getPageLabels() }`
 * @throws {RangeError} When the range is empty or outside the document.
 */
export function pageRangeDoc(doc, range) {
  const total = Math.max(0, Number(doc && doc.numPages) || 0);
  const from = Math.round(Number(range && range.from));
  const to = Math.round(Number(range && range.to));
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > total) {
    throw new RangeError(`Pages ${from}–${to} are not inside this PDF (1–${total})`);
  }
  const offset = from - 1;
  const count = to - from + 1;
  return Object.freeze({
    numPages: count,
    /** Pages before the range (local page n = document page n + offset). */
    offset,
    base: doc,
    /** @param {number} n 1-based page within the range. */
    getPage(n) {
      const i = Math.round(Number(n));
      if (!(i >= 1 && i <= count)) return Promise.reject(new RangeError(`No page ${n}`));
      return doc.getPage(i + offset);
    },
    getOutline: () => (typeof doc.getOutline === 'function' ? doc.getOutline() : Promise.resolve(null)),
    /** @param {string} id */
    getDestination: (id) => doc.getDestination(id),
    /** @param {any} ref @returns {Promise<number | null>} 0-based index within the range, or null outside it. */
    async getPageIndex(ref) {
      const idx = await doc.getPageIndex(ref);
      const local = Number(idx) - offset;
      return Number.isInteger(local) && local >= 0 && local < count ? local : null;
    },
    async getPageLabels() {
      const labels = typeof doc.getPageLabels === 'function' ? await doc.getPageLabels() : null;
      return Array.isArray(labels) ? labels.slice(offset, offset + count) : null;
    },
  });
}

/**
 * Creates the viewer inside `container` (which should have a definite size; the
 * viewer fills it). The document stays owned by the caller (destroy() does not
 * destroy it).
 * @param {HTMLElement} container
 * @param {any} doc PDFDocumentProxy from openPdf().
 * @param {{ initialPage?: number, initialScale?: number | 'fit-width' | 'fit-page',
 *           onPageChange?: ((page: number) => void) | null, overlay?: OverlayHook | null,
 *           label?: string, pages?: { from: number, to: number } | null }} [opts]
 *   `pages` shows only that page range of `doc` (see {@link pageRangeDoc}); every page number of the
 *   viewer's API, events and labels is then counted within the range ("Page 3 of 21").
 * @returns {PdfViewer}
 */
export function createPdfViewer(
  container,
  sourceDoc,
  { initialPage = 1, initialScale = 'fit-width', onPageChange = null, overlay = null, label = 'PDF document', pages: pageSubset = null } = {},
) {
  const doc = pageSubset ? pageRangeDoc(sourceDoc, pageSubset) : sourceDoc;
  const N = Math.max(0, Number(doc && doc.numPages) || 0);
  const ac = new AbortController();
  const { signal } = ac;
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const listeners = new Map();
  /** @type {Set<AbortController>} */
  const gestureControllers = new Set();

  /**
   * @param {string} name
   * @param {any} payload
   */
  const emit = (name, payload) => {
    const set = listeners.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[pdf viewer] "${name}" listener failed`, err);
      }
    }
  };

  container.classList.add('pdfv-host');
  const sizer = h('div', { class: 'pdfv-sizer', 'aria-hidden': 'true' });
  const layer = h('div', { class: 'pdfv-pages' });
  const scroller = h(
    'div',
    { class: ['pdfv', 'is-loading'], role: 'document', tabindex: '0', 'aria-label': label, 'aria-busy': 'true' },
    sizer,
    layer,
  );
  container.append(scroller);

  /** @type {PageState[]} */
  const pages = [];
  /** @type {Layout | null} */
  let layout = null;
  let scale = typeof initialScale === 'number' ? clampScale(initialScale) : 1;
  /** @type {'fit-width' | 'fit-page' | null} */
  let mode = initialScale === 'fit-page' ? 'fit-page' : typeof initialScale === 'number' ? null : 'fit-width';
  let current = Math.min(Math.max(1, Math.round(Number(initialPage) || 1)), Math.max(1, N)) - 1;
  let visible = { first: -1, last: -1 };
  let range = { first: -1, last: -1 };
  let destroyed = false;
  let dpr = dprNow();
  const budget = deviceBudget();
  const lru = new Lru();
  /** @type {any} */
  let lib = null;
  let lastView = { w: 0, h: 0 };
  let lastScrollAt = 0;
  let firstRenderDone = false;

  // ---- page proxies, sizes and text -------------------------------------------------

  /** @param {number} i */
  const proxy = (i) => {
    const p = pages[i];
    if (!p.proxyP) {
      p.proxyP = doc.getPage(i + 1);
      p.proxyP.catch(() => {
        p.proxyP = null;
      });
    }
    return p.proxyP;
  };

  /** @type {Map<number, Promise<{ content: any, search: SearchText | null, vp1: any }>>} */
  const textCache = new Map();
  /** @param {number} i */
  const pageText = (i) => {
    let t = textCache.get(i);
    if (!t) {
      t = proxy(i).then(async (pp) => {
        const content = await pp.getTextContent({ includeMarkedContent: false });
        return { content, search: null, vp1: pp.getViewport({ scale: 1 }) };
      });
      t.catch(() => textCache.delete(i));
      textCache.set(i, t);
    }
    return t;
  };

  for (let i = 0; i < N; i++) {
    pages.push({
      index: i,
      el: h('div', {
        class: 'pdfv-page',
        role: 'group',
        'aria-label': `Page ${i + 1} of ${N}`,
        dataset: { page: i + 1 },
      }),
      size: { w: 612, h: 792 },
      rotation: 0,
      proxyP: null,
      mounted: false,
      canvas: null,
      os: 0,
      renderedScale: 0,
      failedScale: 0,
      textDiv: null,
      textLayer: null,
      textState: 'none',
      hitsDiv: null,
      overlayDiv: null,
      overlayHandle: null,
      detail: null,
      endOfContent: null,
    });
  }

  // ---- layout ---------------------------------------------------------------------

  const viewSize = () => ({ w: scroller.clientWidth, h: scroller.clientHeight });
  const sizes = () => pages.map((p) => p.size);

  /** @param {'fit-width' | 'fit-page'} m */
  const fitFor = (m) => {
    const view = viewSize();
    const ref = pages[current] ? pages[current].size : { w: 612, h: 792 };
    return fitScale(m, ref, view, spacingFor(view.w));
  };

  const applyLayout = () => {
    const view = viewSize();
    layout = computeLayout(sizes(), scale, view.w, spacingFor(view.w));
    layer.style.width = sizer.style.width = `${layout.totalW}px`;
    layer.style.height = sizer.style.height = `${layout.totalH}px`;
    layer.style.setProperty('--scale-factor', String(scale));
    for (let i = 0; i < N; i++) {
      const s = pages[i].el.style;
      s.left = `${layout.lefts[i]}px`;
      s.top = `${layout.tops[i]}px`;
      s.width = `${layout.widths[i]}px`;
      s.height = `${layout.heights[i]}px`;
    }
    lastView = view;
  };

  /** Reading position at the top of the viewport. */
  const captureAnchor = () => {
    if (!layout) return null;
    return locatePoint(layout, scroller.scrollLeft + lastView.w / 2, scroller.scrollTop + layout.padY / 2);
  };
  /** @param {PageLoc | null} loc */
  const restoreAnchor = (loc) => {
    if (!layout || !loc) return;
    const p = pointOf(layout, loc);
    scroller.scrollTop = p.y - layout.padY / 2;
    scroller.scrollLeft = p.x - lastView.w / 2;
  };

  const emitScale = () => {
    emit('scale', { scale, mode, fitWidth: fitFor('fit-width'), fitPage: fitFor('fit-page') });
  };

  /**
   * Commits a new zoom, keeping the content under `focal` in place.
   * @param {number} s
   * @param {'fit-width' | 'fit-page' | null} m
   * @param {{ from?: { left: number, top: number }, focal?: { x: number, y: number }, focalAfter?: { x: number, y: number }, top?: boolean }} [at]
   */
  const applyScale = (s, m, at = {}) => {
    if (!layout) {
      scale = clampScale(s);
      mode = m;
      return;
    }
    const before = layout;
    const view = viewSize();
    const from = at.from || { left: scroller.scrollLeft, top: scroller.scrollTop };
    const focal = at.focal || { x: view.w / 2, y: at.top ? before.padY / 2 : view.h / 2 };
    const next = clampScale(s);
    const changed = Math.abs(next - scale) > 1e-6;
    scale = next;
    mode = m;
    applyLayout();
    const pos = zoomScroll(before, /** @type {Layout} */ (layout), from, focal, at.focalAfter || focal);
    scroller.scrollLeft = pos.left;
    scroller.scrollTop = pos.top;
    if (changed) {
      if (active && (active.kind === 'page' || active.kind === 'detail') && active.scale !== scale) cancelJob(active);
      for (const p of pages) if (p.detail) dropDetail(p);
    }
    emitScale();
    update();
  };

  // ---- mounting -------------------------------------------------------------------

  /** @param {PageState} p */
  const mount = (p) => {
    if (p.mounted) return;
    p.mounted = true;
    p.hitsDiv = h('div', { class: 'pdfv-hits', 'aria-hidden': 'true' });
    p.textDiv = h('div', { class: ['textLayer', 'pdfv-text'] });
    p.overlayDiv = h('div', { class: 'pdfv-overlay' });
    p.el.append(p.hitsDiv, p.textDiv, p.overlayDiv);
    p.el.classList.add('is-mounted');
    drawHits(p);
    if (typeof overlay === 'function') {
      try {
        const handle = overlay(p.index + 1, p.el, { w: p.size.w, h: p.size.h }, p.overlayDiv);
        p.overlayHandle = handle && typeof handle.destroy === 'function' ? handle : null;
      } catch (err) {
        console.error('[pdf viewer] overlay failed for page', p.index + 1, err);
      }
    }
  };

  /** @param {PageState} p */
  const unmount = (p) => {
    if (!p.mounted) return;
    if (active && active.index === p.index && active.kind !== 'thumb') cancelJob(active);
    if (p.overlayHandle) {
      try {
        p.overlayHandle.destroy();
      } catch (err) {
        console.error('[pdf viewer] overlay destroy failed for page', p.index + 1, err);
      }
    }
    p.overlayHandle = null;
    if (p.textLayer) {
      try {
        p.textLayer.cancel();
      } catch {
        /* finished already */
      }
    }
    p.textLayer = null;
    p.textState = 'none';
    unregisterTextLayer(p);
    dropDetail(p);
    releaseCanvas(p.canvas);
    p.canvas = null;
    p.os = 0;
    p.renderedScale = 0;
    p.failedScale = 0;
    for (const el of [p.hitsDiv, p.textDiv, p.overlayDiv]) el?.remove();
    p.el.querySelector('.pdfv-page-error')?.remove();
    p.hitsDiv = p.textDiv = p.overlayDiv = p.endOfContent = null;
    p.el.classList.remove('is-mounted', 'is-rendered', 'is-error');
    p.mounted = false;
    lru.delete(p.index);
    // Free decoded images and operator lists of a page far away.
    p.proxyP?.then((pp) => pp.cleanup()).catch(() => {});
  };

  const evict = () => {
    const keep = new Set();
    for (let i = range.first; i >= 0 && i <= range.last; i++) keep.add(i);
    const cap = Math.max(MAX_ALIVE_PAGES, keep.size);
    for (const i of lru.victims(cap, keep)) unmount(pages[i]);
  };

  // ---- scroll tracking --------------------------------------------------------------

  let updateQueued = 0;
  const onScroll = () => {
    lastScrollAt = performance.now();
    if (!updateQueued) updateQueued = requestAnimationFrame(update);
  };

  function update() {
    if (updateQueued) cancelAnimationFrame(updateQueued);
    updateQueued = 0;
    if (!layout || destroyed) return;
    const vt = scroller.scrollTop;
    const vh = scroller.clientHeight;
    if (dprNow() !== dpr) {
      dpr = dprNow();
      for (const p of pages) if (p.mounted) p.renderedScale = 0;
    }
    visible = visibleRange(layout, vt, vh);
    range = renderRange(visible, N, 1);
    if (visible.first >= 0) {
      for (let i = range.first; i <= range.last; i++) {
        mount(pages[i]);
        lru.touch(i);
      }
      // Visible pages are the most recently used.
      for (let i = visible.first; i <= visible.last; i++) lru.touch(i);
    }
    if (active && active.kind === 'page' && (active.index < range.first || active.index > range.last)) cancelJob(active);
    if (active && active.kind === 'detail' && (active.index < visible.first || active.index > visible.last)) cancelJob(active);
    for (const p of pages) if (p.detail && (p.index < visible.first || p.index > visible.last)) dropDetail(p);
    evict();
    const cur = mostVisiblePage(layout, vt, vh);
    if (cur !== current) {
      current = cur;
      notifyPage();
    }
    schedule();
  }

  let notified = 0;
  const notifyPage = () => {
    const n = current + 1;
    if (n === notified) return;
    notified = n;
    if (typeof onPageChange === 'function') {
      try {
        onPageChange(n);
      } catch (err) {
        console.error('[pdf viewer] onPageChange failed', err);
      }
    }
    emit('page', n);
  };

  // ---- render queue -----------------------------------------------------------------

  /**
   * @typedef {{ kind: 'page' | 'text' | 'detail' | 'thumb', index: number, scale: number, cancelled: boolean, task: any,
   *             region?: { x: number, y: number, w: number, h: number, os: number },
   *             width?: number, resolve?: (c: HTMLCanvasElement) => void, reject?: (e: unknown) => void }} Job
   */
  /** @type {Job | null} */
  let active = null;
  /** @type {Job[]} */
  const thumbQueue = [];
  let pumpQueued = false;
  /** @type {any} */
  let gesture = null; // transient zoom in progress (rendering pauses)

  const schedule = () => {
    if (pumpQueued || destroyed) return;
    pumpQueued = true;
    Promise.resolve().then(pump);
  };

  /** @param {Job} job */
  function cancelJob(job) {
    job.cancelled = true;
    try {
      job.task?.cancel();
    } catch {
      /* not started */
    }
  }

  /** Visible pages (current first, then by distance), then the ±1 neighbours. */
  const priorityOrder = () => {
    const out = [];
    if (visible.first < 0) return out;
    out.push(current);
    for (let d = 1; d <= visible.last - visible.first; d++) {
      if (current - d >= visible.first) out.push(current - d);
      if (current + d <= visible.last) out.push(current + d);
    }
    for (let i = range.first; i <= range.last; i++) if (i < visible.first || i > visible.last) out.push(i);
    return out.filter((i, k) => i >= 0 && i < N && out.indexOf(i) === k);
  };

  /**
   * The most useful job now: visible pages (current first), then — once scrolling pauses —
   * the ±1 neighbours, text layers and sharp tiles; thumbnails last.
   * @returns {Job | null}
   */
  const nextJob = () => {
    if (layout && !gesture) {
      const quiet = performance.now() - lastScrollAt;
      let wake = Infinity;
      const order = priorityOrder();
      for (const i of order) {
        const p = pages[i];
        if (!p.mounted || p.renderedScale === scale || p.failedScale === scale) continue;
        const onScreen = i >= visible.first && i <= visible.last;
        if (onScreen || quiet >= PREFETCH_SETTLE_MS) return { kind: 'page', index: i, scale, cancelled: false, task: null };
        wake = Math.min(wake, PREFETCH_SETTLE_MS - quiet);
      }
      if (quiet < DETAIL_SETTLE_MS) {
        wake = Math.min(wake, DETAIL_SETTLE_MS - quiet);
      } else {
        for (const i of order) {
          const p = pages[i];
          if (p.mounted && p.canvas && p.textState === 'none') return { kind: 'text', index: i, scale, cancelled: false, task: null };
        }
        for (let i = visible.first; i >= 0 && i <= visible.last; i++) {
          const region = wantedDetail(pages[i]);
          if (region) return { kind: 'detail', index: i, scale, region, cancelled: false, task: null };
        }
      }
      if (wake < Infinity) wakeIn(wake);
    }
    return thumbQueue.shift() || null;
  };

  let wakeTimer = 0;
  /** @param {number} ms Calls the scheduler again once deferred work becomes due. */
  const wakeIn = (ms) => {
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(schedule, Math.max(0, ms) + 5);
  };

  function pump() {
    pumpQueued = false;
    if (destroyed || active) return;
    const job = nextJob();
    if (!job) return;
    if (job.kind === 'text') {
      // Text layers build in small tasks of their own; they never hold up a page render.
      buildTextLayer(job).catch((err) => console.warn('[pdf viewer] text layer', err));
      schedule();
      return;
    }
    active = job;
    const run = job.kind === 'page' ? renderPage(job) : job.kind === 'detail' ? renderDetail(job) : renderThumb(job);
    run
      .catch((err) => {
        if (job.kind === 'thumb') job.reject?.(err);
        if (isCancel(err) || job.cancelled) return;
        if (job.kind === 'page') {
          const p = pages[job.index];
          p.failedScale = job.scale;
          showPageError(p);
          console.warn('[pdf viewer] page', job.index + 1, 'could not be rendered:', err);
        } else if (job.kind === 'detail') {
          const p = pages[job.index];
          p.detail = null;
        }
      })
      .finally(() => {
        if (active === job) active = null;
        schedule();
      });
  }

  /** @param {PageState} p */
  const showPageError = (p) => {
    if (!p.mounted || p.el.querySelector('.pdfv-page-error')) return;
    p.el.classList.add('is-error');
    p.el.append(h('p', { class: 'pdfv-page-error' }, "This page couldn't be shown."));
  };

  /**
   * Draws a page at the job's scale into a new canvas, then swaps it in.
   * @param {Job} job
   */
  async function renderPage(job) {
    const p = pages[job.index];
    const pp = await proxy(job.index);
    if (job.cancelled || !p.mounted || !layout) return;
    const boxW = layout.widths[job.index];
    const boxH = layout.heights[job.index];
    const os = outputScaleFor(boxW, boxH, dpr, budget);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(boxW * os));
    canvas.height = Math.max(1, Math.floor(boxH * os));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D canvas context');
    const viewport = pp.getViewport({ scale: job.scale });
    job.task = pp.render({
      canvasContext: ctx,
      viewport,
      transform: [canvas.width / viewport.width, 0, 0, canvas.height / viewport.height, 0, 0],
    });
    try {
      await job.task.promise;
    } catch (err) {
      releaseCanvas(canvas);
      throw err;
    }
    if (job.cancelled || !p.mounted) {
      releaseCanvas(canvas);
      return;
    }
    canvas.className = 'pdfv-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    releaseCanvas(p.canvas);
    p.el.prepend(canvas);
    p.canvas = canvas;
    p.os = os;
    p.renderedScale = job.scale;
    p.el.classList.add('is-rendered');
    if (!firstRenderDone) {
      firstRenderDone = true;
      scroller.classList.remove('is-loading');
    }
    emit('render', { page: job.index + 1, scale: job.scale });
  }

  /**
   * Builds the PDF.js text layer of a drawn page (in chunks, one task each).
   * @param {Job} job
   */
  async function buildTextLayer(job) {
    const p = pages[job.index];
    const div = p.textDiv;
    if (!div) return;
    p.textState = 'loading';
    let t;
    let pp;
    try {
      [t, pp] = await Promise.all([pageText(p.index), proxy(p.index)]);
    } catch (err) {
      if (p.textDiv === div) p.textState = 'failed';
      if (!isCancel(err)) console.warn('[pdf viewer] no text for page', p.index + 1, err);
      return;
    }
    if (!p.mounted || p.textDiv !== div || p.textLayer) return; // unmounted (state reset) or built meanwhile
    const viewport = pp.getViewport({ scale });
    const tl = new lib.TextLayer({ textContentSource: chunkedTextSource(t.content), container: div, viewport });
    p.textLayer = tl;
    p.rotation = viewport.rotation;
    if (viewport.rotation % 180 === 0) {
      div.style.width = '100%';
      div.style.height = '100%';
    }
    try {
      await tl.render();
    } catch (err) {
      if (p.textLayer === tl) {
        p.textLayer = null;
        p.textState = isCancel(err) ? 'none' : 'failed';
      }
      if (!isCancel(err)) console.warn('[pdf viewer] text layer failed for page', p.index + 1, err);
      return;
    }
    if (p.textLayer !== tl || p.textDiv !== div) return;
    const end = h('div', { class: 'endOfContent' });
    div.append(end);
    p.endOfContent = end;
    registerTextLayer(p);
    p.textState = 'ready';
    drawHits(p);
  }

  // ---- high-zoom detail tiles ---------------------------------------------------------

  /** @param {PageState} p */
  function dropDetail(p) {
    if (!p.detail) return;
    releaseCanvas(p.detail.canvas);
    p.detail = null;
  }

  /**
   * Region to render sharply for a visible, capped page (null when not needed).
   * @param {PageState} p
   */
  const wantedDetail = (p) => {
    if (!layout || !p.mounted || !p.canvas || p.renderedScale !== scale || p.os >= dpr * 0.97) return null;
    const i = p.index;
    const x0 = Math.max(layout.lefts[i], scroller.scrollLeft);
    const y0 = Math.max(layout.tops[i], scroller.scrollTop);
    const x1 = Math.min(layout.lefts[i] + layout.widths[i], scroller.scrollLeft + scroller.clientWidth);
    const y1 = Math.min(layout.tops[i] + layout.heights[i], scroller.scrollTop + scroller.clientHeight);
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const seen = { x: x0 - layout.lefts[i], y: y0 - layout.tops[i], w: x1 - x0, h: y1 - y0 };
    if (p.detail && p.detail.scale === scale && containsRect(p.detail.rect, seen)) return null;
    return detailRegion({ w: layout.widths[i], h: layout.heights[i] }, seen, dpr, budget);
  };

  /** @param {Job} job */
  async function renderDetail(job) {
    const p = pages[job.index];
    const region = /** @type {NonNullable<Job['region']>} */ (job.region);
    const pp = await proxy(job.index);
    if (job.cancelled || !p.mounted || !layout) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(region.w * region.os));
    canvas.height = Math.max(1, Math.floor(region.h * region.os));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D canvas context');
    const viewport = pp.getViewport({ scale: job.scale });
    const sx = canvas.width / region.w;
    const sy = canvas.height / region.h;
    job.task = pp.render({ canvasContext: ctx, viewport, transform: [sx, 0, 0, sy, -region.x * sx, -region.y * sy] });
    try {
      await job.task.promise;
    } catch (err) {
      releaseCanvas(canvas);
      throw err;
    }
    if (job.cancelled || !p.mounted || job.scale !== scale || !p.canvas) {
      releaseCanvas(canvas);
      return;
    }
    const boxW = layout.widths[job.index];
    const boxH = layout.heights[job.index];
    canvas.className = 'pdfv-detail';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      left: pct(region.x / boxW),
      top: pct(region.y / boxH),
      width: pct(region.w / boxW),
      height: pct(region.h / boxH),
    });
    dropDetail(p);
    p.canvas.after(canvas);
    p.detail = { canvas, rect: { x: region.x, y: region.y, w: region.w, h: region.h }, scale: job.scale };
  }

  // ---- thumbnails -----------------------------------------------------------------

  /** @param {Job} job */
  async function renderThumb(job) {
    const pp = await proxy(job.index);
    if (job.cancelled || destroyed) throw new PdfError('cancelled');
    const base = pp.getViewport({ scale: 1 });
    const cssW = Math.max(16, Math.round(job.width || 120));
    const viewport = pp.getViewport({ scale: cssW / base.width });
    const os = Math.min(2, dpr);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * os));
    canvas.height = Math.max(1, Math.floor(viewport.height * os));
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;
    canvas.className = 'pdfv-thumb';
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('No 2D canvas context');
    job.task = pp.render({ canvasContext: ctx, viewport, transform: [os, 0, 0, os, 0, 0] });
    try {
      await job.task.promise;
    } catch (err) {
      releaseCanvas(canvas);
      throw err;
    }
    job.resolve?.(canvas);
  }

  // ---- search highlights ------------------------------------------------------------

  const search = {
    gen: 0,
    /** @type {PdfMatch[]} */
    matches: [],
    /** @type {{ item: number, from: number, to: number }[][]} */
    segs: [],
    /** @type {Map<number, number[]>} */
    byPage: new Map(),
    current: -1,
  };

  /**
   * Exact boxes of a match from the mounted text layer (fractions of the page).
   * @param {PageState} p
   * @param {number} mi
   * @returns {Rect[] | null}
   */
  const domRects = (p, mi) => {
    const divs = p.textLayer && p.textLayer.textDivs;
    if (!divs) return null;
    const box = p.el.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    /** @type {Rect[]} */
    const rects = [];
    const domRange = document.createRange();
    for (const seg of search.segs[mi] || []) {
      const node = divs[seg.item] && divs[seg.item].firstChild;
      if (!node || node.nodeType !== 3) continue;
      const len = /** @type {Text} */ (node).length;
      const from = Math.min(seg.from, len);
      const to = Math.min(seg.to, len);
      if (to <= from) continue;
      domRange.setStart(node, from);
      domRange.setEnd(node, to);
      for (const r of domRange.getClientRects()) rects.push([r.left - box.left, r.top - box.top, r.width, r.height]);
    }
    if (!rects.length) return null;
    return mergeRects(rects).map((r) => /** @type {Rect} */ ([r[0] / box.width, r[1] / box.height, r[2] / box.width, r[3] / box.height]));
  };

  /** @param {PageState} p */
  function drawHits(p) {
    if (!p.mounted || !p.hitsDiv) return;
    p.hitsDiv.replaceChildren();
    const list = search.byPage.get(p.index);
    if (!list || !list.length) return;
    const exact = p.textState === 'ready';
    for (const mi of list) {
      const rects = (exact && domRects(p, mi)) || search.matches[mi].rects;
      for (const r of rects) {
        p.hitsDiv.append(
          h('div', {
            class: ['pdfv-hit', mi === search.current && 'is-current'],
            style: { left: pct(r[0]), top: pct(r[1]), width: pct(r[2]), height: pct(r[3]) },
          }),
        );
      }
    }
  }

  const redrawAllHits = () => {
    for (const p of pages) if (p.mounted) drawHits(p);
  };

  /**
   * Matches of a normalized query on one page (registered in `search`).
   * @param {number} i
   * @param {string} q
   * @param {number} gen
   * @returns {Promise<PdfMatch[]>}
   */
  const pageMatches = async (i, q, gen) => {
    const t = await pageText(i);
    if (gen !== search.gen) return [];
    if (!t.search) {
      const items = t.content.items;
      t.search = buildSearchText(
        items.map((/** @type {any} */ it) => (typeof it.str === 'string' ? it.str : '')),
        items.map((/** @type {any} */ it) => Boolean(it.hasEOL)),
      );
    }
    const st = /** @type {SearchText} */ (t.search);
    const size = { w: t.vp1.width, h: t.vp1.height };
    /** @type {PdfMatch[]} */
    const found = [];
    for (const { start, end } of findMatches(st.text, q)) {
      const segs = matchSegments(st, start, end);
      /** @type {Rect[]} */
      const rects = [];
      for (const seg of segs) {
        const item = t.content.items[seg.item];
        const r = item && textItemRect(t.vp1.transform, item, seg.from, seg.to, size);
        if (r && r[2] > 0 && r[3] > 0) rects.push(r);
      }
      const match = Object.freeze({
        page: i + 1,
        rects: mergeRects(rects.map((r) => /** @type {Rect} */ ([r[0] * 1000, r[1] * 1000, r[2] * 1000, r[3] * 1000]))).map(
          (r) => /** @type {Rect} */ ([r[0] / 1000, r[1] / 1000, r[2] / 1000, r[3] / 1000]),
        ),
        index: search.matches.length,
        excerpt: matchExcerpt(st, start, end),
      });
      search.matches.push(match);
      search.segs.push(segs);
      const list = search.byPage.get(i) || [];
      list.push(match.index);
      search.byPage.set(i, list);
      found.push(match);
    }
    if (found.length) drawHits(pages[i]);
    return found;
  };

  const clearSearch = () => {
    search.gen += 1;
    search.matches = [];
    search.segs = [];
    search.byPage = new Map();
    search.current = -1;
    redrawAllHits();
  };

  /**
   * @param {string} query
   * @returns {AsyncIterable<PdfMatch>}
   */
  const searchDoc = (query) => {
    clearSearch();
    const gen = search.gen;
    const q = normalizeQuery(query);
    return {
      [Symbol.asyncIterator]() {
        let next = 0;
        /** @type {PdfMatch[]} */
        const buffer = [];
        let done = !q;
        return {
          async next() {
            for (;;) {
              if (destroyed || gen !== search.gen) done = true;
              if (buffer.length && !done) return { done: false, value: /** @type {PdfMatch} */ (buffer.shift()) };
              if (done || next >= N) {
                done = true;
                return { done: true, value: undefined };
              }
              const i = next++;
              try {
                buffer.push(...(await pageMatches(i, q, gen)));
              } catch (err) {
                if (!isCancel(err)) console.warn('[pdf viewer] search skipped page', i + 1, err);
              }
            }
          },
          async return() {
            done = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
  };

  /** @param {PdfMatch | number} target */
  const showMatch = (target) => {
    const idx = typeof target === 'number' ? target : target && typeof target.index === 'number' ? target.index : -1;
    const m = search.matches[idx];
    if (!m || !layout) return false;
    const prev = search.matches[search.current];
    search.current = idx;
    if (prev && prev.page !== m.page) drawHits(pages[prev.page - 1]);
    drawHits(pages[m.page - 1]);
    const i = m.page - 1;
    const r = m.rects[0] || /** @type {Rect} */ ([0, 0, 0, 0]);
    const y = layout.tops[i] + r[1] * layout.heights[i];
    const x = layout.lefts[i] + r[0] * layout.widths[i];
    const hgt = Math.max(8, r[3] * layout.heights[i]);
    const wid = Math.max(8, r[2] * layout.widths[i]);
    const vh = scroller.clientHeight;
    const vw = scroller.clientWidth;
    const margin = Math.min(48, vh / 6);
    let top = scroller.scrollTop;
    let left = scroller.scrollLeft;
    if (y < top + margin || y + hgt > top + vh - margin) top = y - vh / 3;
    if (x < left || x + wid > left + vw) left = x - vw / 3;
    if (top !== scroller.scrollTop || left !== scroller.scrollLeft) {
      const near = Math.abs(i - current) <= SMOOTH_MAX_PAGES;
      scroller.scrollTo({ top, left, behavior: near && !reduceMotion() ? 'smooth' : 'auto' });
    }
    return true;
  };

  // ---- text selection ---------------------------------------------------------------

  /** @type {Map<HTMLElement, PageState>} */
  const textLayers = new Map();
  /** @param {PageState} p */
  function registerTextLayer(p) {
    if (p.textDiv) textLayers.set(p.textDiv, p);
  }
  /** @param {PageState} p */
  function unregisterTextLayer(p) {
    if (p.textDiv) textLayers.delete(p.textDiv);
  }
  /** @param {PageState} p */
  const resetSelecting = (p) => {
    if (!p.textDiv || !p.endOfContent) return;
    p.textDiv.append(p.endOfContent);
    p.endOfContent.style.width = '';
    p.endOfContent.style.height = '';
    p.textDiv.classList.remove('selecting');
  };

  let hadSelection = false;
  let selectionTimer = 0;
  /** @type {Range | null} */
  let prevRange = null;

  const onSelectionChange = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) {
      for (const p of textLayers.values()) resetSelecting(p);
    } else {
      // Keep the selection from jumping (PDF.js text layer technique): text layers in the selection
      // get .selecting and the end-of-content block follows the moving end.
      const range = sel.getRangeAt(0);
      for (const [div, p] of textLayers) {
        if (range.intersectsNode(div)) div.classList.add('selecting');
        else resetSelecting(p);
      }
      const modifyStart =
        prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor = /** @type {Node | null} */ (modifyStart ? range.startContainer : range.endContainer);
      if (anchor && anchor.nodeType === 3) anchor = anchor.parentNode;
      const host = anchor && /** @type {HTMLElement} */ (anchor).parentElement?.closest('.pdfv-text');
      const p = host ? textLayers.get(/** @type {HTMLElement} */ (host)) : null;
      if (p && p.endOfContent && p.textDiv && anchor && anchor.parentElement) {
        p.endOfContent.style.width = p.textDiv.style.width;
        p.endOfContent.style.height = p.textDiv.style.height;
        anchor.parentElement.insertBefore(p.endOfContent, modifyStart ? anchor : anchor.nextSibling);
      }
      prevRange = range.cloneRange();
    }
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(reportSelection, SELECTION_SETTLE_MS);
  };

  const reportSelection = () => {
    if (destroyed) return;
    const info = readSelection();
    if (info) {
      hadSelection = true;
      emit('textselect', info);
    } else if (hadSelection) {
      hadSelection = false;
      emit('textselect', null);
    }
  };

  /** @returns {TextSelection | null} */
  const readSelection = () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!scroller.contains(range.commonAncestorContainer)) return null;
    for (const p of pages) {
      if (!p.mounted || !p.textDiv || p.textState !== 'ready' || !range.intersectsNode(p.textDiv)) continue;
      const clipped = range.cloneRange();
      if (!p.textDiv.contains(range.startContainer)) clipped.setStart(p.textDiv, 0);
      if (!p.textDiv.contains(range.endContainer)) {
        let lastText = p.textDiv.lastChild;
        while (lastText && lastText === p.endOfContent) lastText = lastText.previousSibling;
        if (lastText) clipped.setEndAfter(lastText);
        else clipped.setEnd(p.textDiv, p.textDiv.childNodes.length);
      }
      const text = clipped.toString().replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const box = p.el.getBoundingClientRect();
      /** @type {Rect[]} */
      const raw = [];
      for (const r of clipped.getClientRects()) {
        if (r.right <= box.left || r.left >= box.right || r.bottom <= box.top || r.top >= box.bottom) continue;
        raw.push([r.left - box.left, r.top - box.top, r.width, r.height]);
      }
      const rects = mergeRects(raw).map(
        (r) => /** @type {Rect} */ ([r[0] / box.width, r[1] / box.height, r[2] / box.width, r[3] / box.height]),
      );
      if (!rects.length) continue;
      return { page: p.index + 1, text, rects, bounds: clipped.getBoundingClientRect() };
    }
    return null;
  };

  // ---- zoom gestures ----------------------------------------------------------------

  /**
   * @param {number} fx Focal x in viewport px.
   * @param {number} fy
   * @param {'touch' | 'wheel' | 'gesture'} kind
   */
  const beginGesture = (fx, fy, kind) => {
    gesture = {
      kind,
      scale0: scale,
      factor: 1,
      f0: { x: fx, y: fy },
      f: { x: fx, y: fy },
      from: { left: scroller.scrollLeft, top: scroller.scrollTop },
      raf: 0,
    };
    layer.style.transformOrigin = `${gesture.from.left + fx}px ${gesture.from.top + fy}px`;
    layer.classList.add('is-zooming');
    if (active && active.kind !== 'thumb') cancelJob(active);
  };

  /**
   * @param {number} factor Relative to the zoom at the gesture start.
   * @param {number} fx Focal point now (viewport px).
   * @param {number} fy
   */
  const moveGesture = (factor, fx, fy) => {
    const g = gesture;
    if (!g) return;
    g.factor = clampScale(g.scale0 * factor) / g.scale0;
    g.f = { x: fx, y: fy };
    if (!g.raf) {
      g.raf = requestAnimationFrame(() => {
        g.raf = 0;
        if (gesture !== g) return;
        layer.style.transform = `translate(${g.f.x - g.f0.x}px, ${g.f.y - g.f0.y}px) scale(${g.factor})`;
      });
    }
  };

  const endGesture = () => {
    const g = gesture;
    if (!g) return;
    gesture = null;
    if (g.raf) cancelAnimationFrame(g.raf);
    layer.style.transform = '';
    layer.style.transformOrigin = '';
    layer.classList.remove('is-zooming');
    const moved = Math.abs(g.f.x - g.f0.x) + Math.abs(g.f.y - g.f0.y) > 0.5;
    if (Math.abs(g.factor - 1) < 1e-3 && !moved) {
      schedule();
      return;
    }
    applyScale(g.scale0 * g.factor, null, { from: g.from, focal: g.f0, focalAfter: g.f });
  };

  /** @type {{ d0: number, ac: AbortController } | null} */
  let pinch = null;

  /**
   * @param {TouchList} touches
   * @returns {{ x: number, y: number, d: number }}
   */
  const touchInfo = (touches) => {
    const r = scroller.getBoundingClientRect();
    const a = touches[0];
    const b = touches[1];
    return {
      x: (a.clientX + b.clientX) / 2 - r.left,
      y: (a.clientY + b.clientY) / 2 - r.top,
      d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    };
  };

  /** @param {TouchEvent} e */
  const onTouchMove = (e) => {
    if (!pinch || !gesture || e.touches.length < 2) return;
    if (e.cancelable) e.preventDefault();
    const t = touchInfo(e.touches);
    moveGesture(t.d / pinch.d0, t.x, t.y);
  };

  /** @param {TouchEvent} e */
  const onTouchEnd = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    pinch.ac.abort();
    gestureControllers.delete(pinch.ac);
    pinch = null;
    endGesture();
  };

  /** @param {TouchEvent} e */
  const onTouchStart = (e) => {
    if (e.touches.length < 2 || !layout) return;
    if (e.cancelable) e.preventDefault(); // two fingers: our zoom, not the browser's
    if (pinch || e.touches.length > 2) return;
    if (gesture) endGesture();
    const t = touchInfo(e.touches);
    beginGesture(t.x, t.y, 'touch');
    const pac = new AbortController();
    gestureControllers.add(pac);
    pinch = { d0: Math.max(1, t.d), ac: pac };
    const opt = { passive: false, signal: pac.signal };
    scroller.addEventListener('touchmove', onTouchMove, opt);
    scroller.addEventListener('touchend', onTouchEnd, opt);
    scroller.addEventListener('touchcancel', onTouchEnd, opt);
  };

  let wheelTimer = 0;
  /** @param {WheelEvent} e */
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey) || !layout) return;
    e.preventDefault(); // ctrl/⌘ + wheel and trackpad pinch: zoom the PDF, not the app
    if (gesture && gesture.kind !== 'wheel') return;
    const r = scroller.getBoundingClientRect();
    const fx = e.clientX - r.left;
    const fy = e.clientY - r.top;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1;
    const dy = Math.max(-150, Math.min(150, e.deltaY * unit));
    if (gesture && Math.hypot(fx - gesture.f0.x, fy - gesture.f0.y) > 24) endGesture();
    if (!gesture) beginGesture(fx, fy, 'wheel');
    moveGesture(gesture.factor * Math.exp(-dy * 0.0025), gesture.f0.x, gesture.f0.y);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(endGesture, WHEEL_COMMIT_MS);
  };

  const touchCapable = typeof navigator !== 'undefined' && (navigator.maxTouchPoints > 0 || 'ontouchstart' in globalThis);
  /** @param {any} e Safari GestureEvent. */
  const onSafariGesture = (e) => {
    e.preventDefault(); // never zoom the whole app
    if (touchCapable || !layout) return; // touch devices: handled by the touch events
    const r = scroller.getBoundingClientRect();
    if (e.type === 'gesturestart') {
      if (gesture) endGesture();
      beginGesture(e.clientX - r.left, e.clientY - r.top, 'gesture');
    } else if (gesture && gesture.kind === 'gesture') {
      if (e.type === 'gesturechange') moveGesture(Number(e.scale) || 1, gesture.f0.x, gesture.f0.y);
      else endGesture();
    }
  };

  // ---- keyboard ---------------------------------------------------------------------

  /** @param {1 | -1} dir */
  const pageStep = (dir) => {
    if (!layout) return;
    const vh = scroller.clientHeight;
    const top = scroller.scrollTop;
    const i = current;
    const pageTop = layout.tops[i] - layout.padY / 2;
    const pageBottom = layout.tops[i] + layout.heights[i];
    let target;
    if (dir > 0) target = pageBottom > top + vh + 4 ? top + vh * 0.9 : i + 1 < N ? layout.tops[i + 1] - layout.padY / 2 : top + vh;
    else target = top > pageTop + 4 ? Math.max(pageTop, top - vh * 0.9) : i > 0 ? layout.tops[i - 1] - layout.padY / 2 : 0;
    scroller.scrollTo({ top: target, behavior: reduceMotion() ? 'auto' : 'smooth' });
  };

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (!layout || e.defaultPrevented || isEditable(e.target) || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && (e.key === '+' || e.key === '=')) api.zoomIn();
    else if (mod && (e.key === '-' || e.key === '_')) api.zoomOut();
    else if (mod && e.key === '0') api.setScale('fit-width');
    else if (mod || e.shiftKey) handled = false;
    else if (e.key === 'PageDown') pageStep(1);
    else if (e.key === 'PageUp') pageStep(-1);
    else if (e.key === 'Home') goTo(1);
    else if (e.key === 'End') goTo(N);
    else handled = false;
    if (handled) e.preventDefault();
  };

  // ---- resize -----------------------------------------------------------------------

  let resizeQueued = 0;
  /** @type {(() => void) | null} */
  let sizeWaiter = null;
  const onResize = () => {
    resizeQueued = 0;
    if (destroyed) return;
    const view = viewSize();
    if (!view.w || !view.h) return;
    if (!layout) {
      sizeWaiter?.();
      return;
    }
    if (view.w === lastView.w && view.h === lastView.h) return;
    const anchor = captureAnchor();
    const before = scale;
    if (mode) scale = fitFor(mode);
    applyLayout();
    restoreAnchor(anchor);
    if (Math.abs(before - scale) > 1e-6) {
      if (active && active.kind !== 'thumb' && active.scale !== scale) cancelJob(active);
      for (const p of pages) if (p.detail) dropDetail(p);
      emitScale();
    }
    update();
  };
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (!resizeQueued) resizeQueued = requestAnimationFrame(onResize);
      })
    : null;

  // ---- navigation -------------------------------------------------------------------

  /**
   * @param {number} page 1-based.
   * @param {{ smooth?: boolean }} [opts]
   */
  function goTo(page, { smooth = true } = {}) {
    const i = Math.min(Math.max(1, Math.round(Number(page) || 1)), Math.max(1, N)) - 1;
    if (!layout) {
      current = i;
      return;
    }
    const top = layout.tops[i] - layout.padY / 2;
    const near = Math.abs(i - current) <= SMOOTH_MAX_PAGES;
    const behavior = smooth && near && !reduceMotion() ? 'smooth' : 'auto';
    if (layout.lefts[i] < scroller.scrollLeft || layout.lefts[i] + layout.widths[i] > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollTo({ top, left: Math.max(0, layout.lefts[i] - layout.padX), behavior });
    } else {
      scroller.scrollTo({ top, behavior });
    }
    if (behavior === 'auto') update();
  }

  // ---- lifecycle --------------------------------------------------------------------

  const waitForSize = () =>
    new Promise((resolve) => {
      const v = viewSize();
      if (v.w && v.h) {
        resolve(undefined);
        return;
      }
      sizeWaiter = () => {
        sizeWaiter = null;
        resolve(undefined);
      };
    });

  /** Reads the remaining page sizes; re-lays out when any differs from the first one. */
  const loadAllSizes = async () => {
    const all = await Promise.all(
      pages.map((_, i) =>
        proxy(i).then(
          (pp) => {
            const v = pp.getViewport({ scale: 1 });
            return { w: v.width, h: v.height, rotation: v.rotation };
          },
          () => null,
        ),
      ),
    );
    if (destroyed || !layout) return;
    /** @type {PageState[]} */
    const changed = [];
    all.forEach((s, i) => {
      if (!s) return;
      const p = pages[i];
      p.rotation = s.rotation;
      if (Math.abs(s.w - p.size.w) > 0.01 || Math.abs(s.h - p.size.h) > 0.01) {
        p.size = { w: s.w, h: s.h };
        changed.push(p);
      }
    });
    if (!changed.length) return;
    const anchor = captureAnchor();
    if (mode) scale = fitFor(mode);
    for (const p of changed) unmount(p); // overlay sizes and canvases are stale
    applyLayout();
    restoreAnchor(anchor);
    emitScale();
    update();
  };

  const init = async () => {
    if (!N) throw new PdfError('invalid', { detail: 'Document has no pages' });
    lib = await loadPdfJs();
    const first = await proxy(current);
    if (destroyed) return;
    const vp = first.getViewport({ scale: 1 });
    const size = { w: vp.width, h: vp.height };
    const fragment = document.createDocumentFragment();
    for (const p of pages) {
      p.size = { ...size };
      p.rotation = vp.rotation;
      fragment.append(p.el);
    }
    layer.append(fragment);
    await waitForSize();
    if (destroyed) return;
    if (mode) scale = fitFor(mode);
    applyLayout();
    const lay = /** @type {Layout} */ (layout);
    scroller.scrollTop = current > 0 ? lay.tops[current] - lay.padY / 2 : 0;
    scroller.setAttribute('aria-busy', 'false');
    update();
    notifyPage();
    emitScale();
    loadAllSizes().catch((err) => console.warn('[pdf viewer] page sizes', err));
  };

  scroller.addEventListener('scroll', onScroll, { passive: true, signal });
  scroller.addEventListener('wheel', onWheel, { passive: false, signal });
  scroller.addEventListener('touchstart', onTouchStart, { passive: false, signal });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    scroller.addEventListener(type, onSafariGesture, { passive: false, signal });
  }
  scroller.addEventListener('keydown', onKeyDown, { signal });
  // Mouse selection only (as PDF.js does): touch selection is driven by the OS handles.
  scroller.addEventListener(
    'mousedown',
    (e) => {
      const host = /** @type {HTMLElement} */ (e.target).closest?.('.pdfv-text');
      if (host) host.classList.add('selecting');
    },
    { signal },
  );
  document.addEventListener('selectionchange', onSelectionChange, { signal });
  const resetAll = () => {
    for (const p of textLayers.values()) resetSelecting(p);
  };
  document.addEventListener('pointerup', resetAll, { signal });
  globalThis.addEventListener('blur', resetAll, { signal });
  ro?.observe(scroller);

  const ready = init().then(
    () => undefined,
    (err) => {
      const error = toPdfError(err);
      if (!destroyed) {
        scroller.classList.remove('is-loading');
        scroller.setAttribute('aria-busy', 'false');
        scroller.append(h('p', { class: 'pdfv-error', role: 'alert' }, error.userMessage));
      }
      throw error;
    },
  );
  ready.catch(() => {}); // the caller may not await it

  /** @type {Promise<{ title: string, page: number, level: number }[]> | null} */
  let outlineP = null;

  /** @type {PdfViewer} */
  const api = {
    ready,
    el: scroller,
    goTo,
    page: () => current + 1,
    pageCount: () => N,
    setScale(s) {
      if (s === 'fit-width' || s === 'fit-page') {
        if (!layout) {
          mode = s;
          return;
        }
        const page = current + 1;
        applyScale(fitFor(s), s, { top: true });
        if (s === 'fit-page') goTo(page, { smooth: false });
        return;
      }
      const n = Number(s);
      if (!Number.isFinite(n) || n <= 0) return;
      applyScale(n, null);
    },
    scale: () => scale,
    zoomIn() {
      if (layout) applyScale(nextZoom(scale, 1, [fitFor('fit-width'), fitFor('fit-page')]), null);
    },
    zoomOut() {
      if (layout) applyScale(nextZoom(scale, -1, [fitFor('fit-width'), fitFor('fit-page')]), null);
    },
    search: searchDoc,
    showMatch,
    clearSearch,
    async textOf(page) {
      const i = Math.round(Number(page)) - 1;
      if (!(i >= 0 && i < N)) return '';
      const t = await pageText(i);
      return t.content.items
        .map((/** @type {any} */ it) => (typeof it.str === 'string' ? it.str : '') + (it.hasEOL ? '\n' : ''))
        .join('')
        .replace(/[ \t ]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .trim();
    },
    outline() {
      if (!outlineP) outlineP = readOutline(doc);
      return outlineP;
    },
    thumbnail(page, width = 120) {
      const i = Math.round(Number(page)) - 1;
      if (destroyed) return Promise.reject(new PdfError('cancelled'));
      if (!(i >= 0 && i < N)) return Promise.reject(new RangeError(`No page ${page}`));
      return new Promise((resolve, reject) => {
        thumbQueue.push({ kind: 'thumb', index: i, scale: 0, width, resolve, reject, cancelled: false, task: null });
        schedule();
      });
    },
    on(event, fn) {
      if (typeof fn !== 'function') return () => {};
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => set.delete(fn);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      search.gen += 1;
      ac.abort();
      for (const c of gestureControllers) c.abort();
      gestureControllers.clear();
      ro?.disconnect();
      clearTimeout(wheelTimer);
      clearTimeout(wakeTimer);
      clearTimeout(selectionTimer);
      if (updateQueued) cancelAnimationFrame(updateQueued);
      if (resizeQueued) cancelAnimationFrame(resizeQueued);
      if (gesture && gesture.raf) cancelAnimationFrame(gesture.raf);
      gesture = null;
      if (active) cancelJob(active);
      for (const job of thumbQueue.splice(0)) job.reject?.(new PdfError('cancelled'));
      for (const p of pages) unmount(p);
      textLayers.clear();
      listeners.clear();
      scroller.remove();
      container.classList.remove('pdfv-host');
    },
  };
  return api;
}
