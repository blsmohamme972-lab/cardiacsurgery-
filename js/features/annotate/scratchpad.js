/**
 * Scratchpad (docs/ARCHITECTURE.md §7.7 "annotate/scratchpad.js"): a
 * full-screen sheet with a big drawing page per question (logical size
 * 2000 × 3000), saved as ink block `"scratch"`.
 *
 * - Same engine, tools and toolbar as the per-block ink layers.
 * - Zoom 0.5–4×: two-finger pinch, Ctrl/⌘ + wheel or trackpad pinch, and the
 *   visible zoom out / zoom level (tap = reset) / zoom in buttons, so
 *   gestures are never the only way. Pan: two fingers, the wheel, or one
 *   finger when touch is set to scroll (pen-only drawing).
 * - The canvas only covers the screen (never a 2000 × 3000 backing store):
 *   strokes are rendered through the current zoom/pan transform.
 * - The view (zoom + position) is remembered per question for this session.
 *
 * @module features/annotate/scratchpad
 */

import { h } from '../../core/dom.js';
import { icon } from '../../ui/icons.js';
import { sheet, iconButton, toast } from '../../ui/components.js';
import { createInkEngine, renderStrokes, drawEraserCursor, SCRATCH_BLOCK } from './ink.js';
import { createInkToolbar } from './ink-toolbar.js';

/** Logical page size. */
export const SCRATCH_WIDTH = 2000;
export const SCRATCH_HEIGHT = 3000;
/** Zoom bounds. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
/** Zoom step of the buttons. */
const ZOOM_STEP = 1.25;
/** Grid spacing in page units. */
const GRID = 50;
/** `inkSize` is a fraction of this many page units. */
const REF_WIDTH = 500;

/** Last view per question id (this session only). */
/** @type {Map<string, { zoom: number, x: number, y: number }>} */
const views = new Map();

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Clamps a pan offset so the page stays in view (centred when smaller than the viewport).
 * Pure.
 * @param {number} pan Logical coordinate at the viewport's edge.
 * @param {number} viewport Viewport size in CSS px.
 * @param {number} zoom
 * @param {number} page Page size in logical units.
 * @returns {number}
 */
export function clampPan(pan, viewport, zoom, page) {
  const visible = viewport / zoom;
  if (visible >= page) return -(visible - page) / 2;
  return clamp(pan, 0, page - visible);
}

/**
 * Zooms around an anchor point so the page point under it stays put. Pure.
 * @param {{ zoom: number, x: number, y: number }} view
 * @param {number} nextZoom
 * @param {number} ax Anchor, CSS px from the viewport's left.
 * @param {number} ay Anchor, CSS px from the viewport's top.
 * @returns {{ zoom: number, x: number, y: number }}
 */
export function zoomAround(view, nextZoom, ax, ay) {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const px = view.x + ax / view.zoom;
  const py = view.y + ay / view.zoom;
  return { zoom, x: px - ax / zoom, y: py - ay / zoom };
}

/**
 * @param {string} name
 * @param {Element} el
 * @param {string} fallback
 */
function cssVar(name, el, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Opens the scratchpad for a question.
 *
 * @param {{ id: string, version?: number }} question
 * @returns {{ close: () => Promise<void>, controller: import('./ink.js').InkController }}
 */
export function openScratchpad(question) {
  const qid = question?.id;
  if (typeof qid !== 'string' || !qid) throw new TypeError('openScratchpad: question with an id required');

  const engine = createInkEngine({
    qid,
    qversion: question.version ?? 1,
    include: (b) => b === SCRATCH_BLOCK,
  });

  const canvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'scratch-canvas', 'aria-hidden': 'true' }));
  const viewport = h(
    'div',
    {
      class: 'scratch-viewport',
      role: 'img',
      'aria-label': 'Scratchpad drawing area. Draw with a finger, stylus or mouse.',
      'data-no-drag': '',
    },
    canvas,
  );

  /* ---------- view state ---------- */

  let vw = 0;
  let vh = 0;
  let dpr = 1;
  const saved = views.get(qid);
  let view = saved ? { ...saved } : { zoom: 1, x: 0, y: 0 };
  /** @type {HTMLCanvasElement | null} */
  let live = null;
  /** @type {import('./ink.js').Stroke[]} */
  let strokes = [];
  let dark = false;
  /** @type {DOMRect | null} */
  let rectCache = null;
  let renderRaf = 0;

  const zoomLabel = h('span', { class: 'scratch-zoom-value' }, '100%');
  const resetBtn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        type: 'button',
        class: 'scratch-zoom-reset',
        'aria-label': 'Reset zoom (100%)',
        title: 'Reset zoom',
        onClick: () => setView({ zoom: 1, x: 0, y: 0 }),
      },
      zoomLabel,
    )
  );
  const zoomOutBtn = iconButton({
    icon: 'zoom-out',
    label: 'Zoom out',
    variant: 'secondary',
    onClick: () => zoomBy(1 / ZOOM_STEP),
  });
  const zoomInBtn = iconButton({
    icon: 'zoom-in',
    label: 'Zoom in',
    variant: 'secondary',
    onClick: () => zoomBy(ZOOM_STEP),
  });
  const zoomBar = h(
    'div',
    { class: 'scratch-zoom', role: 'group', 'aria-label': 'Zoom' },
    zoomOutBtn,
    resetBtn,
    zoomInBtn,
  );

  /** @param {{ zoom: number, x: number, y: number }} next */
  function normalize(next) {
    const zoom = clamp(next.zoom, MIN_ZOOM, MAX_ZOOM);
    return {
      zoom,
      x: vw ? clampPan(next.x, vw, zoom, SCRATCH_WIDTH) : next.x,
      y: vh ? clampPan(next.y, vh, zoom, SCRATCH_HEIGHT) : next.y,
    };
  }

  /** @param {{ zoom: number, x: number, y: number }} next */
  function setView(next) {
    view = normalize(next);
    views.set(qid, view);
    const pct = Math.round(view.zoom * 100);
    zoomLabel.textContent = `${pct}%`;
    resetBtn.setAttribute('aria-label', `Zoom ${pct}%. Reset to 100%`);
    zoomOutBtn.disabled = view.zoom <= MIN_ZOOM + 1e-6;
    zoomInBtn.disabled = view.zoom >= MAX_ZOOM - 1e-6;
    scheduleRender();
  }

  /** @param {number} factor */
  function zoomBy(factor) {
    setView(zoomAround(view, view.zoom * factor, vw / 2, vh / 2));
  }

  function scheduleRender() {
    if (renderRaf) return;
    renderRaf = requestAnimationFrame(() => {
      renderRaf = 0;
      paint();
    });
  }

  /** Background, page, grid, then strokes. */
  function paint() {
    const ctx = canvas.getContext('2d');
    if (!ctx || !vw || !vh) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const k = dpr * view.zoom;
    ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
    ctx.fillStyle = cssVar('--surface', viewport, dark ? '#171a20' : '#ffffff');
    ctx.fillRect(0, 0, SCRATCH_WIDTH, SCRATCH_HEIGHT);
    // Dot grid (only when the dots are far enough apart to read as a grid).
    if (GRID * view.zoom >= 14) {
      ctx.fillStyle = cssVar('--border-strong', viewport, '#c7ccd5');
      const x0 = Math.max(0, Math.floor(view.x / GRID) * GRID);
      const y0 = Math.max(0, Math.floor(view.y / GRID) * GRID);
      const x1 = Math.min(SCRATCH_WIDTH, view.x + vw / view.zoom);
      const y1 = Math.min(SCRATCH_HEIGHT, view.y + vh / view.zoom);
      const r = 1.6 / view.zoom;
      for (let y = y0; y <= y1; y += GRID) {
        for (let x = x0; x <= x1; x += GRID) ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
    }
    renderStrokes(ctx, strokes, SCRATCH_WIDTH, SCRATCH_HEIGHT, dpr, {
      clear: false,
      dark,
      zoom: view.zoom,
      panX: view.x,
      panY: view.y,
      hlBlend: dark ? 'source-over' : 'multiply',
    });
  }

  function resize() {
    const r = viewport.getBoundingClientRect();
    const nw = Math.round(r.width);
    const nh = Math.round(r.height);
    const nd = Math.min(3, globalThis.devicePixelRatio || 1);
    if (nw === vw && nh === vh && nd === dpr) return;
    vw = nw;
    vh = nh;
    dpr = nd;
    for (const c of [canvas, live]) {
      if (!c) continue;
      c.width = Math.max(1, Math.round(vw * dpr));
      c.height = Math.max(1, Math.round(vh * dpr));
    }
    setView(view);
    paint();
  }

  /* ---------- gestures (pinch / pan) ---------- */

  /** @type {null | { view: { zoom: number, x: number, y: number }, mid: { x: number, y: number }, dist: number }} */
  let pinch = null;

  /** @param {{ x: number, y: number }[]} pts */
  function measure(pts) {
    const r = viewport.getBoundingClientRect();
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length - r.left;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length - r.top;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mid: { x: mx, y: my }, dist };
  }

  /* ---------- surface ---------- */

  /** @type {import('./ink.js').Surface} */
  const surface = {
    block: SCRATCH_BLOCK,
    el: viewport,
    handlesGestures: true,
    size: () => ({ w: SCRATCH_WIDTH, h: SCRATCH_HEIGHT }),
    toLocal(cx, cy) {
      const r = rectCache || viewport.getBoundingClientRect();
      return { x: view.x + (cx - r.left) / view.zoom, y: view.y + (cy - r.top) / view.zoom };
    },
    scale: () => view.zoom,
    refWidth: () => REF_WIDTH,
    render(list, isDarkNow) {
      strokes = list;
      dark = isDarkNow;
      scheduleRender();
    },
    beginLive() {
      rectCache = viewport.getBoundingClientRect();
      if (live) return;
      live = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'scratch-live', 'aria-hidden': 'true' }));
      live.width = Math.max(1, Math.round(vw * dpr));
      live.height = Math.max(1, Math.round(vh * dpr));
      viewport.append(live);
    },
    drawLive(stroke, cursor, isDarkNow) {
      const ctx = live?.getContext('2d');
      if (!ctx) return;
      renderStrokes(ctx, stroke ? [stroke] : [], SCRATCH_WIDTH, SCRATCH_HEIGHT, dpr, {
        dark: isDarkNow,
        zoom: view.zoom,
        panX: view.x,
        panY: view.y,
        live: true,
      });
      if (cursor) drawEraserCursor(ctx, cursor, dpr, view.zoom, view.x, view.y, isDarkNow);
    },
    endLive() {
      rectCache = null;
      live?.remove();
      live = null;
    },
    setInteractive(on, _touchAction, tool) {
      viewport.classList.toggle('is-active', on);
      viewport.dataset.tool = tool;
    },
    gestureStart(pts) {
      const m = measure(pts);
      pinch = { view: { ...view }, mid: m.mid, dist: m.dist };
    },
    gestureMove(pts) {
      if (!pinch) return;
      const m = measure(pts);
      const ratio = pinch.dist > 0 && m.dist > 0 ? m.dist / pinch.dist : 1;
      const zoom = clamp(pinch.view.zoom * ratio, MIN_ZOOM, MAX_ZOOM);
      // Keep the page point under the starting midpoint under the current midpoint.
      const px = pinch.view.x + pinch.mid.x / pinch.view.zoom;
      const py = pinch.view.y + pinch.mid.y / pinch.view.zoom;
      setView({ zoom, x: px - m.mid.x / zoom, y: py - m.mid.y / zoom });
    },
    gestureEnd() {
      pinch = null;
    },
    destroy() {
      live?.remove();
    },
  };

  /** Wheel: pan; Ctrl/⌘ + wheel (and trackpad pinch): zoom at the cursor. */
  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh : 1;
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * unit * 0.01);
        setView(zoomAround(view, view.zoom * factor, e.clientX - r.left, e.clientY - r.top));
      } else {
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
        setView({ zoom: view.zoom, x: view.x + dx / view.zoom, y: view.y + dy / view.zoom });
      }
    },
    { passive: false },
  );

  /* ---------- sheet ---------- */

  const toolbar = createInkToolbar(engine, { onDone: () => void handle.close() });
  toolbar.classList.add('ink-toolbar--embedded');

  const content = h(
    'div',
    {
      class: 'scratch',
      onKeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const t = /** @type {HTMLElement} */ (e.target);
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
        else if (e.key === '-') zoomBy(1 / ZOOM_STEP);
        else if (e.key === '0') setView({ zoom: 1, x: 0, y: 0 });
        else return;
        e.preventDefault();
      },
    },
    h('div', { class: 'scratch-stage' }, viewport, zoomBar),
    toolbar,
  );

  const ro = new ResizeObserver(() => resize());
  let closed = false;

  const handle = sheet({
    title: h('span', { class: 'scratch-title' }, icon('note', { size: 20 }), 'Scratchpad'),
    content,
    size: 'full',
    onClose: () => {
      if (closed) return;
      closed = true;
      ro.disconnect();
      if (renderRaf) cancelAnimationFrame(renderRaf);
      engine.destroy().catch((err) => {
        console.error('[scratchpad] save failed', err);
        toast("Your scratchpad couldn't be saved. Free up some storage space and try again.", { kind: 'danger' });
      });
    },
  });
  handle.el.classList.add('scratch-sheet');

  engine.attach(surface);
  engine.enable();
  ro.observe(viewport);
  resize();

  return {
    close: () => handle.close('api'),
    controller: engine,
  };
}
