/**
 * Book page annotations (docs/ARCHITECTURE.md §7.17): a per-page layer over the
 * PDF reader that reuses the scratchpad engine (`features/scratch/*`).
 *
 * One **session** ({@link createBookAnnotator}) per open chapter owns:
 * - the page models (`scene` in PDF points + text highlights), loaded from
 *   `pdfNotesRepo` on demand and autosaved per page (400 ms after a change, and
 *   at once on `pagehide`, when hidden, and on {@link BookAnnotator.flush}/destroy);
 * - one undo/redo history across every page of this session (an undo on a page
 *   that is scrolled away brings it back into view);
 * - the current tool, colour and size (remembered: `bookTool`, `bookColor`,
 *   `bookSize`, `bookHlColor`), the selection, the text-highlight colour bar,
 *   the voice player and the recorder.
 *
 * The viewer calls `session.overlay(page, pageEl, size)` for every mounted page
 * (§7.17 `overlay` hook). Each page gets:
 * - `.bk-marks`: text highlights (`mix-blend-mode: multiply`, under the viewer's text layer);
 * - `.bk-layer`: two canvases (scratch renderer; created only while editing or
 *   when the page has ink/images/text/shapes), the pins (sticky notes and
 *   voice notes as real buttons), the selection bar and the text editor.
 *
 * Read mode: the layer ignores input (the PDF scrolls, zooms and selects text
 * normally); pins stay tappable. Edit mode: the scratch tools draw on the
 * page; two fingers always scroll/zoom; with "Highlight text" the layer lets
 * touches through so text can be selected in the viewer's text layer, and a
 * colour bar turns the selection into highlights (rects as page fractions).
 *
 * Images: `mediaRepo` qid `book:<bookId>`; voice: `voiceRepo` qid
 * `book:<bookId>|<page>`. Unused ones are pruned on destroy after a successful save.
 *
 * Importing this module touches no DOM.
 *
 * @module features/book/annotate
 */

import { h, svg } from '../../core/dom.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { pdfNotesRepo, voiceRepo, mediaRepo } from '../../core/store/repo.js';
import { uid, formatDuration } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { sheet, button, iconButton, toast, undoToast, segmented } from '../../ui/components.js';
import {
  SCRATCH_COLORS,
  SCRATCH_SIZES,
  emptyScene,
  deserialize,
  serialize,
  applyCommand,
  makeItem,
  cloneItem,
  reorderIds,
  paintColor,
  sizeIndex,
  sizeScale,
  mediaIds,
  voiceIds,
} from '../scratch/scene.js';
import { insertBox, itemBounds, unionBounds, TEXT_LINE, TEXT_PAD } from '../scratch/geometry.js';
import { createRenderer } from '../scratch/render.js';
import { MIN_SCALE, MAX_SCALE } from './viewer.js';
import { createTools, frameFor } from '../scratch/tools.js';
import { importImage, pickImageFile, imageFilesFrom, loadMediaBlob, MediaError } from '../scratch/media.js';

/** Autosave delay per page (ms). */
export const SAVE_DELAY_MS = 400;
/** Undo steps kept per session. */
export const HISTORY_LIMIT = 300;
/** Every book tool. `texthl` = highlight selected text; `note`/`voice` = tap to place. */
export const BOOK_TOOLS = Object.freeze(['select', 'pen', 'hl', 'texthl', 'eraser', 'line', 'arrow', 'rect', 'ellipse', 'text', 'note', 'voice']);
/** Shape tools (one toolbar button). */
export const SHAPE_TOOLS = Object.freeze(['line', 'arrow', 'rect', 'ellipse']);
/** Tools that place something with a tap. */
export const TAP_TOOLS = Object.freeze(['note', 'voice']);
/**
 * Text highlight colours (stored by name, like question highlights). The hex
 * values are the marker ink painted on the (always light) PDF page and in the
 * exported PDF.
 */
export const TEXT_HL_COLORS = Object.freeze([
  Object.freeze({ name: 'yellow', label: 'Yellow', hex: '#ffd43b' }),
  Object.freeze({ name: 'green', label: 'Green', hex: '#69db7c' }),
  Object.freeze({ name: 'blue', label: 'Blue', hex: '#74c0fc' }),
  Object.freeze({ name: 'pink', label: 'Pink', hex: '#f783ac' }),
]);
/** Sticky notes are created in this colour. */
export const NOTE_COLOR = '#eab308';
/** Long-press time on a pin (ms). */
const LONG_PRESS_MS = 550;
/** Longest stored quote of a text highlight. */
const MAX_QUOTE = 500;
/** Most rects one text highlight keeps. */
const MAX_HL_RECTS = 200;

const TOOL_LABELS = Object.freeze({
  select: 'Select',
  pen: 'Pen',
  hl: 'Marker',
  texthl: 'Highlight text',
  eraser: 'Eraser',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text box',
  note: 'Sticky note',
  voice: 'Voice note',
});

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-testable)                                        */
/* ------------------------------------------------------------------ */

/**
 * Rounds to 4 decimals (page fractions).
 * @param {number} n
 */
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Validates stored text highlights (bad entries dropped, never thrown).
 * @param {any} list
 * @returns {{ id: string, color: string, rects: number[][], quote: string }[]}
 */
export function sanitizeHighlights(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) continue;
    const color = TEXT_HL_COLORS.some((c) => c.name === raw.color) ? raw.color : 'yellow';
    const rects = [];
    for (const r of Array.isArray(raw.rects) ? raw.rects.slice(0, MAX_HL_RECTS) : []) {
      if (!Array.isArray(r) || r.length < 4 || !r.slice(0, 4).every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
      const x = Math.min(1, Math.max(0, r[0]));
      const y = Math.min(1, Math.max(0, r[1]));
      const w = Math.min(1 - x, Math.max(0, r[2]));
      const ht = Math.min(1 - y, Math.max(0, r[3]));
      if (w > 0 && ht > 0) rects.push([r4(x), r4(y), r4(w), r4(ht)]);
    }
    if (!rects.length) continue;
    seen.add(raw.id);
    out.push({ id: raw.id, color, rects, quote: typeof raw.quote === 'string' ? raw.quote.slice(0, MAX_QUOTE) : '' });
  }
  return out;
}

/**
 * Client rects of a text selection → page fractions `[x, y, w, h]`, keeping
 * only rects whose centre is on the page, merged per line. Pure.
 * @param {{ left: number, top: number, width: number, height: number }[]} rects
 * @param {{ left: number, top: number, width: number, height: number }} page
 * @returns {number[][]}
 */
export function rectsToFractions(rects, page) {
  if (!page || !(page.width > 0) || !(page.height > 0)) return [];
  const list = [];
  for (const r of rects || []) {
    if (!r || !(r.width > 0.5) || !(r.height > 0.5)) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < page.left || cx > page.left + page.width || cy < page.top || cy > page.top + page.height) continue;
    const x0 = Math.max(0, (r.left - page.left) / page.width);
    const y0 = Math.max(0, (r.top - page.top) / page.height);
    const x1 = Math.min(1, (r.left + r.width - page.left) / page.width);
    const y1 = Math.min(1, (r.top + r.height - page.top) / page.height);
    if (x1 > x0 && y1 > y0) list.push([x0, y0, x1 - x0, y1 - y0]);
  }
  return mergeLineRects(list);
}

/**
 * Merges rects that sit on the same line and touch (or overlap). Pure.
 * @param {number[][]} rects `[x, y, w, h]`
 * @returns {number[][]}
 */
export function mergeLineRects(rects) {
  const sorted = rects.filter((r) => r[2] > 0 && r[3] > 0).slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  /** @type {number[][]} */
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const sameLine = Math.abs(last[1] - r[1]) < Math.min(last[3], r[3]) * 0.5 && Math.abs(last[3] - r[3]) < Math.max(last[3], r[3]) * 0.6;
      const gap = r[0] - (last[0] + last[2]);
      if (sameLine && gap < Math.max(last[3], r[3]) * 0.6 && r[0] + r[2] > last[0] - 1e-6) {
        const x0 = Math.min(last[0], r[0]);
        const y0 = Math.min(last[1], r[1]);
        const x1 = Math.max(last[0] + last[2], r[0] + r[2]);
        const y1 = Math.max(last[1] + last[3], r[1] + r[3]);
        out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
        continue;
      }
    }
    out.push(r.slice(0, 4));
  }
  return out.map((r) => r.map(r4));
}

/**
 * Does a circle (page units) touch a text highlight? Pure.
 * @param {{ rects: number[][] }} hl
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @param {{ w: number, h: number }} page
 * @returns {boolean}
 */
export function circleHitsHighlight(hl, x, y, r, page) {
  for (const [fx, fy, fw, fh] of hl.rects) {
    const rx = fx * page.w;
    const ry = fy * page.h;
    const dx = Math.max(rx - x, 0, x - (rx + fw * page.w));
    const dy = Math.max(ry - y, 0, y - (ry + fh * page.h));
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

/**
 * Do two sets of page-fraction rects overlap? Pure.
 * @param {number[][]} a
 * @param {number[][]} b
 * @returns {boolean}
 */
export function rectsOverlap(a, b) {
  for (const p of a) {
    for (const q of b) {
      if (p[0] < q[0] + q[2] && q[0] < p[0] + p[2] && p[1] < q[1] + q[3] && q[1] < p[1] + p[3]) return true;
    }
  }
  return false;
}

/**
 * Font size (page units) of a text box for a size index on a page.
 * @param {0 | 1 | 2} i
 * @param {{ w: number }} page
 * @returns {number}
 */
export function textSizeFor(i, page) {
  return Math.max(8, Math.round(SCRATCH_SIZES.text[i] * sizeScale(page) * 0.6 * 10) / 10);
}

/**
 * The voice-note qid of a book page.
 * @param {string} bookId
 * @param {number} page
 */
export const voiceQid = (bookId, page) => `book:${bookId}|${page}`;
/**
 * The image qid of a book.
 * @param {string} bookId
 */
export const mediaQid = (bookId) => `book:${bookId}`;

/* ------------------------------------------------------------------ */
/* Small DOM helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Icons the shared set does not have (24×24 stroke glyphs).
 * @param {string} name
 * @param {number} [size=22]
 * @returns {SVGElement}
 */
export function bookGlyph(name, size = 22) {
  const a = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  /** @type {Record<string, () => SVGElement[]>} */
  const shapes = {
    select: () => [svg('path', { d: 'M5 3l13 7.5-5.6 1.4L10 17.5z' }), svg('path', { d: 'M12.6 12l4.4 6' })],
    line: () => [svg('path', { d: 'M5 19L19 5' })],
    arrow: () => [svg('path', { d: 'M5 19L19 5' }), svg('path', { d: 'M10 5h9v9' })],
    rect: () => [svg('rect', { x: 4, y: 6, width: 16, height: 12, rx: 1.5 })],
    ellipse: () => [svg('ellipse', { cx: 12, cy: 12, rx: 8.5, ry: 6.5 })],
    shapes: () => [svg('rect', { x: 3.5, y: 10.5, width: 9, height: 9, rx: 1 }), svg('circle', { cx: 15.5, cy: 8.5, r: 5 })],
    text: () => [svg('path', { d: 'M5 6V4h14v2' }), svg('path', { d: 'M12 4v16' }), svg('path', { d: 'M9 20h6' })],
    texthl: () => [
      svg('rect', { x: 3, y: 15.5, width: 18, height: 5, rx: 1.2, fill: 'currentColor', 'fill-opacity': 0.3, stroke: 'none' }),
      svg('path', { d: 'M7 4h10' }),
      svg('path', { d: 'M12 4v14' }),
    ],
    front: () => [svg('rect', { x: 9, y: 9, width: 11, height: 11, rx: 1.5, fill: 'currentColor', 'fill-opacity': 0.25 }), svg('path', { d: 'M15 5V4.5A1.5 1.5 0 0 0 13.5 3h-9A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H5' })],
    back: () => [svg('rect', { x: 3, y: 3, width: 11, height: 11, rx: 1.5, fill: 'currentColor', 'fill-opacity': 0.25 }), svg('path', { d: 'M18 9h.5A1.5 1.5 0 0 1 20 10.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 19.5V19' })],
    lock: () => [svg('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }), svg('path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' })],
    unlock: () => [svg('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }), svg('path', { d: 'M8 11V8a4 4 0 0 1 7.5-2' })],
    sticky: () => [
      svg('path', { d: 'M4.5 5.5a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v9l-5 5h-9a1 1 0 0 1-1-1z' }),
      svg('path', { d: 'M14.5 19.5v-4a1 1 0 0 1 1-1h4' }),
      svg('path', { d: 'M8 9h8' }),
      svg('path', { d: 'M8 12.5h4.5' }),
    ],
  };
  const make = shapes[name];
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'icon', ...a }, ...(make ? make() : []));
}

/**
 * Icon for a tool (shared set first, then {@link bookGlyph}).
 * @param {string} name
 * @param {number} [size=22]
 */
function toolIcon(name, size = 22) {
  const map = /** @type {Record<string, string>} */ ({ pen: 'pen', hl: 'highlighter', eraser: 'eraser', image: 'image', voice: 'mic', add: 'plus' });
  if (name === 'note') return bookGlyph('sticky', size);
  return map[name] ? icon(map[name], { size }) : bookGlyph(name, size);
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

/**
 * Saves a setting without ever throwing.
 * @param {string} key
 * @param {any} value
 */
function remember(key, value) {
  try {
    setSetting(key, value).catch(() => {});
  } catch {
    /* invalid value: ignore */
  }
}

/**
 * @param {EventTarget | null} t
 * @returns {boolean}
 */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  return Boolean(el && el.tagName && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

/**
 * The nearest scrolling ancestor of an element (or the page).
 * @param {Element} el
 * @returns {Element}
 */
function scrollParent(el) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    if (/(auto|scroll)/.test(cs.overflowY) || /(auto|scroll)/.test(cs.overflowX)) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Plain-language help for a recording error.
 * @param {any} err
 * @returns {string}
 */
function recordHelp(err) {
  switch (err?.code) {
    case 'denied':
      return 'Microphone access is blocked. Allow the microphone for this site in your browser settings (iPhone/iPad: Settings > Safari > Microphone; Android: Chrome > site settings > Microphone), then try again.';
    case 'no-mic':
      return 'No microphone was found. Connect one or check that it is switched on, then try again.';
    case 'busy':
      return 'The microphone is being used by another app. Close it, then try again.';
    case 'insecure':
    case 'unsupported':
      return 'Voice notes aren’t available in this browser. On iPhone/iPad use Safari; on Android use Chrome.';
    default:
      return 'Recording couldn’t start. Please try again.';
  }
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

/**
 * @typedef {import('../scratch/scene.js').Scene} Scene
 * @typedef {import('../scratch/scene.js').Item} Item
 * @typedef {{ id: string, color: string, rects: number[][], quote: string }} TextHl
 * @typedef {{ page: number, size: { w: number, h: number }, scene: Scene, highlights: TextHl[], loaded: boolean,
 *   ready: Promise<void>, dirty: boolean, timer: ReturnType<typeof setTimeout> | null, chain: Promise<boolean>,
 *   layer: PageLayer | null, voiceRemoved: boolean }} PageModel
 * @typedef {{ page: number, scene?: { cmd: any, inverse: any }, hl?: { before: TextHl[], after: TextHl[] } }} Entry
 * @typedef {ReturnType<typeof mountLayer>} PageLayer
 * @typedef {ReturnType<typeof createBookAnnotator>} BookAnnotator
 */

/** Open sessions by book id (for {@link createPageAnnotator}). @type {Map<string, any>} */
const sessions = new Map();

/**
 * Creates the annotation session of one chapter PDF.
 *
 * @param {string} bookId Chapter id (`ch01`).
 * @param {{ viewer?: any }} [opts] The viewer (goTo, page, scale, setScale) — also settable with `attachViewer`.
 */
export function createBookAnnotator(bookId, { viewer: viewerOpt = null } = {}) {
  if (typeof bookId !== 'string' || !bookId) throw new TypeError('createBookAnnotator: bookId required');

  /** @type {Map<number, PageModel>} */
  const pages = new Map();
  /** @type {Entry[]} */
  const undoStack = [];
  /** @type {Entry[]} */
  const redoStack = [];
  /** @type {Map<string, Set<(p: any) => void>>} */
  const listeners = new Map();

  /** @type {any} */
  let viewer = null;
  let editing = false;
  let tool = normalizeTool(setting('bookTool', 'pen'));
  let lastShape = SHAPE_TOOLS.includes(tool) ? tool : 'rect';
  let color = String(setting('bookColor', SCRATCH_COLORS[1].hex)).toLowerCase();
  if (!SCRATCH_COLORS.some((c) => c.hex === color)) color = SCRATCH_COLORS[1].hex;
  let size = sizeIndex(setting('bookSize', 1));
  let hlColor = TEXT_HL_COLORS.some((c) => c.name === setting('bookHlColor', 'yellow')) ? setting('bookHlColor', 'yellow') : 'yellow';
  let aspectLock = true;
  let spaceDown = false;
  let destroyed = false;
  let mediaTouched = false;
  /** @type {{ page: number | null, ids: string[] }} */
  let selection = { page: null, ids: [] };
  /** The viewer's last text selection (`textselect` payload) or null. @type {any} */
  let lastTextSelect = null;
  /** @type {Element | null} */
  let scroller = null;

  /** @param {string} t */
  function normalizeTool(t) {
    if (t === 'shape' || t === 'shapes') return 'rect';
    return BOOK_TOOLS.includes(t) ? t : 'pen';
  }

  /* ---------------- events ---------------- */

  /**
   * @param {string} name
   * @param {any} [payload]
   */
  function emit(name, payload) {
    for (const fn of [...(listeners.get(name) || [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[book annotate] listener failed', err);
      }
    }
  }

  function emitChange() {
    emit('change', { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }

  /* ---------------- models ---------------- */

  /**
   * The model of a page (created and loaded on first use).
   * @param {number} page
   * @param {{ w: number, h: number }} pageSize
   * @returns {PageModel}
   */
  function model(page, pageSize) {
    let m = pages.get(page);
    if (m) return m;
    const sz = { w: Number(pageSize?.w) > 0 ? Number(pageSize.w) : 612, h: Number(pageSize?.h) > 0 ? Number(pageSize.h) : 792 };
    m = /** @type {PageModel} */ ({
      page,
      size: sz,
      scene: emptyScene('plain', sz),
      highlights: [],
      loaded: false,
      ready: Promise.resolve(),
      dirty: false,
      timer: null,
      chain: Promise.resolve(true),
      layer: null,
      voiceRemoved: false,
    });
    const mm = m;
    m.ready = (async () => {
      try {
        const rec = await pdfNotesRepo.get(bookId, page);
        if (rec) {
          // A change made while loading (should not happen: input waits for `loaded`) wins.
          if (!mm.dirty) {
            mm.scene = deserialize(rec.scene, { bg: 'plain', size: mm.size });
            mm.highlights = sanitizeHighlights(rec.highlights);
          }
        }
      } catch (err) {
        // Stay "not loaded": the page then takes no edits, so nothing stored can be overwritten.
        console.warn('[book annotate] could not load page notes', err);
        toast("Your notes on this page couldn't be loaded. Reload the app to try again.", { kind: 'danger' });
        return;
      }
      mm.loaded = true;
      mm.layer?.sync();
    })();
    pages.set(page, m);
    return m;
  }

  /** @param {PageModel} m */
  function scheduleSave(m) {
    m.dirty = true;
    if (m.timer) clearTimeout(m.timer);
    m.timer = setTimeout(() => {
      m.timer = null;
      void save(m);
    }, SAVE_DELAY_MS);
  }

  let lastErrorToast = 0;
  /**
   * @param {PageModel} m
   * @returns {Promise<boolean>}
   */
  function save(m) {
    if (m.timer) {
      clearTimeout(m.timer);
      m.timer = null;
    }
    m.chain = m.chain.then(async () => {
      if (!m.dirty || !m.loaded) return true;
      m.dirty = false;
      const scene = m.scene;
      const highlights = m.highlights;
      try {
        await pdfNotesRepo.set(bookId, m.page, { scene: serialize(scene), highlights });
        emit('saved', { page: m.page });
        return true;
      } catch (err) {
        m.dirty = true;
        console.warn('[book annotate] save failed', err);
        const now = Date.now();
        if (now - lastErrorToast > 8000) {
          lastErrorToast = now;
          toast("Your notes couldn't be saved. Free up some storage space, then tap Retry. Your work stays here.", {
            kind: 'danger',
            duration: 8000,
            action: { label: 'Retry', onClick: () => void flush() },
          });
        }
        return false;
      }
    });
    return m.chain;
  }

  /**
   * Saves every page now.
   * @returns {Promise<boolean>} true when everything is stored.
   */
  async function flush() {
    for (const l of layers.values()) l.commitEditor();
    const results = await Promise.all([...pages.values()].map((m) => save(m)));
    return results.every(Boolean);
  }

  /* ---------------- history ---------------- */

  /** @param {Entry} e */
  function push(e) {
    undoStack.push(e);
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  /**
   * Applies one undoable scene command on a page.
   * @param {number} page
   * @param {any} cmd
   * @returns {boolean}
   */
  function commit(page, cmd) {
    const m = pages.get(page);
    if (!m || !m.loaded || destroyed) return false;
    const res = applyCommand(m.scene, cmd);
    if (!res.inverse) return false;
    m.scene = res.scene;
    if (cmd.type === 'remove' || cmd.type === 'clear') {
      if (res.inverse.entries?.some((/** @type {any} */ e) => e.item.type === 'audio')) m.voiceRemoved = true;
      if (res.inverse.entries?.some((/** @type {any} */ e) => e.item.type === 'image')) mediaTouched = true;
    }
    push({ page, scene: { cmd, inverse: res.inverse } });
    changed(m);
    return true;
  }

  /**
   * Replaces a page's text highlights (one undo step). With `mergeSince`, the
   * change joins the single step pushed since that undo depth (an eraser
   * gesture that also removed strokes).
   * @param {number} page
   * @param {TextHl[]} next
   * @param {{ mergeSince?: number }} [opts]
   * @returns {boolean}
   */
  function commitHighlights(page, next, { mergeSince = -1 } = {}) {
    const m = pages.get(page);
    if (!m || !m.loaded || destroyed) return false;
    const before = m.highlights;
    m.highlights = next;
    const top = undoStack[undoStack.length - 1];
    if (mergeSince >= 0 && undoStack.length === mergeSince + 1 && top && top.page === page && !top.hl) {
      top.hl = { before, after: next };
      redoStack.length = 0;
    } else push({ page, hl: { before, after: next } });
    changed(m);
    return true;
  }

  /** @param {PageModel} m */
  function changed(m) {
    const ids = new Set(m.scene.items.map((i) => i.id));
    if (selection.page === m.page && selection.ids.some((id) => !ids.has(id))) {
      selection = { page: m.page, ids: selection.ids.filter((id) => ids.has(id)) };
    }
    m.layer?.sync();
    scheduleSave(m);
    emitChange();
  }

  function undo() {
    for (const l of layers.values()) l.cancelGesture();
    const e = undoStack.pop();
    if (!e) return;
    const m = pages.get(e.page);
    if (!m) return emitChange();
    /** @type {Entry} */
    const redo = { page: e.page };
    if (e.hl) {
      m.highlights = e.hl.before;
      redo.hl = e.hl;
    }
    if (e.scene) {
      const res = applyCommand(m.scene, e.scene.inverse);
      m.scene = res.scene;
      redo.scene = { cmd: res.inverse || e.scene.cmd, inverse: e.scene.inverse };
    }
    redoStack.push(redo);
    changed(m);
    reveal(e.page);
  }

  function redo() {
    for (const l of layers.values()) l.cancelGesture();
    const e = redoStack.pop();
    if (!e) return;
    const m = pages.get(e.page);
    if (!m) return emitChange();
    /** @type {Entry} */
    const again = { page: e.page };
    if (e.scene) {
      const res = applyCommand(m.scene, e.scene.cmd);
      m.scene = res.scene;
      again.scene = { cmd: e.scene.cmd, inverse: res.inverse || e.scene.inverse };
    }
    if (e.hl) {
      m.highlights = e.hl.after;
      again.hl = e.hl;
    }
    undoStack.push(again);
    changed(m);
    reveal(e.page);
  }

  /**
   * Brings a page into view when it is not on screen.
   * @param {number} page
   */
  function reveal(page) {
    const l = layers.get(page);
    if (l && l.visibleFraction() > 0.15) return;
    try {
      viewer?.goTo?.(page);
    } catch {
      /* ignore */
    }
  }

  /* ---------------- selection ---------------- */

  /**
   * @param {number | null} page
   * @param {string[]} ids
   */
  function select(page, ids) {
    const prev = selection.page;
    selection = { page: ids.length ? page : null, ids: ids.length ? ids.slice() : [] };
    if (prev !== null && prev !== selection.page) layers.get(prev)?.refreshSelection();
    if (selection.page !== null) layers.get(selection.page)?.refreshSelection();
    emit('select', { page: selection.page, count: selection.ids.length });
  }

  /* ---------------- tool / style ---------------- */

  /** @param {string} t */
  function setTool(t) {
    const next = normalizeTool(t);
    for (const l of layers.values()) l.commitEditor();
    tool = next;
    if (SHAPE_TOOLS.includes(next)) lastShape = next;
    if (next !== 'select' && selection.ids.length) select(null, []);
    remember('bookTool', next);
    for (const l of layers.values()) l.syncMode();
    showTextBar();
    emit('tool', { tool: next });
  }

  /** @param {string} hex */
  function setColor(hex) {
    if (!SCRATCH_COLORS.some((c) => c.hex === hex)) return;
    color = hex;
    remember('bookColor', hex);
    if (selection.ids.length && selection.page !== null) {
      commit(selection.page, { type: 'style', ids: selection.ids, patch: { color: hex } });
    } else if (['eraser', 'select', 'texthl', 'note', 'voice'].includes(tool)) setTool('pen');
    emit('style', getStyle());
  }

  /** @param {0 | 1 | 2} i */
  function setSize(i) {
    size = sizeIndex(i);
    remember('bookSize', size);
    if (selection.ids.length && selection.page !== null) {
      const m = pages.get(selection.page);
      if (m) {
        const k = sizeScale(m.size);
        const updated = m.scene.items
          .filter((it) => selection.ids.includes(it.id) && (it.type === 'stroke' || it.type === 'text' || it.type === 'shape'))
          .map((it) => {
            if (it.type === 'text') return { ...it, size: textSizeFor(size, m.size) };
            const key = it.type === 'stroke' ? (it.tool === 'hl' ? 'hl' : 'pen') : 'shape';
            return { ...it, size: SCRATCH_SIZES[key][size] * k };
          });
        commit(selection.page, { type: 'update', items: updated });
      }
    } else if (['eraser', 'select', 'texthl', 'note', 'voice'].includes(tool)) setTool('pen');
    emit('style', getStyle());
  }

  /** @param {string} name */
  function setHlColor(name) {
    if (!TEXT_HL_COLORS.some((c) => c.name === name)) return;
    hlColor = name;
    remember('bookHlColor', name);
    emit('style', getStyle());
  }

  function getStyle() {
    return { tool, color, size, hlColor, lastShape };
  }

  /* ---------------- editing ---------------- */

  /** @param {boolean} on */
  function setEditing(on) {
    const next = Boolean(on);
    if (next === editing) return;
    if (!next) {
      for (const l of layers.values()) {
        l.commitEditor();
        l.cancelGesture();
      }
      select(null, []);
      hlBar.hide();
      void flush();
    }
    editing = next;
    for (const l of layers.values()) l.syncMode();
    if (editing) showTextBar();
    emit('edit', { editing });
  }

  /* ---------------- scroller + pinch (two fingers scroll and zoom) ---------------- */

  /** @param {Element} el */
  function getScroller(el) {
    if (!scroller || !scroller.isConnected) scroller = scrollParent(el);
    return scroller;
  }

  /** @type {null | { mid: { x: number, y: number }, dist: number, last: { x: number, y: number }, scale: number, ratio: number }} */
  let pinch = null;

  /** @param {{ x: number, y: number }[]} pts */
  function pinchGeom(pts) {
    const mid = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mid, dist };
  }

  /**
   * Two-finger gestures. The PDF viewer already pans and zooms with two
   * fingers (touch events on its scroller, which bubble up from this layer),
   * so the layer only handles them itself when no viewer is attached.
   * @param {{ x: number, y: number }[]} pts
   */
  function pinchStart(pts) {
    if (viewer) return;
    const g = pinchGeom(pts);
    const sc = Number(viewer?.scale?.());
    pinch = { mid: g.mid, dist: g.dist, last: g.mid, scale: Number.isFinite(sc) && sc > 0 ? sc : 1, ratio: 1 };
  }

  /**
   * @param {{ x: number, y: number }[]} pts
   * @param {Element} el
   */
  function pinchMove(pts, el) {
    if (!pinch) return;
    const g = pinchGeom(pts);
    getScroller(el).scrollBy(pinch.last.x - g.mid.x, pinch.last.y - g.mid.y);
    pinch.last = g.mid;
    pinch.ratio = pinch.dist > 0 && g.dist > 0 ? g.dist / pinch.dist : 1;
    if (Math.abs(pinch.ratio - 1) > 0.06) emit('zoomhint', { scale: pinch.scale * pinch.ratio });
  }

  function pinchEnd() {
    const p = pinch;
    pinch = null;
    if (!p) return;
    emit('zoomhint', null);
    if (Math.abs(p.ratio - 1) > 0.08 && typeof viewer?.setScale === 'function') {
      try {
        viewer.setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.scale * p.ratio)));
      } catch (err) {
        console.warn('[book annotate] zoom failed', err);
      }
    }
  }

  /* ---------------- keyboard: Space pans ---------------- */

  /** @param {KeyboardEvent} e */
  const onKeyDown = (e) => {
    if (e.key === ' ' && editing && !isEditable(e.target) && /** @type {HTMLElement} */ (e.target)?.tagName !== 'BUTTON') spaceDown = true;
  };
  /** @param {KeyboardEvent} e */
  const onKeyUp = (e) => {
    if (e.key === ' ') spaceDown = false;
  };

  /* ---------------- text highlight bar ---------------- */

  const hlBar = createHlBar();

  function createHlBar() {
    /** @type {{ page: number, rects: number[][] }[]} */
    let groups = [];
    let quote = '';
    const swatches = TEXT_HL_COLORS.map((c) =>
      h(
        'button',
        {
          type: 'button',
          class: 'bk-hlbar-swatch',
          'aria-label': `Highlight ${c.label.toLowerCase()}`,
          title: `Highlight ${c.label.toLowerCase()}`,
          dataset: { color: c.name },
          style: { '--thl': c.hex },
          onPointerdown: (/** @type {PointerEvent} */ e) => e.preventDefault(),
          onClick: () => apply(c.name),
        },
        h('span', { class: 'bk-hlbar-dot', 'aria-hidden': 'true' }),
      ),
    );
    const removeBtn = h(
      'button',
      {
        type: 'button',
        class: 'bk-hlbar-remove',
        'aria-label': 'Remove highlight',
        title: 'Remove highlight',
        onPointerdown: (/** @type {PointerEvent} */ e) => e.preventDefault(),
        onClick: () => removeOverlapping(),
      },
      icon('trash', { size: 20 }),
    );
    const el = h('div', { class: 'bk-hlbar', role: 'toolbar', 'aria-label': 'Highlight the selected text', hidden: true }, swatches, removeBtn);

    function apply(/** @type {string} */ name) {
      setHlColor(name);
      for (const g of groups) {
        const m = pages.get(g.page);
        if (!m) continue;
        commitHighlights(g.page, [...m.highlights, { id: uid(), color: name, rects: g.rects, quote }]);
      }
      try {
        getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
      hide();
    }

    function removeOverlapping() {
      for (const g of groups) {
        const m = pages.get(g.page);
        if (!m) continue;
        const next = m.highlights.filter((hl) => !rectsOverlap(hl.rects, g.rects));
        if (next.length !== m.highlights.length) commitHighlights(g.page, next);
      }
      try {
        getSelection()?.removeAllRanges();
      } catch {
        /* ignore */
      }
      hide();
    }

    function hide() {
      el.hidden = true;
      groups = [];
    }

    /**
     * @param {{ page: number, rects: number[][] }[]} g
     * @param {string} text
     * @param {DOMRect} anchor
     */
    function show(g, text, anchor) {
      groups = g;
      quote = text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE);
      if (!el.isConnected) document.body.append(el);
      const overlaps = g.some(({ page, rects }) => (pages.get(page)?.highlights || []).some((hl) => rectsOverlap(hl.rects, rects)));
      removeBtn.hidden = !overlaps;
      for (const s of swatches) s.setAttribute('aria-pressed', String(s.dataset.color === hlColor));
      el.hidden = false;
      const bw = el.offsetWidth || 240;
      const bh = el.offsetHeight || 52;
      // Below the selection (the phone's own selection menu sits above it).
      let y = anchor.bottom + 10;
      if (y + bh > innerHeight - 90) y = Math.max(8, anchor.top - bh - 10);
      const x = Math.min(Math.max(8, anchor.left + anchor.width / 2 - bw / 2), innerWidth - bw - 8);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }

    return { el, show, hide, isOpen: () => !el.hidden };
  }

  /** @type {(() => void) | null} */
  let offViewer = null;

  /**
   * The viewer's text selection (`textselect`): `{ page, text, rects, bounds }` or null.
   * @param {any} info
   */
  function onTextSelect(info) {
    lastTextSelect = info || null;
    showTextBar();
  }

  /** @type {(() => void) | null} */
  let offScroll = null;
  let scrollTimer = 0;
  /**
   * The colour bar is fixed on screen: hide it while the pages scroll, and put
   * it back next to the selection once scrolling stops.
   * @param {HTMLElement | null} el The viewer's scroller.
   */
  function watchScroll(el) {
    offScroll?.();
    offScroll = null;
    if (!el) return;
    const onScroll = () => {
      if (!hlBar.isOpen() && !scrollTimer) return;
      hlBar.hide();
      clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrollTimer = 0;
        showTextBar();
      }, 220);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    offScroll = () => {
      el.removeEventListener('scroll', onScroll);
      clearTimeout(scrollTimer);
      scrollTimer = 0;
    };
  }

  /** Shows the colour bar for the current text selection (Highlight text tool only). */
  function showTextBar() {
    if (destroyed || !editing || tool !== 'texthl') return hlBar.hide();
    if (!viewer) return checkSelection();
    const info = lastTextSelect;
    const sel = getSelection();
    if (!info || !sel || sel.isCollapsed || !sel.rangeCount) return hlBar.hide();
    const rects = mergeLineRects(
      (Array.isArray(info.rects) ? info.rects : []).filter(
        (/** @type {any} */ r) => Array.isArray(r) && r.length >= 4 && r[2] > 0 && r[3] > 0 && r[3] < 0.12,
      ),
    );
    if (!rects.length || !pages.get(info.page)?.loaded) return hlBar.hide();
    // Fresh position (the pages may have scrolled since the selection was made).
    let b = sel.getRangeAt(0).getBoundingClientRect();
    if (!b.width && !b.height) b = info.bounds instanceof DOMRect ? info.bounds : new DOMRect(innerWidth / 2, innerHeight / 2, 0, 0);
    hlBar.show([{ page: info.page, rects }], String(info.text || ''), b);
  }

  let selTimer = 0;
  const onSelectionChange = () => {
    if (viewer) return; // the viewer reports settled selections itself
    clearTimeout(selTimer);
    selTimer = window.setTimeout(checkSelection, 140);
  };

  /** Fallback without a viewer: reads the document selection directly. */
  function checkSelection() {
    if (destroyed || !editing || tool !== 'texthl') return hlBar.hide();
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hlBar.hide();
    const range = sel.getRangeAt(0);
    const clientRects = [...range.getClientRects()];
    /** @type {{ page: number, rects: number[][] }[]} */
    const groups = [];
    for (const [page, l] of layers) {
      if (!range.intersectsNode(l.pageEl)) continue;
      const rects = rectsToFractions(clientRects, l.pageEl.getBoundingClientRect());
      if (rects.length && pages.get(page)?.loaded) groups.push({ page, rects });
    }
    if (!groups.length) return hlBar.hide();
    const last = clientRects.filter((r) => r.width > 0 && r.height > 0).pop() || range.getBoundingClientRect();
    const first = clientRects.find((r) => r.width > 0 && r.height > 0) || last;
    const anchor = new DOMRect(Math.min(first.left, last.left), first.top, Math.abs(last.right - first.left), last.bottom - first.top);
    hlBar.show(groups, sel.toString(), anchor);
  }

  /* ---------------- voice player ---------------- */

  const player = createPlayer();

  function createPlayer() {
    /** @type {HTMLAudioElement | null} */
    let audio = null;
    let url = '';
    /** @type {{ page: number, id: string } | null} */
    let current = null;

    function stop() {
      if (audio) {
        audio.pause();
        audio.src = '';
      }
      if (url) URL.revokeObjectURL(url);
      url = '';
      audio = null;
      const was = current;
      current = null;
      if (was) layers.get(was.page)?.setPlaying(was.id, false, 0);
    }

    /**
     * @param {number} page
     * @param {import('../scratch/scene.js').AudioItem} item
     */
    async function toggle(page, item) {
      if (current && current.id === item.id && audio) {
        if (audio.paused) await audio.play().catch(() => {});
        else audio.pause();
        layers.get(page)?.setPlaying(item.id, !audio.paused, audio.currentTime);
        return;
      }
      stop();
      let blob = null;
      try {
        const list = await voiceRepo.byQid(voiceQid(bookId, page));
        blob = list.find((v) => v.id === item.voice)?.blob || null;
      } catch (err) {
        console.warn('[book annotate] could not read the voice note', err);
      }
      if (!blob) {
        toast("This voice note isn't on this device (it may not have been in the backup).", { kind: 'danger' });
        return;
      }
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      current = { page, id: item.id };
      const a = audio;
      a.addEventListener('timeupdate', () => {
        if (current?.id === item.id) layers.get(page)?.setPlaying(item.id, !a.paused, a.currentTime);
      });
      a.addEventListener('ended', () => {
        if (current?.id === item.id) stop();
      });
      try {
        await a.play();
        layers.get(page)?.setPlaying(item.id, true, 0);
      } catch (err) {
        console.warn('[book annotate] playback failed', err);
        toast("This voice note couldn't be played.", { kind: 'danger' });
        stop();
      }
    }

    return { toggle, stop, playing: () => current };
  }

  /* ---------------- sticky notes ---------------- */

  /**
   * Opens a note for reading and editing (also used right after placing one).
   * @param {number} page
   * @param {import('../scratch/scene.js').NoteItem} item
   * @param {{ isNew?: boolean }} [opts]
   */
  function openNote(page, item, { isNew = false } = {}) {
    const ta = /** @type {HTMLTextAreaElement} */ (
      h('textarea', {
        class: 'bk-note-text',
        rows: '7',
        'aria-label': 'Note text',
        placeholder: 'Write your note…',
        'data-autofocus': '',
        maxlength: '5000',
      })
    );
    ta.value = item.text || '';
    let deleted = false;
    /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
    let ref = null;
    const del = button({
      label: 'Delete',
      icon: 'trash',
      variant: 'ghost',
      onClick: () => {
        deleted = true;
        void ref?.close('delete');
      },
    });
    del.classList.add('bk-note-delete');
    const done = button({ label: 'Done', variant: 'primary', onClick: () => void ref?.close('done') });
    ref = sheet({
      title: isNew ? 'New note' : 'Note',
      content: h('div', { class: 'bk-note' }, ta, h('p', { class: 'bk-note-hint' }, `Page ${page}. Saved on this device.`)),
      actions: [isNew ? null : del, done].filter(Boolean),
      size: 's',
      onClose: () => {
        const text = ta.value.replace(/\s+$/, '');
        if (isNew) {
          if (!deleted && text.trim()) {
            commit(page, { type: 'add', items: [{ ...item, text }] });
          }
          return;
        }
        if (deleted || !text.trim()) {
          removeWithUndo(page, item.id, 'Note deleted');
        } else if (text !== item.text) {
          commit(page, { type: 'update', items: [{ ...item, text }] });
        }
      },
    });
    ref.el.classList.add('bk-note-sheet');
    requestAnimationFrame(() => {
      ta.focus({ preventScroll: true });
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  /**
   * Removes an item (pin) and offers Undo.
   * @param {number} page
   * @param {string} id
   * @param {string} message
   */
  function removeWithUndo(page, id, message) {
    if (commit(page, { type: 'remove', ids: [id] })) {
      const depth = undoStack.length;
      undoToast(message, () => {
        if (undoStack.length === depth) undo();
        else {
          // Something else happened since: put the item back directly.
          const e = [...undoStack].reverse().find((x) => x.page === page && x.scene?.cmd?.type === 'remove' && x.scene.cmd.ids?.includes(id));
          if (e?.scene) commit(page, e.scene.inverse);
        }
      });
    }
  }

  /* ---------------- voice notes ---------------- */

  /**
   * Records a voice note and pins it at `at` on `page`.
   * @param {number} page
   * @param {{ x: number, y: number }} at
   */
  async function recordVoice(page, at) {
    let mod;
    try {
      mod = await import('../voice.js');
    } catch (err) {
      console.warn('[book annotate] voice module failed to load', err);
      toast("This tool couldn't load. Reload the app.", { kind: 'danger' });
      return;
    }
    if (!mod.isVoiceSupported()) {
      toast('Voice notes aren’t available in this browser. On iPhone/iPad use Safari; on Android use Chrome.', { kind: 'danger', duration: 7000 });
      return;
    }
    let finished = false;
    /** @type {ReturnType<typeof mod.createRecorder> | null} */
    let rec = null;
    const time = h('span', { class: 'bk-rec-time num-display', 'aria-live': 'off' }, '0:00');
    const meter = h('span', { class: 'bk-rec-meter', 'aria-hidden': 'true' }, h('span', { class: 'bk-rec-level' }));
    const status = h('p', { class: 'bk-rec-status', role: 'status' }, 'Starting the microphone…');
    const dot = h('span', { class: 'bk-rec-dot', 'aria-hidden': 'true' });
    /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
    let ref = null;
    const stopBtn = button({ label: 'Stop and save', icon: 'stop', variant: 'primary', onClick: () => void finish(true) });
    stopBtn.disabled = true;
    const cancelBtn = button({ label: 'Cancel', variant: 'secondary', onClick: () => void ref?.close('cancel') });
    let tick = 0;

    /** @param {boolean} keep */
    async function finish(keep) {
      if (finished) return;
      finished = true;
      clearInterval(tick);
      if (!rec || rec.state === 'idle') {
        void ref?.close(keep ? 'done' : 'cancel');
        return;
      }
      if (!keep) {
        rec.cancel();
        return;
      }
      stopBtn.disabled = true;
      status.textContent = 'Saving…';
      try {
        const out = await rec.stop();
        if (out.durationMs < (mod.MIN_RECORDING_MS || 600)) {
          toast('That was too short to keep. Tap Voice note and speak a little longer.', { kind: 'danger' });
        } else {
          const saved = await voiceRepo.add({ qid: voiceQid(bookId, page), blob: out.blob, mime: out.mime, durationMs: out.durationMs });
          const item = makeItem({ type: 'audio', x: at.x, y: at.y, voice: saved.id, durationMs: Math.round(out.durationMs) });
          if (commit(page, { type: 'add', items: [item] })) toast('Voice note saved on the page.', { kind: 'success' });
        }
      } catch (err) {
        console.warn('[book annotate] voice note failed', err);
        const name = /** @type {any} */ (err)?.name;
        toast(
          name === 'QuotaExceededError' ? 'Storage is full, so the voice note couldn’t be saved. Free up space and try again.' : 'The voice note couldn’t be saved. Please try again.',
          { kind: 'danger', duration: 7000 },
        );
      }
      void ref?.close('done');
    }

    ref = sheet({
      title: 'Voice note',
      content: h(
        'div',
        { class: 'bk-rec' },
        h('div', { class: 'bk-rec-head' }, dot, time),
        meter,
        status,
      ),
      actions: [cancelBtn, stopBtn],
      size: 's',
      onClose: () => {
        clearInterval(tick);
        if (!finished) {
          finished = true;
          rec?.cancel();
        }
      },
    });
    ref.el.classList.add('bk-rec-sheet');

    rec = mod.createRecorder({
      onAutoStop: () => {
        void finish(true);
      },
    });
    const r = rec;
    r.onLevel((level) => {
      meter.style.setProperty('--level', String(Math.max(0.02, Math.min(1, level))));
    });
    try {
      await r.start();
      if (finished) {
        r.cancel();
        return;
      }
      status.textContent = 'Recording… speak now. Tap Stop and save when you’re done.';
      dot.classList.add('is-live');
      stopBtn.disabled = false;
      stopBtn.focus({ preventScroll: true });
      tick = window.setInterval(() => {
        time.textContent = formatDuration(r.elapsedMs);
      }, 250);
    } catch (err) {
      finished = true;
      status.textContent = recordHelp(err);
      status.classList.add('is-error');
      stopBtn.hidden = true;
      cancelBtn.querySelector('.btn-label')?.replaceChildren('Close');
    }
  }

  /* ---------------- images ---------------- */

  /**
   * The mounted page most in view (the "current" page for inserts).
   * @returns {PageLayer | null}
   */
  function currentLayer() {
    let best = null;
    let bestF = 0;
    const want = Number(viewer?.page?.());
    if (Number.isInteger(want) && layers.get(want)?.visibleFraction() > 0) return /** @type {PageLayer} */ (layers.get(want));
    for (const l of layers.values()) {
      const f = l.visibleFraction();
      if (f > bestF) {
        bestF = f;
        best = l;
      }
    }
    return best;
  }

  /**
   * Adds pictures to the current page (Photos / Camera / Files picker when no files are given).
   * @param {File[]} [files]
   * @param {{ page?: number }} [opts] Target page (default: the page most in view).
   */
  async function addImages(files, { page: target } = {}) {
    const list = files && files.length ? files : await pickImageFile().then((f) => (f ? [f] : []));
    if (!list.length || destroyed) return;
    const layer = (target !== undefined && layers.get(target)) || currentLayer();
    if (!layer) {
      toast('Scroll to a page first, then add the picture.', { kind: 'danger' });
      return;
    }
    const m = layer.model;
    await m.ready;
    const busy = toast(list.length > 1 ? 'Adding pictures…' : 'Adding picture…', { duration: 20000 });
    /** @type {string[]} */
    const added = [];
    try {
      let offset = 0;
      for (const file of list) {
        try {
          const res = await importImage(file, { qid: mediaQid(bookId) });
          if (destroyed) return;
          mediaTouched = true;
          const vis = layer.visibleBox();
          const box = insertBox(res.width, res.height, vis, layer.scale(), m.size);
          const step = m.size.w * 0.03;
          const item = makeItem({ type: 'image', media: res.id, x: box.x + offset, y: box.y + offset, w: box.w, h: box.h, rot: 0 });
          layer.primeImage(res.id, res.bitmap || undefined);
          if (commit(m.page, { type: 'add', items: [item] })) added.push(item.id);
          offset += step;
        } catch (err) {
          const msg = err instanceof MediaError ? err.userMessage : "This picture couldn't be added. Please try again.";
          if (!(err instanceof MediaError)) console.warn('[book annotate] image import failed', err);
          toast(msg, { kind: 'danger', duration: 6000 });
        }
      }
    } finally {
      busy.close();
    }
    if (added.length) {
      if (!editing) setEditing(true);
      setTool('select');
      select(m.page, added);
    }
  }

  /* ---------------- page actions ---------------- */

  /** Clears the current page (ink, pictures, text, notes and highlights) — one undo step. */
  function clearPage() {
    const layer = currentLayer();
    if (!layer) return;
    const m = layer.model;
    if (!m.loaded || (!m.scene.items.length && !m.highlights.length)) {
      toast('This page has no notes to clear.');
      return;
    }
    const res = applyCommand(m.scene, { type: 'clear' });
    const before = m.highlights;
    if (res.inverse) {
      m.scene = res.scene;
      if (res.inverse.entries?.some((/** @type {any} */ e) => e.item.type === 'audio')) m.voiceRemoved = true;
    }
    m.highlights = [];
    push({ page: m.page, scene: res.inverse ? { cmd: { type: 'clear' }, inverse: res.inverse } : undefined, hl: before.length ? { before, after: [] } : undefined });
    select(null, []);
    changed(m);
    const depth = undoStack.length;
    undoToast(`Page ${m.page} cleared`, () => {
      if (undoStack.length === depth) undo();
    });
  }

  /** Deletes the selection (Delete key / bar button). */
  function deleteSelection() {
    if (!selection.ids.length || selection.page === null) return;
    commit(selection.page, { type: 'remove', ids: selection.ids });
    select(null, []);
  }

  /* ---------------- layers ---------------- */

  /** @type {Map<number, PageLayer>} */
  const layers = new Map();

  const session = {
    bookId,
    get editing() {
      return editing;
    },
    get tool() {
      return tool;
    },
    get color() {
      return color;
    },
    get size() {
      return size;
    },
    get aspectLock() {
      return aspectLock;
    },
    set aspectLock(v) {
      aspectLock = Boolean(v);
    },
    get spaceDown() {
      return spaceDown;
    },
    get selection() {
      return selection;
    },
    model,
    commit,
    commitHighlights,
    select,
    setTool,
    setEditing,
    getScroller,
    pinchStart,
    pinchMove,
    pinchEnd,
    openNote,
    recordVoice,
    removeWithUndo,
    player,
    undoStack,
    deleteSelection,
    addImages,
    emit,
  };

  /**
   * The viewer's overlay hook: mounts the layer of one page.
   * @param {number} pageNumber
   * @param {HTMLElement} pageEl
   * @param {{ w: number, h: number }} pageSize Page size in PDF points.
   * @param {HTMLElement} [overlayEl] The viewer's annotation slot (above its text layer); default `pageEl`.
   * @returns {{ destroy(): void }}
   */
  function overlay(pageNumber, pageEl, pageSize, overlayEl) {
    const page = Math.round(Number(pageNumber));
    if (destroyed || !Number.isInteger(page) || page < 1 || !pageEl) return { destroy() {} };
    layers.get(page)?.destroy();
    const known = pages.get(page);
    const w = Number(pageSize?.w);
    const ht = Number(pageSize?.h);
    if (known && w > 0 && ht > 0 && (Math.abs(known.size.w - w) > 0.5 || Math.abs(known.size.h - ht) > 0.5)) {
      // The viewer learnt the real page size after a first mount: move to it unless
      // this page already has undo steps (they hold items in the old units).
      if (![...undoStack, ...redoStack].some((e) => e.page === page)) {
        known.size = { w, h: ht };
        if (known.loaded) known.scene = deserialize(serialize(known.scene), { bg: 'plain', size: known.size });
      }
    }
    const m = model(page, pageSize);
    const layer = mountLayer(session, m, pageEl, overlayEl || pageEl);
    layers.set(page, layer);
    return {
      destroy() {
        if (layers.get(page) === layer) layers.delete(page);
        layer.destroy();
      },
    };
  }

  /* ---------------- lifecycle ---------------- */

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  const onPageHide = () => void flush();
  document.addEventListener('visibilitychange', onHidden);
  globalThis.addEventListener('pagehide', onPageHide);
  document.addEventListener('selectionchange', onSelectionChange);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);

  /**
   * Pages of this book that have notes (stored or in this session).
   * @returns {Promise<Set<number>>}
   */
  async function pagesWithNotes() {
    const out = new Set();
    try {
      for (const rec of await pdfNotesRepo.byBook(bookId)) {
        if ((rec.scene?.items?.length || 0) + (rec.highlights?.length || 0) > 0) out.add(rec.page);
      }
    } catch {
      /* ignore */
    }
    for (const m of pages.values()) {
      if (!m.loaded) continue;
      if (m.scene.items.length || m.highlights.length) out.add(m.page);
      else out.delete(m.page);
    }
    return out;
  }

  /** Removes images and voice clips no page uses any more (after a successful save). */
  async function prune() {
    const voicePages = [...pages.values()].filter((m) => m.voiceRemoved);
    if (!mediaTouched && !voicePages.length) return;
    try {
      if (mediaTouched) {
        const keep = new Set();
        for (const rec of await pdfNotesRepo.byBook(bookId)) for (const id of mediaIds(rec.scene)) keep.add(id);
        for (const m of pages.values()) for (const id of mediaIds(m.scene)) keep.add(id);
        await mediaRepo.prune(mediaQid(bookId), keep);
      }
      for (const m of voicePages) {
        const keep = voiceIds(m.scene);
        for (const v of await voiceRepo.byQid(voiceQid(bookId, m.page))) {
          if (!keep.has(v.id)) await voiceRepo.remove(v.id);
        }
      }
    } catch (err) {
      console.warn('[book annotate] could not tidy unused pictures or voice notes', err);
    }
  }

  /**
   * Saves everything and releases the session (the reader calls it when it closes).
   * @returns {Promise<void>}
   */
  async function destroy() {
    if (destroyed) return;
    player.stop();
    const ok = await flush();
    destroyed = true;
    for (const l of [...layers.values()]) l.destroy();
    layers.clear();
    hlBar.hide();
    hlBar.el.remove();
    clearTimeout(selTimer);
    document.removeEventListener('visibilitychange', onHidden);
    globalThis.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keyup', onKeyUp, true);
    offViewer?.();
    offViewer = null;
    offScroll?.();
    if (sessions.get(bookId) === api) sessions.delete(bookId);
    if (ok) await prune();
    listeners.clear();
  }

  /**
   * Keyboard shortcuts while editing (the reader forwards keydown events).
   * @param {KeyboardEvent} e
   * @returns {boolean} true when handled.
   */
  function handleKey(e) {
    if (!editing || e.isComposing || isEditable(e.target)) return false;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else return false;
      e.preventDefault();
      return true;
    }
    if (e.altKey) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.ids.length) {
      e.preventDefault();
      deleteSelection();
      return true;
    }
    if (e.key === 'Escape' && selection.ids.length) {
      e.preventDefault();
      select(null, []);
      return true;
    }
    /** @type {Record<string, string>} */
    const keys = { v: 'select', p: 'pen', m: 'hl', h: 'texthl', e: 'eraser', t: 'text', n: 'note' };
    if (keys[k]) setTool(keys[k]);
    else if (k === 's') setTool(SHAPE_TOOLS.includes(tool) ? SHAPE_TOOLS[(SHAPE_TOOLS.indexOf(tool) + 1) % 4] : lastShape);
    else if (k === 'i') void addImages();
    else return false;
    e.preventDefault();
    return true;
  }

  const api = {
    bookId,
    overlay,
    /**
     * Connects the PDF viewer (goTo, page, scale, setScale, on('textselect')).
     * @param {any} v
     */
    attachViewer(v) {
      offViewer?.();
      viewer = v;
      offViewer = typeof v?.on === 'function' ? v.on('textselect', onTextSelect) : null;
      watchScroll(v?.el || null);
    },
    setEditing,
    isEditing: () => editing,
    setTool,
    getTool: () => tool,
    setColor,
    setSize,
    setHlColor,
    getStyle,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    addImages,
    clearPage,
    deleteSelection,
    hasSelection: () => selection.ids.length > 0,
    pagesWithNotes,
    handleKey,
    flush,
    destroy,
    /**
     * @param {'change' | 'tool' | 'style' | 'edit' | 'select' | 'saved' | 'zoomhint'} name
     * @param {(payload: any) => void} fn
     * @returns {() => void} off
     */
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)?.add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    /** @returns {number[]} pages currently mounted (for tests and the reader). */
    mountedPages: () => [...layers.keys()].sort((a, b) => a - b),
  };
  if (viewerOpt) api.attachViewer(viewerOpt);
  sessions.set(bookId, api);
  return api;
}

/**
 * Contract entry (§7.17): mounts the annotation layer of one page using the
 * open session of `bookId` (created when missing).
 * @param {string} bookId
 * @param {number} pageNumber
 * @param {HTMLElement} pageEl
 * @param {{ w: number, h: number }} size Page size in PDF points.
 * @returns {{ destroy(): void }}
 */
export function createPageAnnotator(bookId, pageNumber, pageEl, size) {
  const s = sessions.get(bookId) || createBookAnnotator(bookId);
  return s.overlay(pageNumber, pageEl, size);
}

/* ------------------------------------------------------------------ */
/* One page layer                                                      */
/* ------------------------------------------------------------------ */

/**
 * Mounts the marks + annotation layer on a page element.
 * @param {any} s The session internals.
 * @param {PageModel} m
 * @param {HTMLElement} pageEl The page box (its size follows the zoom).
 * @param {HTMLElement} slot Where the annotation layer goes (the viewer's overlay slot, or `pageEl`).
 */
function mountLayer(s, m, pageEl, slot) {
  const page = m.page;
  const marks = h('div', { class: 'bk-marks', 'aria-hidden': 'true' });
  const pins = h('div', { class: 'bk-pins' });
  const selBar = h('div', { class: 'scratch-selbar bk-selbar', role: 'toolbar', 'aria-label': 'Selection', hidden: true });
  const layerEl = h('div', { class: 'bk-layer', dataset: { page: String(page), edit: 'false' } }, pins, selBar);
  const textLayer = pageEl.querySelector('.textLayer');
  if (textLayer) pageEl.insertBefore(marks, textLayer);
  else pageEl.append(marks);
  slot.append(layerEl);

  let cssW = 0;
  let cssH = 0;
  let destroyed = false;
  /** @type {HTMLCanvasElement | null} */
  let sceneCanvas = null;
  /** @type {HTMLCanvasElement | null} */
  let liveCanvas = null;
  /** @type {ReturnType<typeof createRenderer> | null} */
  let renderer = null;
  /** @type {ReturnType<typeof createTools> | null} */
  let tools = null;
  /** @type {null | { ta: HTMLTextAreaElement, item: import('../scratch/scene.js').TextItem, isNew: boolean }} */
  let editor = null;
  /** Text highlights touched by the running eraser gesture. @type {Set<string>} */
  const erasingHl = new Set();
  /** @type {Map<string, HTMLElement>} */
  const pinEls = new Map();
  /** @type {Map<string, { bmp?: ImageBitmap }>} */
  const primed = new Map();

  const scale = () => (cssW > 0 ? cssW / m.size.w : 1);
  const needsCanvas = () => s.editing || m.scene.items.some((it) => it.type !== 'note' && it.type !== 'audio');

  /* ---------- canvases (lazy) ---------- */

  function ensureCanvas() {
    if (renderer) return renderer;
    sceneCanvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'bk-canvas', 'aria-hidden': 'true' }));
    liveCanvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'bk-live', 'aria-hidden': 'true' }));
    layerEl.prepend(sceneCanvas, liveCanvas);
    renderer = createRenderer({ sceneCanvas, liveCanvas, host: layerEl, loadMedia: loadMediaBlob, dark: () => false });
    renderer.setPaper({ mode: 'none', opacity: 0 });
    for (const [id, p] of primed) renderer.primeImage(id, p.bmp);
    primed.clear();
    renderer.setScene(m.scene);
    if (cssW && cssH) {
      renderer.resize(cssW, cssH);
      renderer.setView({ scale: scale(), x: 0, y: 0 });
    }
    return renderer;
  }

  function releaseCanvas() {
    if (!renderer) return;
    detachTools();
    renderer.destroy();
    renderer = null;
    sceneCanvas?.remove();
    liveCanvas?.remove();
    sceneCanvas = null;
    liveCanvas = null;
  }

  /* ---------- tools ---------- */

  function attachTools() {
    if (tools || destroyed) return;
    const r = ensureCanvas();
    tools = createTools({
      el: layerEl,
      toPage(cx, cy) {
        const rect = layerEl.getBoundingClientRect();
        const k = rect.width > 0 ? rect.width / m.size.w : 1;
        return { x: (cx - rect.left) / k, y: (cy - rect.top) / k };
      },
      scale,
      scene: () => m.scene,
      commit: (cmd) => (m.loaded ? s.commit(page, cmd) : false),
      renderer: r,
      tool: () => s.tool,
      style: () => ({ color: s.color, size: s.size }),
      selection: () => (s.selection.page === page ? s.selection.ids : []),
      select: (ids) => s.select(page, ids),
      aspectLocked: () => s.aspectLock,
      drawInput: () => setting('drawInput', 'auto'),
      panKey: () => s.spaceDown,
      panBy: (dx, dy) => s.getScroller(pageEl).scrollBy(dx, dy),
      pinchStart: (pts) => s.pinchStart(pts),
      pinchMove: (pts) => s.pinchMove(pts, pageEl),
      pinchEnd: () => s.pinchEnd(),
      editText: (item, at) => openTextEditor(item, at),
      measure: (str, sz) => r.measure(str, sz),
      onGesture() {
        selBar.hidden = true;
        s.emit('gesture', { page });
      },
      onIdle: () => placeSelBar(),
      tapTools: TAP_TOOLS,
      tapTool(t, at) {
        if (!m.loaded) return;
        if (t === 'note') {
          const item = /** @type {import('../scratch/scene.js').NoteItem} */ (makeItem({ type: 'note', x: at.x, y: at.y, text: '', color: NOTE_COLOR }));
          s.openNote(page, item, { isNew: true });
        } else if (t === 'voice') void s.recordVoice(page, at);
      },
      onErase(x, y, rad) {
        if (eraseDepth < 0) eraseDepth = s.undoStack.length;
        for (const hl of m.highlights) if (!erasingHl.has(hl.id) && circleHitsHighlight(hl, x, y, rad, m.size)) erasingHl.add(hl.id);
        if (erasingHl.size) syncMarks();
      },
      onEraseEnd(keep) {
        const since = eraseDepth;
        eraseDepth = -1;
        if (!erasingHl.size) return;
        const gone = new Set(erasingHl);
        erasingHl.clear();
        if (!keep) return syncMarks();
        // One undo step with the strokes erased in the same gesture.
        s.commitHighlights(page, m.highlights.filter((hl) => !gone.has(hl.id)), { mergeSince: since });
      },
    });
  }

  /** Undo depth when the running eraser gesture started (-1 = none). */
  let eraseDepth = -1;

  function detachTools() {
    tools?.destroy();
    tools = null;
    renderer?.setLive({});
    renderer?.setHidden([]);
  }

  /** Read mode / edit mode / tool changes. */
  function syncMode() {
    const edit = s.editing;
    layerEl.dataset.edit = String(edit);
    layerEl.dataset.tool = s.tool;
    pageEl.classList.toggle('bk-editing', edit);
    const wantTools = edit && s.tool !== 'texthl';
    if (!edit) commitTextEditor();
    if (wantTools) attachTools();
    else detachTools();
    if (needsCanvas()) ensureCanvas();
    else releaseCanvas();
    for (const el of pinEls.values()) el.classList.toggle('is-editing', edit);
    refreshSelection();
  }

  /* ---------- sizing ---------- */

  function resize() {
    const r = pageEl.getBoundingClientRect();
    const w = Math.round(r.width);
    const ht = Math.round(r.height);
    if (!w || !ht || (w === cssW && ht === cssH)) return;
    cssW = w;
    cssH = ht;
    if (renderer) {
      renderer.resize(cssW, cssH);
      renderer.setView({ scale: scale(), x: 0, y: 0 });
    }
    tools?.refresh();
    placeSelBar();
    if (editor) placeTextEditor();
  }
  const ro = new ResizeObserver(() => resize());

  /* ---------- scene → layer ---------- */

  function sync() {
    if (destroyed) return;
    if (needsCanvas()) ensureCanvas();
    else if (!s.editing) releaseCanvas();
    renderer?.setScene(m.scene);
    tools?.refresh();
    syncPins();
    syncMarks();
    placeSelBar();
  }

  function refreshSelection() {
    tools?.refresh();
    if (!tools && renderer) renderer.setLive({});
    placeSelBar();
    for (const [id, el] of pinEls) el.classList.toggle('is-selected', s.selection.page === page && s.selection.ids.includes(id));
  }

  /* ---------- marks: text highlights ---------- */

  function syncMarks() {
    const nodes = [];
    for (const hl of m.highlights) {
      const c = TEXT_HL_COLORS.find((x) => x.name === hl.color) || TEXT_HL_COLORS[0];
      for (const [x, y, w, ht] of hl.rects) {
        nodes.push(
          h('div', {
            class: ['bk-thl', erasingHl.has(hl.id) && 'is-erasing'],
            dataset: { hl: hl.id },
            style: { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${ht * 100}%`, '--thl': c.hex },
          }),
        );
      }
    }
    marks.replaceChildren(...nodes);
  }

  /* ---------- pins ---------- */

  /**
   * @param {import('../scratch/scene.js').NoteItem | import('../scratch/scene.js').AudioItem} it
   */
  function pinLabel(it) {
    if (it.type === 'note') {
      const t = it.text.replace(/\s+/g, ' ').trim();
      return `Note: ${t.length > 60 ? `${t.slice(0, 60)}…` : t || 'empty'}. Tap to open.`;
    }
    return `Voice note, ${formatDuration(it.durationMs)}. Tap to play, long-press to delete.`;
  }

  function syncPins() {
    const live = new Set();
    for (const it of m.scene.items) {
      if (it.type !== 'note' && it.type !== 'audio') continue;
      live.add(it.id);
      let el = pinEls.get(it.id);
      if (!el || el.dataset.type !== it.type) {
        el?.remove();
        el = makePin(it);
        pinEls.set(it.id, el);
        pins.append(el);
      }
      el.style.left = `${(it.x / m.size.w) * 100}%`;
      el.style.top = `${(it.y / m.size.h) * 100}%`;
      el.setAttribute('aria-label', pinLabel(/** @type {any} */ (it)));
      if (it.type === 'note') el.style.setProperty('--pin', paintColor(it.color, false));
      else {
        const lbl = el.querySelector('.bk-pin-time');
        if (lbl && !el.classList.contains('is-playing')) lbl.textContent = formatDuration(it.durationMs);
      }
      el.classList.toggle('is-editing', s.editing);
      el.classList.toggle('is-selected', s.selection.page === page && s.selection.ids.includes(it.id));
    }
    for (const [id, el] of pinEls) {
      if (!live.has(id)) {
        el.remove();
        pinEls.delete(id);
      }
    }
  }

  /**
   * @param {any} it A note or audio item.
   * @returns {HTMLElement}
   */
  function makePin(it) {
    const isNote = it.type === 'note';
    const el = h(
      'button',
      {
        type: 'button',
        class: ['bk-pin', isNote ? 'bk-pin-note' : 'bk-pin-audio'],
        dataset: { type: it.type, id: it.id },
      },
      h('span', { class: 'bk-pin-face', 'aria-hidden': 'true' }, isNote ? bookGlyph('sticky', 18) : icon('mic', { size: 16 })),
      isNote ? null : h('span', { class: 'bk-pin-time', 'aria-hidden': 'true' }, formatDuration(it.durationMs)),
    );
    /** @type {null | { id: number, x: number, y: number, moved: boolean, long: boolean, timer: number, start: { x: number, y: number } }} */
    let press = null;

    const current = () => /** @type {any} */ (m.scene.items.find((i) => i.id === it.id));

    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.stopPropagation();
      const item = current();
      if (!item) return;
      press = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        moved: false,
        long: false,
        start: { x: item.x, y: item.y },
        timer: window.setTimeout(() => {
          if (!press || press.moved) return;
          press.long = true;
          try {
            navigator.vibrate?.(12);
          } catch {
            /* ignore */
          }
          s.removeWithUndo(page, it.id, isNote ? 'Note deleted' : 'Voice note deleted');
        }, LONG_PRESS_MS),
      };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id || press.long) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) < 8) return;
      clearTimeout(press.timer);
      if (!s.editing) {
        // Read mode: a drag is a scroll attempt, not a tap.
        press.moved = true;
        return;
      }
      press.moved = true;
      const k = scale();
      const x = Math.min(m.size.w, Math.max(0, press.start.x + dx / k));
      const y = Math.min(m.size.h, Math.max(0, press.start.y + dy / k));
      el.style.left = `${(x / m.size.w) * 100}%`;
      el.style.top = `${(y / m.size.h) * 100}%`;
      el.classList.add('is-dragging');
    });
    const end = (/** @type {PointerEvent} */ e) => {
      if (!press || e.pointerId !== press.id) return;
      const p = press;
      press = null;
      clearTimeout(p.timer);
      el.classList.remove('is-dragging');
      if (p.long || e.type === 'pointercancel') return syncPins();
      const item = current();
      if (!item) return;
      if (p.moved) {
        if (!s.editing) return;
        const k = scale();
        const dx = (e.clientX - p.x) / k;
        const dy = (e.clientY - p.y) / k;
        const x = Math.min(m.size.w, Math.max(0, p.start.x + dx));
        const y = Math.min(m.size.h, Math.max(0, p.start.y + dy));
        if (!s.commit(page, { type: 'update', items: [{ ...item, x, y }] })) syncPins();
        return;
      }
      activate(item);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      // Keyboard activation (pointer taps are handled on pointerup).
      if (e.detail !== 0) return;
      const item = current();
      if (item) activate(item);
    });
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.editing) {
        e.preventDefault();
        s.removeWithUndo(page, it.id, isNote ? 'Note deleted' : 'Voice note deleted');
      }
    });
    return el;
  }

  /** @param {any} item */
  function activate(item) {
    if (item.type === 'note') s.openNote(page, item);
    else void s.player.toggle(page, item);
  }

  /**
   * Shows the playing state on an audio pin.
   * @param {string} id
   * @param {boolean} playing
   * @param {number} t Seconds played.
   */
  function setPlaying(id, playing, t) {
    const el = pinEls.get(id);
    if (!el) return;
    const item = /** @type {any} */ (m.scene.items.find((i) => i.id === id));
    const total = item ? item.durationMs / 1000 : 0;
    el.classList.toggle('is-playing', playing || t > 0);
    el.setAttribute('aria-pressed', String(playing));
    el.style.setProperty('--played', String(total > 0 ? Math.min(1, t / total) : 0));
    el.querySelector('.bk-pin-face')?.replaceChildren(icon(playing ? 'pause' : 'mic', { size: 16 }));
    const lbl = el.querySelector('.bk-pin-time');
    if (lbl) lbl.textContent = playing || t > 0 ? formatDuration(t * 1000) : formatDuration(item?.durationMs || 0);
  }

  /* ---------- selection bar ---------- */

  /**
   * @param {string} glyphName
   * @param {string} label
   * @param {() => void} onClick
   * @param {string} action
   */
  const selButton = (glyphName, label, onClick, action) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'scratch-sel-btn', 'aria-label': label, title: label, dataset: { action }, onClick },
        ['trash', 'copy'].includes(glyphName) ? icon(glyphName, { size: 20 }) : bookGlyph(glyphName, 20),
      )
    );
  const selected = () => (s.selection.page === page ? m.scene.items.filter((i) => s.selection.ids.includes(i.id)) : []);
  const editBtn = selButton('text', 'Edit text', () => {
    const it = selected()[0];
    if (it?.type === 'text') openTextEditor(it, { x: it.x, y: it.y });
  }, 'edit');
  const lockBtn = selButton('lock', 'Keep proportions', () => {
    s.aspectLock = !s.aspectLock;
    syncSelBar();
  }, 'aspect');
  const frontBtn = selButton('front', 'Bring to front', () => s.commit(page, { type: 'order', ids: reorderIds(m.scene.items, s.selection.ids, 'front') }), 'front');
  const backBtn = selButton('back', 'Send to back', () => s.commit(page, { type: 'order', ids: reorderIds(m.scene.items, s.selection.ids, 'back') }), 'back');
  const dupBtn = selButton('copy', 'Duplicate', () => {
    const copies = selected().map((it) => cloneItem(it, m.size.w * 0.02));
    if (s.commit(page, { type: 'add', items: copies })) s.select(page, copies.map((c) => c.id));
  }, 'duplicate');
  const delBtn = selButton('trash', 'Delete', () => s.deleteSelection(), 'delete');
  delBtn.classList.add('is-danger');
  selBar.append(editBtn, lockBtn, frontBtn, backBtn, dupBtn, delBtn);

  function syncSelBar() {
    const items = selected();
    const single = items.length === 1 ? items[0] : null;
    editBtn.hidden = single?.type !== 'text';
    lockBtn.hidden = single?.type !== 'image';
    lockBtn.setAttribute('aria-pressed', String(s.aspectLock));
    lockBtn.replaceChildren(bookGlyph(s.aspectLock ? 'lock' : 'unlock', 20));
    lockBtn.title = s.aspectLock ? 'Proportions locked (tap for free resize)' : 'Free resize (tap to keep proportions)';
  }

  function placeSelBar() {
    const items = selected();
    if (!items.length || !s.editing || tools?.isBusy() || editor || !cssW || !renderer) {
      selBar.hidden = true;
      return;
    }
    syncSelBar();
    const b = unionBounds(items.map((i) => itemBounds(i, { measure: renderer?.measure })));
    if (!b) return;
    const k = scale();
    const f = frameFor(items, k, /** @type {any} */ (renderer?.measure));
    selBar.hidden = false;
    const bw = selBar.offsetWidth || 240;
    const bh = selBar.offsetHeight || 52;
    const rotSpace = f?.kind === 'image' ? 44 : 14;
    let y = b.y * k - bh - rotSpace;
    if (y < 4) y = (b.y + b.h) * k + 14;
    if (y + bh > cssH - 4) y = Math.max(4, Math.min(cssH - bh - 4, b.y * k + 14));
    const x = Math.min(Math.max(4, b.x * k + (b.w * k) / 2 - bw / 2), Math.max(4, cssW - bw - 4));
    selBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /* ---------- text editor ---------- */

  /**
   * @param {import('../scratch/scene.js').TextItem | null} item
   * @param {{ x: number, y: number }} at
   */
  function openTextEditor(item, at) {
    if (!m.loaded) return;
    if (editor) commitTextEditor();
    const fs = textSizeFor(s.size, m.size);
    const isNew = !item;
    const it =
      item ||
      /** @type {import('../scratch/scene.js').TextItem} */ (
        makeItem({
          type: 'text',
          x: Math.max(0, at.x - fs * 0.2),
          y: Math.max(0, at.y - fs * 0.8),
          w: Math.max(fs * 6, Math.min(fs * 16, m.size.w - Math.max(0, at.x) - fs)),
          text: '',
          color: s.color,
          size: fs,
        })
      );
    const ta = /** @type {HTMLTextAreaElement} */ (
      h('textarea', { class: 'scratch-text-editor bk-text-editor', 'aria-label': 'Text box', rows: '1', spellcheck: 'true', placeholder: 'Type here' })
    );
    ta.value = it.text;
    ta.addEventListener('input', () => autosize());
    ta.addEventListener('blur', () => {
      if (editor && editor.ta === ta) commitTextEditor();
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        e.stopPropagation();
        commitTextEditor();
      }
    });
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    editor = { ta, item: it, isNew };
    if (!isNew) renderer?.setHidden([it.id]);
    selBar.hidden = true;
    layerEl.append(ta);
    placeTextEditor();
    autosize();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function autosize() {
    if (!editor) return;
    editor.ta.style.height = 'auto';
    editor.ta.style.height = `${editor.ta.scrollHeight + 2}px`;
  }

  function placeTextEditor() {
    if (!editor) return;
    const { ta, item } = editor;
    const k = scale();
    Object.assign(ta.style, {
      left: `${item.x * k}px`,
      top: `${item.y * k}px`,
      width: `${item.w * k}px`,
      fontSize: `${item.size * k}px`,
      lineHeight: String(TEXT_LINE),
      padding: `${item.size * TEXT_PAD * k}px`,
      color: paintColor(editor.isNew ? s.color : item.color, false),
    });
    autosize();
  }

  function commitTextEditor() {
    const e = editor;
    if (!e) return;
    editor = null;
    const text = e.ta.value.replace(/\s+$/, '');
    e.ta.remove();
    renderer?.setHidden([]);
    if (e.isNew) {
      if (text.trim()) s.commit(page, { type: 'add', items: [{ ...e.item, text, color: s.color }] });
    } else if (!text.trim()) {
      s.commit(page, { type: 'remove', ids: [e.item.id] });
    } else if (text !== e.item.text) {
      s.commit(page, { type: 'update', items: [{ ...e.item, text }] });
    }
    tools?.refresh();
    placeSelBar();
  }

  /* ---------- drop pictures on a page ---------- */

  layerEl.addEventListener('dragover', (e) => {
    if (s.editing && [...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      layerEl.classList.add('is-drop');
    }
  });
  layerEl.addEventListener('dragleave', () => layerEl.classList.remove('is-drop'));
  layerEl.addEventListener('drop', (e) => {
    layerEl.classList.remove('is-drop');
    const files = imageFilesFrom(e);
    if (!files.length) return;
    e.preventDefault();
    void s.addImages(files, { page });
  });

  // A pointer on the page commits a text box being edited.
  layerEl.addEventListener(
    'pointerdown',
    () => {
      if (editor) commitTextEditor();
    },
    { capture: true },
  );

  /* ---------- visibility ---------- */

  /** Fraction of the page visible in the scroller (0–1). */
  function visibleFraction() {
    const r = pageEl.getBoundingClientRect();
    const v = s.getScroller(pageEl).getBoundingClientRect();
    const top = Math.max(r.top, v.top, 0);
    const bottom = Math.min(r.bottom, v.bottom, innerHeight);
    const left = Math.max(r.left, v.left, 0);
    const right = Math.min(r.right, v.right, innerWidth);
    if (bottom <= top || right <= left || r.width <= 0 || r.height <= 0) return 0;
    return ((bottom - top) * (right - left)) / (r.width * r.height);
  }

  /** The visible part of the page in page units. */
  function visibleBox() {
    const r = pageEl.getBoundingClientRect();
    const v = s.getScroller(pageEl).getBoundingClientRect();
    const k = r.width > 0 ? r.width / m.size.w : 1;
    const x0 = Math.max(0, (Math.max(r.left, v.left) - r.left) / k);
    const y0 = Math.max(0, (Math.max(r.top, v.top) - r.top) / k);
    const x1 = Math.min(m.size.w, (Math.min(r.right, v.right) - r.left) / k);
    const y1 = Math.min(m.size.h, (Math.min(r.bottom, v.bottom) - r.top) / k);
    if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: m.size.w, h: m.size.h };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  const layer = {
    page,
    model: m,
    pageEl,
    sync,
    syncMode,
    syncMarks,
    refreshSelection,
    setPlaying,
    visibleFraction,
    visibleBox,
    scale,
    /**
     * @param {string} id
     * @param {ImageBitmap} [bmp]
     */
    primeImage(id, bmp) {
      if (renderer) renderer.primeImage(id, bmp);
      else primed.set(id, { bmp });
    },
    commitEditor: () => commitTextEditor(),
    cancelGesture() {
      tools?.cancel();
    },
    destroy() {
      if (destroyed) return;
      commitTextEditor();
      destroyed = true;
      ro.disconnect();
      detachTools();
      renderer?.destroy();
      renderer = null;
      pageEl.classList.remove('bk-editing');
      marks.remove();
      layerEl.remove();
      if (m.layer === layer) m.layer = null;
    },
  };
  m.layer = layer;
  ro.observe(pageEl);
  resize();
  syncMode();
  sync();
  void m.ready.then(() => {
    if (!destroyed) sync();
  });
  return layer;
}

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */

/**
 * The editing tool bar (docked at the bottom, thumb reach; same look as the
 * scratchpad tool bar): Select, Pen, Marker, Highlight text, Eraser, Shapes,
 * Add (text box, sticky note, image, voice note) · Undo, Redo, colour & size,
 * More (pen input, clear page), Done.
 *
 * @param {ReturnType<typeof createBookAnnotator>} controller
 * @param {{ onDone?: () => void }} [opts]
 * @returns {HTMLElement & { destroy(): void }}
 */
export function createBookToolbar(controller, { onDone } = {}) {
  /** @type {Record<string, HTMLButtonElement>} */
  const toolBtns = {};
  /**
   * @param {string} name
   * @param {string} label
   * @param {string} short
   * @param {() => void} onClick
   * @param {{ pressed?: boolean, expanded?: boolean }} [o]
   */
  const tbButton = (name, label, short, onClick, o = {}) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        {
          type: 'button',
          class: 'scratch-tb-btn',
          'aria-label': label,
          title: label,
          'aria-pressed': o.pressed === undefined ? undefined : String(o.pressed),
          'aria-haspopup': o.expanded === undefined ? undefined : 'true',
          'aria-expanded': o.expanded === undefined ? undefined : String(o.expanded),
          dataset: { tool: name },
          onClick,
        },
        h('span', { class: 'scratch-tb-icon' }, toolIcon(name)),
        h('span', { class: 'scratch-tb-label', 'aria-hidden': 'true' }, short),
      )
    );

  toolBtns.select = tbButton('select', 'Select', 'Select', () => controller.setTool('select'), { pressed: false });
  toolBtns.pen = tbButton('pen', 'Pen', 'Pen', () => controller.setTool('pen'), { pressed: false });
  toolBtns.hl = tbButton('hl', 'Marker (freehand highlighter)', 'Marker', () => controller.setTool('hl'), { pressed: false });
  toolBtns.texthl = tbButton('texthl', 'Highlight text: select text on the page, then pick a colour', 'Highlight', () => controller.setTool('texthl'), { pressed: false });
  toolBtns.eraser = tbButton('eraser', 'Eraser', 'Eraser', () => controller.setTool('eraser'), { pressed: false });
  const shapesBtn = tbButton('shapes', 'Shapes', 'Shapes', () => togglePop('shapes'), { expanded: false });
  shapesBtn.setAttribute('aria-pressed', 'false');
  const addBtn = tbButton('add', 'Add a text box, sticky note, picture or voice note', 'Add', () => togglePop('add'), { expanded: false });
  addBtn.setAttribute('aria-pressed', 'false');

  const undoBtn = iconButton({ icon: 'undo', label: 'Undo', onClick: () => controller.undo() });
  const redoBtn = iconButton({ icon: 'redo', label: 'Redo', onClick: () => controller.redo() });
  undoBtn.classList.add('scratch-act');
  redoBtn.classList.add('scratch-act');
  const styleDot = h('span', { class: 'scratch-style-dot', 'aria-hidden': 'true' });
  const styleBtn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      { type: 'button', class: 'scratch-style', 'aria-label': 'Colour and size', title: 'Colour and size', 'aria-haspopup': 'true', 'aria-expanded': 'false', onClick: () => togglePop('style') },
      styleDot,
    )
  );
  const moreBtn = iconButton({ icon: 'more', label: 'More options', onClick: () => togglePop('more') });
  moreBtn.classList.add('scratch-act');
  moreBtn.setAttribute('aria-haspopup', 'true');
  moreBtn.setAttribute('aria-expanded', 'false');
  const doneBtn = h(
    'button',
    {
      type: 'button',
      class: 'scratch-done',
      onClick: () => {
        controller.setEditing(false);
        onDone?.();
      },
    },
    icon('check', { size: 20 }),
    h('span', null, 'Done'),
  );

  /* popovers */
  const colorBtns = SCRATCH_COLORS.map((c) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'scratch-swatch', 'aria-label': c.name, title: c.name, 'aria-pressed': 'false', dataset: { color: c.hex }, onClick: () => pick(() => controller.setColor(c.hex)) },
        h('span', { class: 'scratch-swatch-dot', 'aria-hidden': 'true' }),
      )
    ),
  );
  const sizeBtns = SCRATCH_SIZES.names.map((name, i) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: `scratch-size scratch-size-${i}`, 'aria-label': name, title: name, 'aria-pressed': 'false', onClick: () => pick(() => controller.setSize(/** @type {0 | 1 | 2} */ (i))) },
        h('span', { class: 'scratch-size-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'scratch-size-label' }, name),
      )
    ),
  );
  const hlBtns = TEXT_HL_COLORS.map((c) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'scratch-swatch', 'aria-label': `Highlight ${c.label.toLowerCase()}`, title: c.label, 'aria-pressed': 'false', dataset: { hl: c.name }, style: { '--swatch': c.hex }, onClick: () => pick(() => controller.setHlColor(c.name)) },
        h('span', { class: 'scratch-swatch-dot', 'aria-hidden': 'true' }),
      )
    ),
  );
  const inkPart = h('div', { class: 'bk-pop-part' }, h('div', { class: 'scratch-pop-title' }, 'Colour'), h('div', { class: 'scratch-swatches' }, colorBtns), h('div', { class: 'scratch-pop-title' }, 'Size'), h('div', { class: 'scratch-sizes' }, sizeBtns));
  const hlPart = h(
    'div',
    { class: 'bk-pop-part' },
    h('div', { class: 'scratch-pop-title' }, 'Highlight colour'),
    h('div', { class: 'scratch-swatches bk-hl-swatches' }, hlBtns),
    h('p', { class: 'scratch-pop-note' }, 'Select text on the page, then tap a colour in the bar that appears.'),
  );
  const stylePop = h('div', { class: 'scratch-pop scratch-pop-style', role: 'group', 'aria-label': 'Colour and size', hidden: true }, inkPart, hlPart);

  /** @type {Record<string, HTMLButtonElement>} */
  const shapeBtns = {};
  for (const sh of SHAPE_TOOLS) {
    shapeBtns[sh] = /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'scratch-pop-item', 'aria-pressed': 'false', dataset: { shape: sh }, onClick: () => pick(() => controller.setTool(sh)) },
        bookGlyph(sh, 22),
        h('span', null, TOOL_LABELS[/** @type {keyof typeof TOOL_LABELS} */ (sh)]),
      )
    );
  }
  const shapesPop = h(
    'div',
    { class: 'scratch-pop scratch-pop-shapes', role: 'group', 'aria-label': 'Shapes', hidden: true },
    h('div', { class: 'scratch-pop-grid' }, Object.values(shapeBtns)),
    h('p', { class: 'scratch-pop-note' }, 'Drag on the page to draw. Hold Shift for straight lines and squares.'),
  );

  /**
   * @param {string} name
   * @param {string} label
   * @param {string} hint
   * @param {() => void} onClick
   */
  const addItem = (name, label, hint, onClick) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'scratch-pop-item bk-add-item', 'aria-pressed': 'false', dataset: { add: name }, onClick: () => pick(onClick) },
        toolIcon(name, 24),
        h('span', { class: 'bk-add-label' }, label),
        h('span', { class: 'bk-add-hint' }, hint),
      )
    );
  const addBtns = {
    text: addItem('text', 'Text box', 'Tap the page', () => controller.setTool('text')),
    note: addItem('note', 'Sticky note', 'Tap the page', () => controller.setTool('note')),
    image: addItem('image', 'Picture', 'Photos, camera, files', () => void controller.addImages()),
    voice: addItem('voice', 'Voice note', 'Tap the page', () => controller.setTool('voice')),
  };
  const addPop = h('div', { class: 'scratch-pop bk-pop-add', role: 'group', 'aria-label': 'Add', hidden: true }, h('div', { class: 'bk-add-grid' }, Object.values(addBtns)));

  const inputSeg = segmented({
    ariaLabel: 'Draw with',
    value: setting('drawInput', 'auto'),
    options: [
      { value: 'auto', label: 'Auto' },
      { value: 'finger', label: 'Finger' },
      { value: 'pen', label: 'Pen only' },
    ],
    onChange: (/** @type {string} */ v) => remember('drawInput', v),
  });
  const clearBtn = h(
    'button',
    { type: 'button', class: ['scratch-pop-action', 'is-danger'], onClick: () => pick(() => controller.clearPage()) },
    icon('trash', { size: 20 }),
    h('span', null, 'Clear this page'),
  );
  const morePop = h(
    'div',
    { class: 'scratch-pop scratch-pop-more', role: 'group', 'aria-label': 'More options', hidden: true },
    h('div', { class: 'scratch-pop-title' }, 'Draw with'),
    inputSeg,
    h('p', { class: 'scratch-pop-note' }, '“Pen only” lets your hand rest on the screen; fingers then scroll. Two fingers always scroll and zoom.'),
    h('div', { class: 'scratch-pop-actions' }, clearBtn),
  );

  const el = /** @type {HTMLElement & { destroy(): void }} */ (
    h(
      'div',
      { class: 'scratch-toolbar bk-toolbar', role: 'toolbar', 'aria-label': 'Annotation tools' },
      h('div', { class: 'scratch-tb-tools', role: 'group', 'aria-label': 'Tools' }, toolBtns.select, toolBtns.pen, toolBtns.hl, toolBtns.texthl, toolBtns.eraser, shapesBtn, addBtn),
      h(
        'div',
        { class: 'scratch-tb-actions' },
        h('div', { class: 'scratch-tb-group' }, undoBtn, redoBtn),
        h('div', { class: 'scratch-tb-group' }, styleBtn, moreBtn),
        h('span', { class: 'scratch-tb-spacer', 'aria-hidden': 'true' }),
        doneBtn,
      ),
      stylePop,
      shapesPop,
      addPop,
      morePop,
    )
  );

  /* popover handling */
  /** @type {null | 'style' | 'shapes' | 'add' | 'more'} */
  let openPop = null;
  const pops = { style: stylePop, shapes: shapesPop, add: addPop, more: morePop };
  const popBtns = { style: styleBtn, shapes: shapesBtn, add: addBtn, more: moreBtn };

  /** @param {'style' | 'shapes' | 'add' | 'more'} name */
  function togglePop(name) {
    if (openPop === name) return closePop(true);
    closePop();
    openPop = name;
    pops[name].hidden = false;
    popBtns[name].setAttribute('aria-expanded', 'true');
    if (name === 'style') {
      const isHl = controller.getTool() === 'texthl';
      inkPart.hidden = isHl;
      hlPart.hidden = !isHl;
    }
    const first = /** @type {HTMLElement | null} */ (pops[name].querySelector('[aria-pressed="true"], [aria-checked="true"], button'));
    first?.focus({ preventScroll: true });
  }

  /** @param {boolean} [restoreFocus] */
  function closePop(restoreFocus = false) {
    if (!openPop) return;
    const name = openPop;
    openPop = null;
    pops[name].hidden = true;
    popBtns[name].setAttribute('aria-expanded', 'false');
    if (restoreFocus) popBtns[name].focus({ preventScroll: true });
  }

  /** @param {() => void} fn */
  function pick(fn) {
    closePop();
    fn();
  }

  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (!openPop) return;
    const t = /** @type {Node} */ (e.target);
    if (pops[openPop].contains(t) || popBtns[openPop].contains(t)) return;
    closePop();
  };
  document.addEventListener('pointerdown', onOutside, true);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openPop) {
      e.preventDefault();
      e.stopPropagation();
      closePop(true);
    }
  });

  /* sync */
  function syncTools() {
    const { tool, color, size, hlColor } = controller.getStyle();
    for (const [t, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(t === tool));
    const isShape = SHAPE_TOOLS.includes(tool);
    shapesBtn.setAttribute('aria-pressed', String(isShape));
    shapesBtn.querySelector('.scratch-tb-icon')?.replaceChildren(bookGlyph(isShape ? tool : 'shapes'));
    for (const [sh, b] of Object.entries(shapeBtns)) b.setAttribute('aria-pressed', String(sh === tool));
    const addTool = ['text', 'note', 'voice'].includes(tool) ? tool : null;
    addBtn.setAttribute('aria-pressed', String(Boolean(addTool)));
    addBtn.querySelector('.scratch-tb-icon')?.replaceChildren(toolIcon(addTool || 'add'));
    const lbl = addBtn.querySelector('.scratch-tb-label');
    if (lbl) lbl.textContent = addTool === 'text' ? 'Text' : addTool === 'note' ? 'Note' : addTool === 'voice' ? 'Voice' : 'Add';
    for (const [n, b] of Object.entries(addBtns)) b.setAttribute('aria-pressed', String(n === tool));
    for (const b of colorBtns) {
      b.setAttribute('aria-pressed', String(b.dataset.color === color));
      b.style.setProperty('--swatch', paintColor(b.dataset.color || '', false));
    }
    sizeBtns.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === size));
      b.style.setProperty('--swatch', paintColor(color, false));
    });
    for (const b of hlBtns) b.setAttribute('aria-pressed', String(b.dataset.hl === hlColor));
    const hlHex = (TEXT_HL_COLORS.find((c) => c.name === hlColor) || TEXT_HL_COLORS[0]).hex;
    styleDot.style.setProperty('--swatch', tool === 'texthl' ? hlHex : paintColor(color, false));
    styleDot.dataset.size = String(size);
    styleDot.dataset.tool = tool === 'texthl' ? 'hl' : tool;
  }

  function syncHistory() {
    undoBtn.disabled = !controller.canUndo();
    redoBtn.disabled = !controller.canRedo();
  }

  const offs = [
    controller.on('tool', () => syncTools()),
    controller.on('style', () => syncTools()),
    controller.on('change', () => syncHistory()),
    controller.on('gesture', () => closePop()),
  ];
  syncTools();
  syncHistory();

  el.destroy = () => {
    for (const off of offs) off();
    document.removeEventListener('pointerdown', onOutside, true);
  };
  return el;
}
