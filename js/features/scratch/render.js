/**
 * Scratchpad canvas renderer (docs/ARCHITECTURE.md §7.16).
 *
 * Two stacked canvases that only cover the viewport (never a 2000 × 3000
 * backing store):
 * - the **scene layer** holds the paper, its template and every committed
 *   item; it is redrawn only when the scene, the view, the paper or the
 *   theme change (coalesced to one paint per animation frame);
 * - the **live layer** holds what moves under the finger: the stroke being
 *   drawn, shape previews, items being dragged, the lasso, the selection
 *   frame with its handles, snap guides and the eraser ring.
 *
 * Pen and highlighter strokes are painted with the ink engine's
 * `renderStrokes` (variable-width outlines from `strokeToPath`, cached
 * `Path2D`s). Images are decoded once into `ImageBitmap`s (cache per media
 * id); a missing image paints a calm placeholder. Colours come from the CSS
 * tokens, so light and dark mode follow the app theme.
 *
 * The page size comes from the scene (`scene.page.w/h`: 2000 × 3000 on the
 * scratchpad, the PDF page size in points on a book page). Paper mode
 * `'none'` paints no paper at all (a transparent layer over a PDF page).
 * Point items (`note`, `audio`) are not painted here: the book layer shows
 * them as buttons.
 *
 * @module features/scratch/render
 */

import { renderStrokes } from '../annotate/ink.js';
import { PAGE_W, PAGE_H, paintColor, sizeScale } from './scene.js';
import { itemBox, wrapText, TEXT_LINE, TEXT_PAD, ARROW_HEAD, ARROW_MIN, boxCorners } from './geometry.js';

/** Most device pixels one layer canvas may have (old phones have tight canvas budgets). */
export const MAX_LAYER_PIXELS = 5_000_000;
/** Template spacing in page units. */
export const GRID_STEP = 50;
/** Ruled-line spacing in page units. */
export const LINE_STEP = 80;

/**
 * @typedef {import('./scene.js').Item} Item
 * @typedef {import('./scene.js').Scene} Scene
 * @typedef {{ scale: number, x: number, y: number }} View
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ outline: Point[], handles: Record<string, Point>, rotate?: { from: Point, to: Point } | null, dashed?: boolean }} SelectionFrame
 * @typedef {{ items?: Item[], stroke?: Item | null, lasso?: Point[] | null, selection?: SelectionFrame | null,
 *   cursor?: { x: number, y: number, r: number } | null, guides?: { x: number | null, y: number | null } | null }} LiveState
 */

/** @returns {boolean} */
function isDark() {
  return globalThis.document?.documentElement?.dataset?.theme === 'dark';
}

/**
 * Reads a CSS custom property (falls back when unset).
 * @param {Element} el
 * @param {string} name
 * @param {string} fallback
 */
function token(el, name, fallback) {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/** Converted ink strokes per item (page fractions, painted colour). */
/** @type {WeakMap<object, { dark: boolean, s: any }>} */
const inkCache = new WeakMap();

/**
 * A scratch stroke item as an ink-engine stroke (fractions of the page).
 * @param {import('./scene.js').StrokeItem} it
 * @param {boolean} dark
 * @param {boolean} live Do not cache (still changing).
 */
function inkStroke(it, dark, live) {
  const hit = !live && inkCache.get(it);
  if (hit && hit.dark === dark) return hit.s;
  const pts = new Array(it.pts.length);
  for (let i = 0; i + 2 < it.pts.length; i += 3) {
    pts[i] = it.pts[i] / PAGE_W;
    pts[i + 1] = it.pts[i + 1] / PAGE_H;
    pts[i + 2] = it.pts[i + 2];
  }
  const s = { tool: it.tool, color: paintColor(it.color, dark), size: it.size / PAGE_W, pts };
  if (!live) inkCache.set(it, { dark, s });
  return s;
}

/**
 * The page size of a scene (2000 × 3000 when missing).
 * @param {Scene | null} scene
 * @returns {{ w: number, h: number }}
 */
function pageOf(scene) {
  const w = Number(scene?.page?.w);
  const h = Number(scene?.page?.h);
  return { w: w > 0 ? w : PAGE_W, h: h > 0 ? h : PAGE_H };
}

/**
 * Creates the renderer.
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.sceneCanvas
 * @param {HTMLCanvasElement} opts.liveCanvas
 * @param {HTMLElement} opts.host Element whose CSS tokens give the colours.
 * @param {(mediaId: string) => Promise<Blob | null>} opts.loadMedia
 * @param {() => boolean} [opts.dark] Paint for dark paper (default: the app theme). A book page is
 *   always light paper, so it passes `() => false`.
 */
export function createRenderer({ sceneCanvas, liveCanvas, host, loadMedia, dark: darkPaper = isDark }) {
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  /** @type {View} */
  let view = { scale: 1, x: 0, y: 0 };
  /** @type {Scene | null} */
  let scene = null;
  /** @type {Set<string>} */
  let hidden = new Set();
  let paper = { mode: 'full', opacity: 1 };
  /** @type {LiveState} */
  let live = {};
  let sceneRaf = 0;
  let liveRaf = 0;
  let destroyed = false;
  /** @type {{ paper: string, ink: string, dot: string, line: string, accent: string, accentSoft: string, surface: string, muted: string, font: string } | null} */
  let colors = null;

  /** @type {Map<string, { state: 'loading' | 'ready' | 'missing', bmp: ImageBitmap | null, promise: Promise<void> }>} */
  const images = new Map();

  const measureCtx = /** @type {CanvasRenderingContext2D | null} */ (
    globalThis.document ? document.createElement('canvas').getContext('2d') : null
  );

  function readColors() {
    colors = {
      paper: token(host, '--surface', '#ffffff'),
      ink: token(host, '--text', '#111827'),
      dot: token(host, '--border-strong', '#b8c0cc'),
      line: token(host, '--border', '#dde2ea'),
      accent: token(host, '--primary', '#a6192e'),
      accentSoft: token(host, '--primary-soft', '#fbe8eb'),
      surface: token(host, '--surface-2', '#edf0f5'),
      muted: token(host, '--text-3', '#586374'),
      font: token(host, '--font-sans', 'system-ui, sans-serif'),
    };
    return colors;
  }

  /**
   * Text width in page units for a font size (canvas measureText).
   * @param {string} s
   * @param {number} size
   * @returns {number}
   */
  function measure(s, size) {
    if (!measureCtx) return s.length * size * 0.52;
    const c = colors || readColors();
    measureCtx.font = `500 ${size}px ${c.font}`;
    return measureCtx.measureText(s).width;
  }

  /* ---------------- images ---------------- */

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  function ensureImage(id) {
    const hit = images.get(id);
    if (hit) return hit.promise;
    const entry = { state: /** @type {'loading' | 'ready' | 'missing'} */ ('loading'), bmp: /** @type {ImageBitmap | null} */ (null), promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        const blob = await loadMedia(id);
        if (!blob) throw new Error('missing');
        entry.bmp = await createImageBitmap(blob);
        entry.state = 'ready';
      } catch {
        entry.state = 'missing';
      }
      if (!destroyed) invalidate();
    })();
    images.set(id, entry);
    return entry.promise;
  }

  /* ---------------- drawing primitives ---------------- */

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} k Device px per unit.
   * @param {number} px Pan x.
   * @param {number} py Pan y.
   */
  const setT = (ctx, k, px, py) => ctx.setTransform(k, 0, 0, k, -px * k, -py * k);

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./scene.js').ImageItem} it
   * @param {number} k
   */
  function drawImageItem(ctx, it, k) {
    const entry = images.get(it.media) || (ensureImage(it.media), images.get(it.media));
    const c = colors || readColors();
    ctx.save();
    ctx.translate(it.x + it.w / 2, it.y + it.h / 2);
    if (it.rot) ctx.rotate(it.rot);
    const x = -it.w / 2;
    const y = -it.h / 2;
    if (entry?.state === 'ready' && entry.bmp) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(entry.bmp, x, y, it.w, it.h);
    } else {
      // Placeholder: loading (soft box) or missing (box + glyph + note).
      ctx.fillStyle = c.surface;
      ctx.strokeStyle = c.dot;
      ctx.lineWidth = 1.5 / k;
      ctx.setLineDash(entry?.state === 'missing' ? [6 / k, 5 / k] : []);
      ctx.beginPath();
      ctx.rect(x, y, it.w, it.h);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      if (entry?.state === 'missing') {
        const s = Math.min(it.w, it.h) * 0.22;
        ctx.strokeStyle = c.muted;
        ctx.lineWidth = Math.max(1.5 / k, s * 0.08);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.rect(-s, -s * 0.75, 2 * s, 1.5 * s);
        ctx.moveTo(-s, s * 0.45);
        ctx.lineTo(-s * 0.3, -s * 0.15);
        ctx.lineTo(s * 0.2, s * 0.3);
        ctx.lineTo(s * 0.5, 0);
        ctx.lineTo(s, s * 0.45);
        ctx.stroke();
        const fs = Math.max(12 / k, Math.min(it.w / 14, 44));
        if (fs * k >= 9) {
          ctx.fillStyle = c.muted;
          ctx.font = `600 ${fs}px ${c.font}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText('Image not available', 0, s * 0.95, it.w * 0.9);
          ctx.textAlign = 'start';
        }
      }
    }
    ctx.restore();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./scene.js').TextItem} it
   * @param {boolean} dark
   */
  function drawTextItem(ctx, it, dark) {
    const c = colors || readColors();
    const pad = it.size * TEXT_PAD;
    const lines = wrapText(it.text, it.w - 2 * pad, it.size, measure);
    ctx.fillStyle = paintColor(it.color, dark);
    ctx.font = `500 ${it.size}px ${c.font}`;
    ctx.textBaseline = 'middle';
    const lh = it.size * TEXT_LINE;
    lines.forEach((line, i) => {
      if (line) ctx.fillText(line, it.x + pad, it.y + pad + lh * i + lh / 2);
    });
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {import('./scene.js').ShapeItem} it
   * @param {boolean} dark
   */
  function drawShapeItem(ctx, it, dark) {
    const col = paintColor(it.color, dark);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = it.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (it.shape === 'line' || it.shape === 'arrow') {
      let { x2, y2 } = it;
      const len = Math.hypot(x2 - it.x1, y2 - it.y1);
      const head = Math.min(Math.max(ARROW_MIN * sizeScale(scene?.page), it.size * ARROW_HEAD), len * 0.6);
      const a = Math.atan2(y2 - it.y1, x2 - it.x1);
      if (it.shape === 'arrow' && len > 0) {
        // Stop the shaft inside the head so the tip stays sharp.
        x2 -= Math.cos(a) * head * 0.6;
        y2 -= Math.sin(a) * head * 0.6;
      }
      ctx.moveTo(it.x1, it.y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (it.shape === 'arrow' && len > 0) {
        const spread = Math.PI / 7;
        ctx.beginPath();
        ctx.moveTo(it.x2, it.y2);
        ctx.lineTo(it.x2 - Math.cos(a - spread) * head, it.y2 - Math.sin(a - spread) * head);
        ctx.lineTo(it.x2 - Math.cos(a + spread) * head, it.y2 - Math.sin(a + spread) * head);
        ctx.closePath();
        ctx.fill();
      }
      return;
    }
    const b = itemBox(it);
    if (it.shape === 'rect') ctx.rect(b.x, b.y, b.w, b.h);
    else ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(0.5, b.w / 2), Math.max(0.5, b.h / 2), 0, 0, Math.PI * 2);
    if (it.fill) {
      ctx.globalAlpha = 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.stroke();
  }

  /**
   * Draws items in z-order; consecutive strokes go through the ink renderer
   * in one batch (highlighter under pen within the batch).
   * @param {CanvasRenderingContext2D} ctx
   * @param {Item[]} items
   * @param {{ k: number, px: number, py: number, dark: boolean, live?: boolean, d: number, zoom: number }} t
   */
  function drawItems(ctx, items, t) {
    /** @type {any[]} */
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      renderStrokes(ctx, batch, PAGE_W, PAGE_H, t.d, {
        clear: false,
        dark: false,
        zoom: t.zoom,
        panX: t.px,
        panY: t.py,
        hlBlend: t.dark ? 'source-over' : 'multiply',
        live: Boolean(t.live),
      });
      batch = [];
    };
    for (const it of items) {
      if (it.type === 'stroke') {
        batch.push(inkStroke(it, t.dark, Boolean(t.live)));
        continue;
      }
      flush();
      setT(ctx, t.k, t.px, t.py);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      if (it.type === 'image') drawImageItem(ctx, it, t.k);
      else if (it.type === 'text') drawTextItem(ctx, it, t.dark);
      else if (it.type === 'shape') drawShapeItem(ctx, it, t.dark);
    }
    flush();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * Paper + template for the page rectangle.
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} bg
   * @param {{ k: number, px: number, py: number, scale: number }} t
   * @param {{ mode: string, opacity: number }} p
   * @param {{ x0: number, y0: number, x1: number, y1: number }} vis Visible page area.
   * @param {{ w: number, h: number }} pg Page size.
   */
  function drawPaper(ctx, bg, t, p, vis, pg) {
    if (p.mode === 'none') return;
    const PAGE_W = pg.w;
    const PAGE_H = pg.h;
    const c = colors || readColors();
    setT(ctx, t.k, t.px, t.py);
    const over = p.mode === 'over';
    const alpha = over ? p.opacity : 1;
    if (!over) {
      // Soft edge under the sheet, then the paper and a hairline border.
      const px1 = 1 / t.scale;
      ctx.fillStyle = c.dot;
      for (const [a, d] of [[0.18, 6], [0.28, 2.5]]) {
        ctx.globalAlpha = a;
        ctx.fillRect(-d * 0.3 * px1, d * px1 * 0.4, PAGE_W + d * 0.6 * px1, PAGE_H + d * 0.6 * px1);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.paper;
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.strokeStyle = c.line;
      ctx.lineWidth = px1;
      ctx.strokeRect(0, 0, PAGE_W, PAGE_H);
    } else if (alpha > 0) {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = c.paper;
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.globalAlpha = 1;
    }
    const tplAlpha = over ? Math.min(1, alpha * 1.4) : 1;
    if (bg !== 'plain' && tplAlpha > 0.05) {
      ctx.globalAlpha = tplAlpha;
      const x0 = Math.max(0, vis.x0);
      const y0 = Math.max(0, vis.y0);
      const x1 = Math.min(PAGE_W, vis.x1);
      const y1 = Math.min(PAGE_H, vis.y1);
      const px = 1 / t.scale; // one CSS px in units
      if (bg === 'dots' && GRID_STEP * t.scale >= 7) {
        ctx.fillStyle = c.dot;
        const r = Math.max(1.1 * px, 2.2);
        for (let y = Math.ceil(y0 / GRID_STEP) * GRID_STEP; y <= y1; y += GRID_STEP) {
          for (let x = Math.ceil(x0 / GRID_STEP) * GRID_STEP; x <= x1; x += GRID_STEP) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
        }
      } else if (bg === 'grid' && GRID_STEP * t.scale >= 6) {
        ctx.strokeStyle = c.line;
        ctx.lineWidth = px;
        ctx.beginPath();
        for (let x = Math.ceil(x0 / GRID_STEP) * GRID_STEP; x <= x1; x += GRID_STEP) {
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
        }
        for (let y = Math.ceil(y0 / GRID_STEP) * GRID_STEP; y <= y1; y += GRID_STEP) {
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
        }
        ctx.stroke();
      } else if (bg === 'lines' && LINE_STEP * t.scale >= 6) {
        ctx.strokeStyle = c.dot;
        ctx.lineWidth = px;
        ctx.beginPath();
        for (let y = Math.ceil(Math.max(y0, LINE_STEP * 2) / LINE_STEP) * LINE_STEP; y <= y1; y += LINE_STEP) {
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
        }
        ctx.stroke();
        // Margin line.
        ctx.strokeStyle = c.accent;
        ctx.globalAlpha = tplAlpha * 0.35;
        ctx.beginPath();
        ctx.moveTo(160, y0);
        ctx.lineTo(160, y1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (over) {
      // A quiet page outline so the drawable area is always clear.
      ctx.strokeStyle = c.dot;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.25 / t.scale;
      ctx.setLineDash([6 / t.scale, 6 / t.scale]);
      ctx.strokeRect(0, 0, PAGE_W, PAGE_H);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* ---------------- layers ---------------- */

  function transform() {
    const k = view.scale * dpr;
    return { k, px: view.x, py: view.y, scale: view.scale, d: dpr, zoom: view.scale, dark: darkPaper() };
  }

  function paintScene() {
    sceneRaf = 0;
    const ctx = sceneCanvas.getContext('2d');
    if (!ctx || !cssW || !cssH) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, sceneCanvas.width, sceneCanvas.height);
    if (!scene) return;
    readColors();
    const t = transform();
    const vis = { x0: view.x, y0: view.y, x1: view.x + cssW / view.scale, y1: view.y + cssH / view.scale };
    drawPaper(ctx, scene.page.bg, t, paper, vis, pageOf(scene));
    // Cull items far outside the view (cheap box test on stored coordinates).
    const items = hidden.size ? scene.items.filter((it) => !hidden.has(it.id)) : scene.items;
    drawItems(ctx, items, t);
  }

  function paintLive() {
    liveRaf = 0;
    const ctx = liveCanvas.getContext('2d');
    if (!ctx || !cssW || !cssH) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    const t = transform();
    const c = colors || readColors();
    if (live.items?.length) drawItems(ctx, live.items, t);
    if (live.stroke) drawItems(ctx, [live.stroke], { ...t, live: true });
    setT(ctx, t.k, t.px, t.py);
    const px = 1 / view.scale;
    const { w: PAGE_W, h: PAGE_H } = pageOf(scene);
    if (live.guides && (live.guides.x !== null || live.guides.y !== null)) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = px;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath();
      if (live.guides.x !== null) {
        ctx.moveTo(live.guides.x, 0);
        ctx.lineTo(live.guides.x, PAGE_H);
      }
      if (live.guides.y !== null) {
        ctx.moveTo(0, live.guides.y);
        ctx.lineTo(PAGE_W, live.guides.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (live.lasso && live.lasso.length > 1) {
      ctx.beginPath();
      ctx.moveTo(live.lasso[0].x, live.lasso[0].y);
      for (const p of live.lasso) ctx.lineTo(p.x, p.y);
      ctx.closePath();
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = c.accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.5 * px;
      ctx.setLineDash([6 * px, 5 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const sel = live.selection;
    if (sel) {
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.5 * px;
      if (sel.dashed) ctx.setLineDash([6 * px, 4 * px]);
      if (sel.outline.length > 1) {
        ctx.beginPath();
        ctx.moveTo(sel.outline[0].x, sel.outline[0].y);
        for (const p of sel.outline.slice(1)) ctx.lineTo(p.x, p.y);
        if (sel.outline.length > 2) ctx.closePath();
        ctx.stroke();
      }
      ctx.setLineDash([]);
      if (sel.rotate) {
        ctx.beginPath();
        ctx.moveTo(sel.rotate.from.x, sel.rotate.from.y);
        ctx.lineTo(sel.rotate.to.x, sel.rotate.to.y);
        ctx.stroke();
      }
      const r = 7 * px;
      for (const [name, p] of Object.entries(sel.handles || {})) {
        ctx.beginPath();
        if (name === 'rotate') {
          ctx.arc(p.x, p.y, r * 1.35, 0, Math.PI * 2);
          ctx.fillStyle = c.accent;
          ctx.fill();
          // Curved-arrow glyph.
          ctx.strokeStyle = c.paper;
          ctx.lineWidth = 1.6 * px;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 0.65, -Math.PI * 0.9, Math.PI * 0.45);
          ctx.stroke();
          ctx.strokeStyle = c.accent;
          ctx.lineWidth = 1.5 * px;
          continue;
        }
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = c.paper;
        ctx.fill();
        ctx.lineWidth = 2 * px;
        ctx.stroke();
        ctx.lineWidth = 1.5 * px;
      }
    }
    if (live.cursor) {
      ctx.beginPath();
      ctx.arc(live.cursor.x, live.cursor.y, live.cursor.r, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = c.muted;
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Schedules a scene-layer repaint (once per frame). */
  function invalidate() {
    if (sceneRaf || destroyed) return;
    sceneRaf = requestAnimationFrame(paintScene);
  }

  function invalidateLive() {
    if (liveRaf || destroyed) return;
    liveRaf = requestAnimationFrame(paintLive);
  }

  return {
    measure,

    /**
     * Sizes both canvases to the viewport (CSS px), DPR-aware and capped.
     * @param {number} w
     * @param {number} hgt
     */
    resize(w, hgt) {
      cssW = Math.max(0, Math.round(w));
      cssH = Math.max(0, Math.round(hgt));
      const d = Math.min(3, Number(globalThis.devicePixelRatio) || 1);
      const area = cssW * cssH * d * d;
      dpr = area > MAX_LAYER_PIXELS ? Math.max(1, Math.sqrt(MAX_LAYER_PIXELS / Math.max(1, cssW * cssH))) : d;
      for (const c of [sceneCanvas, liveCanvas]) {
        const bw = Math.max(1, Math.round(cssW * dpr));
        const bh = Math.max(1, Math.round(cssH * dpr));
        if (c.width !== bw) c.width = bw;
        if (c.height !== bh) c.height = bh;
      }
      // Paint at once so a resize never flashes an empty canvas.
      if (sceneRaf) cancelAnimationFrame(sceneRaf);
      if (liveRaf) cancelAnimationFrame(liveRaf);
      paintScene();
      paintLive();
    },

    /** @param {View} v */
    setView(v) {
      view = { ...v };
      invalidate();
      invalidateLive();
    },

    /** @param {Scene} s */
    setScene(s) {
      if (s === scene) return;
      scene = s;
      for (const it of s.items) if (it.type === 'image' && !images.has(it.media)) void ensureImage(it.media);
      invalidate();
    },

    /**
     * Items not painted on the scene layer (being dragged on the live layer).
     * @param {Iterable<string>} ids
     */
    setHidden(ids) {
      const next = new Set(ids);
      if (next.size === hidden.size && [...next].every((id) => hidden.has(id))) return;
      hidden = next;
      invalidate();
    },

    /** @param {{ mode: string, opacity: number }} p */
    setPaper(p) {
      paper = { mode: p.mode, opacity: Math.max(0, Math.min(1, Number(p.opacity) || 0)) };
      invalidate();
    },

    /** @param {LiveState} state */
    setLive(state) {
      live = state || {};
      invalidateLive();
    },

    /** Repaint everything (theme change). */
    refresh() {
      readColors();
      invalidate();
      invalidateLive();
    },

    invalidate,

    /**
     * Starts decoding an image ahead (e.g. right after an import).
     * @param {string} id
     * @param {ImageBitmap} [bmp] Already decoded bitmap to cache.
     */
    primeImage(id, bmp) {
      if (bmp) {
        images.set(id, { state: 'ready', bmp, promise: Promise.resolve() });
        invalidate();
      } else void ensureImage(id);
    },

    /** @param {string} id @returns {'loading' | 'ready' | 'missing' | null} */
    imageState(id) {
      return images.get(id)?.state ?? null;
    },

    /**
     * Renders the whole page to a new canvas (Export as PNG): opaque paper,
     * template, every item. Waits for images first.
     * @param {{ width?: number }} [opts] Output width in px (height keeps the page ratio).
     * @returns {Promise<HTMLCanvasElement>}
     */
    async renderPage({ width = 1400 } = {}) {
      if (!scene) throw new Error('No scene');
      await Promise.all(scene.items.filter((i) => i.type === 'image').map((i) => ensureImage(/** @type {any} */ (i).media)));
      readColors();
      const pg = pageOf(scene);
      const scale = width / pg.w;
      const out = document.createElement('canvas');
      out.width = Math.round(pg.w * scale);
      out.height = Math.round(pg.h * scale);
      const ctx = out.getContext('2d');
      if (!ctx) throw new Error('No 2D context');
      const t = { k: scale, px: 0, py: 0, scale, d: 1, zoom: scale, dark: darkPaper() };
      drawPaper(ctx, scene.page.bg, t, { mode: 'full', opacity: 1 }, { x0: 0, y0: 0, x1: pg.w, y1: pg.h }, pg);
      drawItems(ctx, scene.items, t);
      return out;
    },

    /** Frees bitmaps and stops painting. */
    destroy() {
      destroyed = true;
      if (sceneRaf) cancelAnimationFrame(sceneRaf);
      if (liveRaf) cancelAnimationFrame(liveRaf);
      for (const e of images.values()) e.bmp?.close?.();
      images.clear();
    },
  };
}

/**
 * The selection frame for a set of items (outline, handles, rotate stem) in
 * page units; `handlePx` and `rotatePx` are CSS px converted with `scale`.
 * @param {{ box: { x: number, y: number, w: number, h: number }, rot: number, handles: Record<string, { x: number, y: number }>,
 *   line?: boolean }} frame
 * @returns {SelectionFrame}
 */
export function selectionFrame(frame) {
  const outline = frame.line ? Object.values(frame.handles) : boxCorners(frame.box, frame.rot);
  const handles = { ...frame.handles };
  const rotateTo = handles.rotate;
  let rotate = null;
  if (rotateTo) {
    const top = boxCorners(frame.box, frame.rot);
    rotate = { from: { x: (top[0].x + top[1].x) / 2, y: (top[0].y + top[1].y) / 2 }, to: rotateTo };
  }
  return { outline, handles, rotate, dashed: false };
}
