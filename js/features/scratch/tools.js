/**
 * Scratchpad pointer tools (docs/ARCHITECTURE.md §7.16 "features/scratch/tools.js").
 *
 * One input router on the viewport turns Pointer Events into tool gestures:
 * - **pen / highlighter**: pressure from a stylus (`pointerType === 'pen'`),
 *   simulated from speed for touch and mouse, streamline smoothing;
 * - **eraser**: removes whole strokes and shapes it touches (never images or text);
 * - **shapes** (line, arrow, rectangle, ellipse): drag to draw, Shift to constrain;
 * - **text**: tap to type (the shell opens the editor);
 * - **select**: tap an item, drag to move (snaps to the page centre and
 *   edges), handles to resize (images keep their aspect unless unlocked),
 *   rotate handle for images, drag on empty paper for a lasso;
 *   double-tap a text box to edit it;
 * - **hand**: pan (also Space + drag, the middle mouse button, two fingers,
 *   and one finger when only the pen draws).
 *
 * Palm rejection follows the `drawInput` setting (§7.7): in `auto`, once a pen
 * was seen, fingers pan instead of drawing. Two fingers always pinch-zoom and
 * pan the page, or scale and rotate the selected image when the pinch starts on it.
 *
 * The router never writes to the scene: every finished gesture becomes one
 * command handed to `ctx.commit`, so each is one undo step.
 *
 * Sizes follow the page: {@link SCRATCH_SIZES} are scaled by `sizeScale(page)`
 * (1 on the 2000-unit scratchpad page). Extra "tap tools" (`ctx.tapTools`,
 * e.g. the book's sticky note and voice pin) behave like the text tool: a tap
 * calls `ctx.tapTool(tool, point)`.
 *
 * @module features/scratch/tools
 */

import { simulatePressure, smoothPoint } from '../annotate/ink.js';
import { SCRATCH_SIZES, SHAPES, makeItem, moveItem, sizeScale } from './scene.js';
import {
  itemBox,
  itemBounds,
  unionBounds,
  hitTest,
  hitItem,
  hitHandle,
  handlePoints,
  resizeBox,
  rotationTowards,
  lassoSelect,
  snapBoxToPage,
  constrainShape,
  scaleItems,
  rotatePoint,
  MIN_SIDE,
} from './geometry.js';
import { selectionFrame } from './render.js';

/** Every tool the router knows. */
export const TOOLS = Object.freeze(['select', 'pen', 'hl', 'eraser', 'line', 'arrow', 'rect', 'ellipse', 'text', 'hand']);
/** Selection handle hit radius (CSS px; the visible dot is smaller). */
export const HANDLE_HIT_PX = 22;
/** Rotate handle distance above the box (CSS px). */
export const ROTATE_OFFSET_PX = 30;
/** Eraser radius (CSS px). */
export const ERASER_PX = 12;
/** Snap distance while moving (CSS px). */
export const SNAP_PX = 8;
/** Double-tap window (ms). */
export const DOUBLE_TAP_MS = 380;
/** Hit tolerance for tapping thin strokes (CSS px). */
const TAP_TOL_PX = 10;

/** Once a stylus was seen this app session, fingers pan in 'auto' mode. */
let penSeen = false;

/**
 * @typedef {import('./scene.js').Item} Item
 * @typedef {import('./scene.js').Scene} Scene
 * @typedef {{ x: number, y: number }} Point
 * @typedef {object} ToolContext
 * @property {HTMLElement} el Viewport element receiving pointer events.
 * @property {(cx: number, cy: number) => Point} toPage Client → page units.
 * @property {() => number} scale CSS px per page unit.
 * @property {() => Scene} scene
 * @property {(cmd: import('./scene.js').Command) => boolean} commit
 * @property {ReturnType<typeof import('./render.js').createRenderer>} renderer
 * @property {() => string} tool
 * @property {() => { color: string, size: 0 | 1 | 2 }} style
 * @property {() => string[]} selection
 * @property {(ids: string[]) => void} select
 * @property {() => boolean} aspectLocked
 * @property {() => string} drawInput 'auto' | 'finger' | 'pen'
 * @property {() => boolean} panKey Space held.
 * @property {(dx: number, dy: number) => void} panBy CSS px.
 * @property {(pts: Point[]) => void} pinchStart Client points.
 * @property {(pts: Point[]) => void} pinchMove
 * @property {() => void} pinchEnd
 * @property {(item: import('./scene.js').TextItem | null, at: Point) => void} editText
 * @property {(s: string, size: number) => number} measure
 * @property {() => void} [onGesture] A drawing gesture started (hide hints, close popovers).
 * @property {() => void} [onIdle] A gesture ended (the shell repositions the action bar).
 * @property {readonly string[]} [tapTools] Extra tools that act on a tap (like text).
 * @property {(tool: string, at: Point) => void} [tapTool] Called for a tap with one of `tapTools`.
 * @property {(x: number, y: number, r: number) => void} [onErase] Every eraser sample (page units), so the
 *   owner can erase its own marks (e.g. text highlights) in the same gesture.
 * @property {(keep: boolean) => void} [onEraseEnd] The eraser gesture ended (keep = commit).
 */

/**
 * Selection frame data (box, rotation, handle points) for items.
 * @param {Item[]} items
 * @param {number} scale CSS px per unit.
 * @param {(s: string, size: number) => number} measure
 * @returns {null | { box: { x: number, y: number, w: number, h: number }, rot: number,
 *   handles: Record<string, Point>, line: boolean, kind: 'image' | 'text' | 'line' | 'shape' | 'pin' | 'group' }}
 */
export function frameFor(items, scale, measure) {
  if (!items.length) return null;
  const off = ROTATE_OFFSET_PX / scale;
  if (items.length === 1) {
    const it = items[0];
    if (it.type === 'image') {
      const box = itemBox(it);
      return { box, rot: it.rot, handles: handlePoints(box, it.rot, off), line: false, kind: 'image' };
    }
    if (it.type === 'text') {
      const box = itemBox(it, { measure });
      const hp = handlePoints(box, 0);
      return { box, rot: 0, handles: { w: hp.w, e: hp.e }, line: false, kind: 'text' };
    }
    if (it.type === 'shape' && (it.shape === 'line' || it.shape === 'arrow')) {
      return {
        box: itemBox(it),
        rot: 0,
        handles: { p1: { x: it.x1, y: it.y1 }, p2: { x: it.x2, y: it.y2 } },
        line: true,
        kind: 'line',
      };
    }
    if (it.type === 'shape') {
      const box = itemBox(it);
      return { box, rot: 0, handles: handlePoints(box, 0), line: false, kind: 'shape' };
    }
    if (it.type === 'note' || it.type === 'audio') {
      // Pins are buttons drawn by their owner: no frame handles (drag moves them).
      return { box: itemBox(it), rot: 0, handles: {}, line: false, kind: 'pin' };
    }
  }
  const box = /** @type {any} */ (unionBounds(items.map((i) => itemBounds(i, { measure }))));
  return { box, rot: 0, handles: handlePoints(box, 0), line: false, kind: 'group' };
}

/**
 * Wires the tools to a viewport.
 * @param {ToolContext} ctx
 * @returns {{ refresh(): void, cancel(): void, destroy(): void, isBusy(): boolean }}
 */
export function createTools(ctx) {
  const el = ctx.el;
  /** Touch pointers down: id → client point. @type {Map<number, Point>} */
  const touches = new Map();
  /** @type {null | { kind: string, pointerId: number, pointerType: string, [k: string]: any }} */
  let op = null;
  /** @type {null | { kind: 'view' } | { kind: 'image', item: import('./scene.js').ImageItem, d0: number, a0: number, m0: Point, preview: any }} */
  let pinch = null;
  /** After a pinch, ignore touches until every finger lifts. */
  let touchLock = false;
  let rafLive = 0;
  /** @type {{ id: string, t: number } | null} */
  let lastTap = null;
  let destroyed = false;

  const itemsById = () => new Map(ctx.scene().items.map((i) => [i.id, i]));
  const selectedItems = () => {
    const map = itemsById();
    return ctx.selection().map((id) => map.get(id)).filter(Boolean);
  };

  /** @param {string} tool */
  const isTapTool = (tool) => Array.isArray(ctx.tapTools) && ctx.tapTools.includes(tool);

  function fingersDraw() {
    const mode = ctx.drawInput();
    if (mode === 'finger') return true;
    if (mode === 'pen') return false;
    return !penSeen;
  }

  /* ---------------- live layer ---------------- */

  /** Paints the idle state: the selection frame. */
  function paintIdle() {
    const items = selectedItems();
    const f = frameFor(items, ctx.scale(), ctx.measure);
    ctx.renderer.setHidden([]);
    ctx.renderer.setLive(f ? { selection: { ...selectionFrame(f), dashed: f.kind === 'group' } } : {});
  }

  /** @param {import('./render.js').LiveState} state */
  function paintLive(state) {
    ctx.renderer.setLive(state);
  }

  /* ---------------- pen / highlighter ---------------- */

  /**
   * @param {PointerEvent} e
   * @param {'pen' | 'hl'} tool
   */
  function beginStroke(e, tool) {
    const { color, size } = ctx.style();
    const k = sizeScale(ctx.scene().page);
    const stroke = /** @type {import('./scene.js').StrokeItem} */ (
      makeItem({ type: 'stroke', tool, color, size: (tool === 'hl' ? SCRATCH_SIZES.hl[size] : SCRATCH_SIZES.pen[size]) * k, pts: [] })
    );
    op = { kind: 'stroke', pointerId: e.pointerId, pointerType: e.pointerType || 'mouse', stroke, last: null, lastRaw: null, lastStored: null };
    addStrokePoint(e);
  }

  /** @param {PointerEvent} e */
  function addStrokePoint(e) {
    if (!op || op.kind !== 'stroke') return;
    const raw = ctx.toPage(e.clientX, e.clientY);
    const scale = ctx.scale();
    let p;
    if (op.pointerType === 'pen') {
      const pr = e.pressure > 0 ? e.pressure : 0.5;
      p = op.last ? op.last.p + (pr - op.last.p) * 0.6 : pr;
    } else if (op.last) {
      const dt = Math.max(1, e.timeStamp - op.last.t);
      const speed = (Math.hypot(raw.x - op.lastRaw.x, raw.y - op.lastRaw.y) * scale) / dt;
      p = simulatePressure(op.last.p, speed);
    } else p = 0.6;
    const sm = smoothPoint(op.last, raw, op.pointerType === 'pen' ? 0.3 : 0.5);
    op.last = { x: sm.x, y: sm.y, t: e.timeStamp, p };
    op.lastRaw = raw;
    if (op.lastStored && Math.hypot(sm.x - op.lastStored.x, sm.y - op.lastStored.y) * scale < 0.6) return;
    op.lastStored = sm;
    op.stroke.pts.push(Math.round(sm.x * 10) / 10, Math.round(sm.y * 10) / 10, Math.round(p * 100) / 100);
  }

  function endStroke(keep) {
    const o = op;
    op = null;
    if (!o || !keep || o.stroke.pts.length < 3) return paintIdle();
    if (o.lastRaw && o.lastStored && Math.hypot(o.lastRaw.x - o.lastStored.x, o.lastRaw.y - o.lastStored.y) * ctx.scale() >= 0.6) {
      o.stroke.pts.push(Math.round(o.lastRaw.x * 10) / 10, Math.round(o.lastRaw.y * 10) / 10, o.last?.p ?? 0.5);
    }
    ctx.commit({ type: 'add', items: [o.stroke] });
    paintIdle();
  }

  /* ---------------- eraser ---------------- */

  /** @param {PointerEvent} e */
  function eraseAt(e) {
    if (!op || op.kind !== 'erase') return;
    const pt = ctx.toPage(e.clientX, e.clientY);
    const r = ERASER_PX / ctx.scale();
    const prev = op.cursor;
    op.cursor = { x: pt.x, y: pt.y, r };
    const steps = prev ? Math.min(40, Math.ceil(Math.hypot(pt.x - prev.x, pt.y - prev.y) / (r / 2))) : 0;
    const items = ctx.scene().items;
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 1;
      const x = prev ? prev.x + (pt.x - prev.x) * t : pt.x;
      const y = prev ? prev.y + (pt.y - prev.y) * t : pt.y;
      for (const it of items) {
        if (op.erased.has(it.id) || (it.type !== 'stroke' && it.type !== 'shape')) continue;
        if (hitItem(it, x, y, r, { inside: false })) op.erased.add(it.id);
      }
      ctx.onErase?.(x, y, r);
    }
    ctx.renderer.setHidden(op.erased);
    paintLive({ cursor: op.cursor });
  }

  function endErase() {
    const o = op;
    op = null;
    if (o && o.erased.size) ctx.commit({ type: 'remove', ids: [...o.erased] });
    ctx.onEraseEnd?.(true);
    paintIdle();
  }

  /* ---------------- shapes ---------------- */

  /** @param {PointerEvent} e */
  function shapeMove(e) {
    if (!op || op.kind !== 'shape') return;
    let p = ctx.toPage(e.clientX, e.clientY);
    if (e.shiftKey) p = constrainShape(op.shape, op.p0.x, op.p0.y, p.x, p.y);
    const { color, size } = ctx.style();
    op.item = makeItem({
      id: op.id,
      type: 'shape',
      shape: op.shape,
      x1: op.p0.x,
      y1: op.p0.y,
      x2: p.x,
      y2: p.y,
      color,
      size: SCRATCH_SIZES.shape[size] * sizeScale(ctx.scene().page),
      fill: false,
    });
    paintLive({ items: [op.item] });
  }

  function endShape() {
    const o = op;
    op = null;
    const it = o?.item;
    if (it && Math.hypot(it.x2 - it.x1, it.y2 - it.y1) * ctx.scale() >= 6) {
      ctx.commit({ type: 'add', items: [it] });
    }
    paintIdle();
  }

  /* ---------------- select: move / resize / rotate / lasso ---------------- */

  /**
   * @param {PointerEvent} e
   * @param {Point} pt
   */
  function selectDown(e, pt) {
    const scale = ctx.scale();
    const sel = selectedItems();
    const f = frameFor(sel, scale, ctx.measure);
    if (f) {
      const handle = hitHandle(f.handles, pt.x, pt.y, HANDLE_HIT_PX / scale);
      if (handle) {
        op = { kind: handle === 'rotate' ? 'rotate' : 'resize', pointerId: e.pointerId, pointerType: e.pointerType, handle, frame: f, items: sel, preview: null };
        ctx.onGesture?.();
        return;
      }
    }
    const tol = TAP_TOL_PX / scale;
    const hit = hitTest(ctx.scene().items, pt.x, pt.y, tol, { measure: ctx.measure });
    if (hit) {
      const now = performance.now();
      const ids = ctx.selection();
      if (!ids.includes(hit.id)) ctx.select([hit.id]);
      else if (hit.type === 'text' && lastTap && lastTap.id === hit.id && now - lastTap.t < DOUBLE_TAP_MS) {
        lastTap = null;
        ctx.editText(/** @type {any} */ (hit), pt);
        return;
      }
      lastTap = { id: hit.id, t: now };
      op = { kind: 'move', pointerId: e.pointerId, pointerType: e.pointerType, p0: pt, items: selectedItems(), moved: false, preview: null };
      paintIdle();
      return;
    }
    // Empty paper: lasso (a plain tap clears the selection).
    op = { kind: 'lasso', pointerId: e.pointerId, pointerType: e.pointerType, pts: [pt] };
  }

  /** @param {PointerEvent} e */
  function selectMove(e) {
    if (!op) return;
    const pt = ctx.toPage(e.clientX, e.clientY);
    const scale = ctx.scale();
    if (op.kind === 'lasso') {
      const last = op.pts[op.pts.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) * scale >= 3) op.pts.push(pt);
      paintLive({ lasso: op.pts });
      return;
    }
    if (op.kind === 'move') {
      let dx = pt.x - op.p0.x;
      let dy = pt.y - op.p0.y;
      if (!op.moved && Math.hypot(dx, dy) * scale < 4) return;
      if (!op.moved) ctx.onGesture?.();
      op.moved = true;
      // Snap the selection's box to the page centre and edges.
      const b = unionBounds(op.items.map((/** @type {Item} */ i) => (i.type === 'image' && !i.rot ? itemBox(i) : itemBounds(i, { measure: ctx.measure }))));
      let guides = null;
      if (b && !e.altKey) {
        const s = snapBoxToPage({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, SNAP_PX / scale, ctx.scene().page);
        dx += s.dx;
        dy += s.dy;
        guides = s.guides;
      }
      op.preview = op.items.map((/** @type {Item} */ i) => moveItem(i, dx, dy));
      showPreview(op.preview, guides);
      return;
    }
    if (op.kind === 'rotate') {
      const it = op.items[0];
      const rot = rotationTowards(op.frame.box, pt.x, pt.y, { snap: !e.altKey });
      op.preview = [{ ...it, rot }];
      showPreview(op.preview, null);
      return;
    }
    if (op.kind === 'resize') {
      op.preview = resizePreview(op, pt, e.shiftKey);
      showPreview(op.preview, null);
    }
  }

  /**
   * @param {any} o Resize op.
   * @param {Point} pt
   * @param {boolean} shift
   * @returns {Item[]}
   */
  function resizePreview(o, pt, shift) {
    const f = o.frame;
    const it = o.items[0];
    if (f.kind === 'line') {
      return [o.handle === 'p1' ? { ...it, x1: pt.x, y1: pt.y } : { ...it, x2: pt.x, y2: pt.y }];
    }
    if (f.kind === 'image') {
      const keep = ctx.aspectLocked() !== shift;
      const b = resizeBox(f.box, f.rot, o.handle, pt.x, pt.y, { keepAspect: keep });
      return [{ ...it, x: b.x, y: b.y, w: b.w, h: b.h }];
    }
    if (f.kind === 'text') {
      const b = resizeBox(f.box, 0, o.handle, pt.x, pt.y, { min: Math.max(MIN_SIDE * 2, it.size * 1.5) });
      return [{ ...it, x: b.x, w: b.w }];
    }
    if (f.kind === 'shape') {
      const b = resizeBox(f.box, 0, o.handle, pt.x, pt.y, { keepAspect: shift, min: 4 });
      const flipX = it.x2 < it.x1;
      const flipY = it.y2 < it.y1;
      return [
        {
          ...it,
          x1: flipX ? b.x + b.w : b.x,
          x2: flipX ? b.x : b.x + b.w,
          y1: flipY ? b.y + b.h : b.y,
          y2: flipY ? b.y : b.y + b.h,
        },
      ];
    }
    const b = resizeBox(f.box, 0, o.handle, pt.x, pt.y, { keepAspect: !shift, min: 8 });
    return scaleItems(o.items, f.box, b);
  }

  /**
   * @param {Item[]} items
   * @param {{ x: number | null, y: number | null } | null} guides
   */
  function showPreview(items, guides) {
    ctx.renderer.setHidden(items.map((i) => i.id));
    const f = frameFor(items, ctx.scale(), ctx.measure);
    paintLive({ items, selection: f ? { ...selectionFrame(f), dashed: f.kind === 'group' } : null, guides });
  }

  function selectUp() {
    const o = op;
    op = null;
    if (!o) return;
    if (o.kind === 'lasso') {
      const ids = o.pts.length > 4 ? lassoSelect(ctx.scene().items, o.pts, { measure: ctx.measure }) : [];
      ctx.select(ids);
    } else if (o.preview && (o.kind !== 'move' || o.moved)) {
      ctx.commit({ type: 'update', items: o.preview });
    }
    paintIdle();
  }

  /* ---------------- pinch on a selected image ---------------- */

  /** @param {Point[]} pts */
  function pinchGeom(pts) {
    const [a, b] = pts;
    return {
      d: Math.hypot(b.x - a.x, b.y - a.y),
      a: Math.atan2(b.y - a.y, b.x - a.x),
      m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }

  /** @param {Point[]} pts client points */
  function startPinch(pts) {
    const sel = selectedItems();
    const g0 = pinchGeom(pts);
    if (sel.length === 1 && sel[0].type === 'image') {
      const mid = ctx.toPage(g0.m.x, g0.m.y);
      const img = /** @type {import('./scene.js').ImageItem} */ (sel[0]);
      if (hitItem(img, mid.x, mid.y, HANDLE_HIT_PX / ctx.scale())) {
        pinch = { kind: 'image', item: img, d0: g0.d, a0: g0.a, m0: mid, preview: null };
        return;
      }
    }
    pinch = { kind: 'view' };
    ctx.pinchStart(pts);
  }

  /** @param {Point[]} pts */
  function movePinch(pts) {
    if (!pinch) return;
    if (pinch.kind === 'view') return ctx.pinchMove(pts);
    const g = pinchGeom(pts);
    const it = pinch.item;
    const k = pinch.d0 > 0 ? Math.max(0.05, g.d / pinch.d0) : 1;
    const mid = ctx.toPage(g.m.x, g.m.y);
    const w = Math.max(MIN_SIDE, it.w * k);
    const ht = Math.max(MIN_SIDE, it.h * k);
    // Keep the page point under the fingers under the fingers.
    const c0 = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
    const da = g.a - pinch.a0;
    const rel = rotatePoint(c0.x - pinch.m0.x, c0.y - pinch.m0.y, 0, 0, da);
    const cx = mid.x + rel.x * k;
    const cy = mid.y + rel.y * k;
    pinch.preview = [{ ...it, x: cx - w / 2, y: cy - ht / 2, w, h: ht, rot: it.rot + da }];
    showPreview(pinch.preview, null);
  }

  function endPinch() {
    const p = pinch;
    pinch = null;
    if (!p) return;
    if (p.kind === 'view') ctx.pinchEnd();
    else if (p.preview) {
      const it = p.preview[0];
      const rot = Math.atan2(Math.sin(it.rot), Math.cos(it.rot));
      ctx.commit({ type: 'update', items: [{ ...it, rot }] });
    }
    paintIdle();
    ctx.onIdle?.();
  }

  /* ---------------- routing ---------------- */

  /**
   * Ends whatever gesture is running.
   * @param {boolean} keep Commit it (false = discard).
   */
  function finish(keep) {
    if (!op) return;
    const kind = op.kind;
    try {
      el.releasePointerCapture?.(op.pointerId);
    } catch {
      /* ignore */
    }
    if (kind === 'stroke') endStroke(keep);
    else if (kind === 'pan') op = null;
    else if (!keep) {
      op = null;
      if (kind === 'erase') ctx.onEraseEnd?.(false);
      paintIdle();
    } else if (kind === 'erase') endErase();
    else if (kind === 'shape') endShape();
    else selectUp();
    ctx.onIdle?.();
  }

  /**
   * @param {PointerEvent} e
   * @param {string} tool
   */
  function begin(e, tool) {
    const pt = ctx.toPage(e.clientX, e.clientY);
    if (tool === 'hand' || ctx.panKey() || e.button === 1) {
      op = { kind: 'pan', pointerId: e.pointerId, pointerType: e.pointerType, last: { x: e.clientX, y: e.clientY } };
      el.dataset.panning = 'true';
      return;
    }
    if (tool === 'pen' || tool === 'hl') {
      ctx.onGesture?.();
      beginStroke(e, tool);
      paintLive({ stroke: op?.stroke });
    } else if (tool === 'eraser') {
      ctx.onGesture?.();
      op = { kind: 'erase', pointerId: e.pointerId, pointerType: e.pointerType, cursor: null, erased: new Set() };
      eraseAt(e);
    } else if (SHAPES.includes(tool)) {
      ctx.onGesture?.();
      op = { kind: 'shape', pointerId: e.pointerId, pointerType: e.pointerType, shape: tool, p0: pt, id: makeItem({ type: 'shape' }).id, item: null };
    } else if (tool === 'text') {
      const hit = hitTest(ctx.scene().items, pt.x, pt.y, TAP_TOL_PX / ctx.scale(), { measure: ctx.measure, filter: (i) => i.type === 'text' });
      op = { kind: 'textTap', pointerId: e.pointerId, pointerType: e.pointerType, pt, hit, c0: { x: e.clientX, y: e.clientY }, tool };
    } else if (isTapTool(tool)) {
      op = { kind: 'textTap', pointerId: e.pointerId, pointerType: e.pointerType, pt, hit: null, c0: { x: e.clientX, y: e.clientY }, tool };
    } else {
      selectDown(e, pt);
    }
  }

  /** @param {PointerEvent} e */
  function onDown(e) {
    if (destroyed) return;
    const type = e.pointerType || 'mouse';
    if (type === 'pen') penSeen = true;
    if (type === 'touch') {
      if (e.isPrimary) {
        touches.clear();
        touchLock = false;
        if (pinch) endPinch();
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (touchLock) {
        if (pinch?.kind === 'view') {
          ctx.pinchEnd();
          ctx.pinchStart([...touches.values()]);
        }
        return;
      }
      if (op && op.pointerType !== 'touch') return; // a pen is drawing: this is a palm
      if (touches.size >= 2) {
        // The first finger was the start of a two-finger gesture: drop it.
        if (op) finish(false);
        touchLock = true;
        startPinch([...touches.values()].slice(0, 2));
        return;
      }
      if (!fingersDraw() && ctx.tool() !== 'select' && ctx.tool() !== 'text' && !isTapTool(ctx.tool())) {
        op = { kind: 'pan', pointerId: e.pointerId, pointerType: 'touch', last: { x: e.clientX, y: e.clientY } };
        return;
      }
      if (op) return;
    } else {
      if (type === 'mouse' && e.button !== 0 && e.button !== 1) return;
      if (op) {
        if (op.pointerType === 'touch' && type === 'pen') finish(false);
        else return;
      }
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    begin(e, ctx.tool());
  }

  /** @param {PointerEvent} e */
  function onMove(e) {
    const t = touches.get(e.pointerId);
    if (t) {
      t.x = e.clientX;
      t.y = e.clientY;
      if (pinch) {
        movePinch([...touches.values()].slice(0, 2));
        return;
      }
    }
    if (!op || op.pointerId !== e.pointerId) return;
    if (op.kind === 'pan') {
      ctx.panBy(op.last.x - e.clientX, op.last.y - e.clientY);
      op.last = { x: e.clientX, y: e.clientY };
      return;
    }
    if (op.kind === 'textTap') return;
    const list = op.kind === 'stroke' && typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const events = list.length ? list : [e];
    if (op.kind === 'stroke') {
      for (const ev of events) addStrokePoint(/** @type {PointerEvent} */ (ev));
      scheduleLive();
    } else if (op.kind === 'erase') eraseAt(e);
    else if (op.kind === 'shape') shapeMove(e);
    else selectMove(e);
  }

  function scheduleLive() {
    if (rafLive) return;
    rafLive = requestAnimationFrame(() => {
      rafLive = 0;
      if (op?.kind === 'stroke') paintLive({ stroke: op.stroke });
    });
  }

  /** @param {PointerEvent} e */
  function onUp(e) {
    const wasTouch = touches.delete(e.pointerId);
    if (wasTouch && (pinch || touchLock)) {
      if (touches.size < 2 && pinch) endPinch();
      if (touches.size === 0) touchLock = false;
      return;
    }
    if (touches.size === 0) touchLock = false;
    if (!op || op.pointerId !== e.pointerId) return;
    delete el.dataset.panning;
    if (op.kind === 'textTap') {
      const o = op;
      op = null;
      if (Math.hypot(e.clientX - o.c0.x, e.clientY - o.c0.y) < 10 && e.type !== 'pointercancel') {
        if (o.tool === 'text' || !o.tool) ctx.editText(o.hit, o.pt);
        else ctx.tapTool?.(o.tool, o.pt);
      }
      return;
    }
    // A cancelled touch stroke is usually a scroll or a palm; a cancelled pen stroke is kept.
    finish(!(e.type === 'pointercancel' && op.pointerType === 'touch' && op.kind === 'stroke'));
  }

  /** @param {Event} e */
  const noMenu = (e) => e.preventDefault();
  /** iOS: stop the page from scrolling while a pen draws. @param {TouchEvent} e */
  const onTouch = (e) => {
    if (e.cancelable) e.preventDefault();
  };

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('contextmenu', noMenu);
  el.addEventListener('touchstart', onTouch, { passive: false });
  el.addEventListener('touchmove', onTouch, { passive: false });

  return {
    /** Repaint the selection frame (after undo, selection or view changes). */
    refresh() {
      if (!op && !pinch) paintIdle();
    },
    /** Ends a running gesture (keeps finished work). */
    cancel() {
      if (op) finish(true);
      if (pinch) endPinch();
      touches.clear();
      touchLock = false;
    },
    isBusy: () => Boolean(op || pinch),
    destroy() {
      destroyed = true;
      if (rafLive) cancelAnimationFrame(rafLive);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('contextmenu', noMenu);
      el.removeEventListener('touchstart', onTouch);
      el.removeEventListener('touchmove', onTouch);
    },
  };
}
