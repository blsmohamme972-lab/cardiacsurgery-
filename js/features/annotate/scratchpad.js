/**
 * Scratchpad v2 (docs/ARCHITECTURE.md §7.16): a note-taking workspace per
 * question that opens over the question with one tap.
 *
 * This module is the UI shell. It owns the overlay (a full-screen sheet), the
 * top bar (close, title, zoom pill), the toolbar (Select, Pen, Highlighter,
 * Eraser, Shapes, Text, Image · Undo, Redo, colour and size, More, Done), the
 * popovers, the floating selection bar, the text editor, the three views
 * (over the question, split, full page), persistence and the page view
 * (zoom/pan). The model, geometry, renderer, tools and image import live in
 * `features/scratch/*`.
 *
 * Never lose work: every change is saved 400 ms later (to `inkRepo`, block
 * `scratch`, as a v2 scene) and at once on close, `pagehide` and when the
 * page is hidden. A failed save keeps the scene in memory (reopening the
 * scratchpad brings it back) and offers Retry. Unused images are pruned only
 * after a successful save on close. A v1 record (strokes only) is converted
 * on first open and saved back.
 *
 * Importing this module touches no DOM (the view math is unit-tested in Node).
 *
 * @module features/annotate/scratchpad
 */

import { h, svg } from '../../core/dom.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { inkRepo } from '../../core/store/repo.js';
import { icon } from '../../ui/icons.js';
import { sheet, iconButton, toast, undoToast, segmented } from '../../ui/components.js';
import { renderStem, renderInline } from '../explain/render.js';
import {
  PAGE_W,
  PAGE_H,
  BACKGROUNDS,
  SCRATCH_COLORS,
  SCRATCH_SIZES,
  emptyScene,
  deserialize,
  serialize,
  migrateV1,
  mediaIds,
  createHistory,
  cloneItem,
  reorderIds,
  paintColor,
  sizeIndex,
  makeItem,
} from '../scratch/scene.js';
import { clampPan, zoomAround, fitWidthScale, insertBox, itemBounds, unionBounds, TEXT_LINE, TEXT_PAD } from '../scratch/geometry.js';
import { createRenderer } from '../scratch/render.js';
import { createTools, frameFor } from '../scratch/tools.js';
import { importImage, pickImageFile, imageFilesFrom, loadMediaBlob, pruneMedia, MediaError } from '../scratch/media.js';

export { clampPan, zoomAround };

/** Zoom bounds, relative to "fit width" (1 = the page width fills the view). */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
/** Zoom step of the buttons. */
const ZOOM_STEP = 1.25;
/** Autosave delay. */
export const SAVE_DELAY_MS = 400;
/** The views. */
export const VIEWS = Object.freeze(['over', 'split', 'full']);
/** Gap around the page in the split and full views (CSS px). */
const PAGE_MARGIN = 12;

/** Last page view per question (this app session). @type {Map<string, { zoom: number, x: number, y: number }>} */
const views = new Map();
/** Scenes that could not be saved, kept so reopening never loses them. @type {Map<string, any>} */
const unsaved = new Map();
/** Split position (fraction for the question pane), this app session. */
let splitRatio = 0.38;

const TOOL_KEYS = Object.freeze({ v: 'select', p: 'pen', h: 'hl', e: 'eraser', t: 'text' });
const SHAPE_TOOLS = Object.freeze(['line', 'arrow', 'rect', 'ellipse']);
const TOOL_LABELS = Object.freeze({
  select: 'Select',
  pen: 'Pen',
  hl: 'Highlighter',
  eraser: 'Eraser',
  line: 'Line',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  text: 'Text',
  hand: 'Hand',
});

/* ------------------------------------------------------------------ */
/* Small icons the shared set does not have (stroke icons, 24×24)      */
/* ------------------------------------------------------------------ */

/**
 * @param {string} name
 * @param {number} [size=22]
 * @returns {SVGElement}
 */
function glyph(name, size = 22) {
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
    front: () => [svg('rect', { x: 9, y: 9, width: 11, height: 11, rx: 1.5, fill: 'currentColor', 'fill-opacity': 0.25 }), svg('path', { d: 'M15 5V4.5A1.5 1.5 0 0 0 13.5 3h-9A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H5' })],
    back: () => [svg('rect', { x: 3, y: 3, width: 11, height: 11, rx: 1.5, fill: 'currentColor', 'fill-opacity': 0.25 }), svg('path', { d: 'M18 9h.5A1.5 1.5 0 0 1 20 10.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 9 19.5V19' })],
    lock: () => [svg('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }), svg('path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' })],
    unlock: () => [svg('rect', { x: 5, y: 11, width: 14, height: 9, rx: 2 }), svg('path', { d: 'M8 11V8a4 4 0 0 1 7.5-2' })],
    fit: () => [svg('path', { d: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4' })],
  };
  const make = shapes[name];
  return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', class: 'icon', ...a }, ...(make ? make() : []));
}

/**
 * Icon for a tool or action (shared set first).
 * @param {string} name
 * @param {number} [size=22]
 */
function toolIcon(name, size = 22) {
  const map = /** @type {Record<string, string>} */ ({ pen: 'pen', hl: 'highlighter', eraser: 'eraser', image: 'image', hand: 'hand' });
  return map[name] ? icon(map[name], { size }) : glyph(name, size);
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

/** @returns {boolean} */
function isDark() {
  return document.documentElement.dataset.theme === 'dark';
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
 * Opens the scratchpad for a question.
 *
 * @param {{ id: string, version?: number, stem?: string, choices?: { id: string, text: string }[] }} question
 * @param {{ view?: 'over' | 'split' | 'full', choiceOrder?: string[] }} [opts]
 *   `view` overrides the remembered view; `choiceOrder` orders the choices in the split view's question copy.
 * @returns {Promise<void> & { close: () => Promise<void> }} Resolves when the scratchpad has closed (and saved).
 */
export function openScratchpad(question, { view: viewOpt, choiceOrder } = {}) {
  const qid = question?.id;
  if (typeof qid !== 'string' || !qid) throw new TypeError('openScratchpad: question with an id required');
  const qversion = Number.isInteger(question.version) && /** @type {number} */ (question.version) > 0 ? question.version : 1;

  /* ---------------- state ---------------- */

  const history = createHistory(emptyScene(setting('scratchBg', 'dots')));
  /** @type {string[]} */
  let selection = [];
  let tool = normalizeTool(setting('scratchTool', 'pen'));
  let lastShape = SHAPE_TOOLS.includes(tool) ? tool : 'rect';
  let color = String(setting('scratchColor', SCRATCH_COLORS[1].hex)).toLowerCase();
  if (!SCRATCH_COLORS.some((c) => c.hex === color)) color = SCRATCH_COLORS[1].hex;
  let size = sizeIndex(setting('scratchSize', 1));
  let mode = VIEWS.includes(/** @type {any} */ (viewOpt)) ? /** @type {string} */ (viewOpt) : VIEWS.includes(setting('scratchView', 'over')) ? setting('scratchView', 'over') : 'over';
  let opacity = Math.min(0.9, Math.max(0, Number(setting('scratchOpacity', 0)) || 0));
  let aspectLock = true;
  let loaded = false;
  let dirty = false;
  let closed = false;
  let spaceDown = false;
  /** Viewport size (CSS px) and cached rect. */
  let vw = 0;
  let vh = 0;
  /** @type {DOMRect | null} */
  let rect = null;
  /** zoom: relative to fit width; x/y: page point at the viewport's top-left. */
  let pv = views.get(qid) || null;

  /** @param {string} t */
  function normalizeTool(t) {
    if (t === 'lasso') return 'select';
    if (t === 'shape') return 'rect';
    return ['select', 'pen', 'hl', 'eraser', 'text', 'hand', ...SHAPE_TOOLS].includes(t) ? t : 'pen';
  }

  /* ---------------- DOM ---------------- */

  const sceneCanvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'scratch-canvas', 'aria-hidden': 'true' }));
  const liveCanvas = /** @type {HTMLCanvasElement} */ (h('canvas', { class: 'scratch-live', 'aria-hidden': 'true' }));
  const viewport = h(
    'div',
    {
      class: 'scratch-viewport',
      tabindex: '0',
      role: 'application',
      'aria-roledescription': 'drawing page',
      'aria-label': 'Scratchpad page. Draw with your finger, a pen or the mouse.',
      'data-no-drag': '',
    },
    sceneCanvas,
    liveCanvas,
  );
  const hint = h(
    'p',
    { class: 'scratch-hint', role: 'note' },
    h('span', null, 'Draw with your finger or pen'),
    h('span', { class: 'scratch-hint-sep', 'aria-hidden': 'true' }, '·'),
    h('span', null, 'Tap Image to add a picture'),
  );
  const selBar = h('div', { class: 'scratch-selbar', role: 'toolbar', 'aria-label': 'Selection', hidden: true });
  const stage = h('div', { class: 'scratch-stage' }, viewport, hint, selBar);

  const questionPane = h('section', { class: 'scratch-question', 'aria-label': 'Question (read only)', tabindex: '0' });
  const divider = h('div', {
    class: 'scratch-divider',
    role: 'separator',
    tabindex: '0',
    'aria-label': 'Resize question and page',
    'aria-orientation': 'horizontal',
    'aria-valuemin': '15',
    'aria-valuemax': '85',
  });
  const body = h('div', { class: 'scratch-body' }, questionPane, divider, stage);

  /* top bar */
  const zoomValue = h('span', { class: 'scratch-zoom-value' }, '100%');
  const zoomOutBtn = iconButton({ icon: 'zoom-out', label: 'Zoom out', onClick: () => zoomBy(1 / ZOOM_STEP) });
  const zoomInBtn = iconButton({ icon: 'zoom-in', label: 'Zoom in', onClick: () => zoomBy(ZOOM_STEP) });
  const zoomResetBtn = h(
    'button',
    { type: 'button', class: 'scratch-zoom-reset', title: 'Fit to width', onClick: () => fitWidth() },
    zoomValue,
  );
  const fitBtn = h(
    'button',
    { type: 'button', class: 'scratch-fit', 'aria-label': 'Fit page to width', title: 'Fit page to width', onClick: () => fitWidth() },
    glyph('fit', 18),
    h('span', null, 'Fit'),
  );
  const zoomPill = h('div', { class: 'scratch-zoom', role: 'group', 'aria-label': 'Zoom' }, zoomOutBtn, zoomResetBtn, zoomInBtn, fitBtn);
  const closeBtn = iconButton({ icon: 'close', label: 'Close scratchpad', onClick: () => void requestClose() });
  closeBtn.classList.add('scratch-close');
  const saveState = h('span', { class: 'scratch-save', 'aria-live': 'polite' });
  const top = h(
    'div',
    { class: 'scratch-top' },
    closeBtn,
    h('div', { class: 'scratch-title' }, h('span', { class: 'scratch-title-text' }, 'Scratchpad'), saveState),
    zoomPill,
  );

  /* toolbar */
  /** @type {Record<string, HTMLButtonElement>} */
  const toolBtns = {};
  /**
   * @param {string} name
   * @param {string} label
   * @param {() => void} onClick
   * @param {{ pressed?: boolean, expanded?: boolean }} [o]
   */
  const tbButton = (name, label, onClick, o = {}) =>
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
        h('span', { class: 'scratch-tb-label', 'aria-hidden': 'true' }, shortLabel(name, label)),
      )
    );
  /** @param {string} name @param {string} label */
  function shortLabel(name, label) {
    return name === 'hl' ? 'Highlight' : label;
  }

  for (const t of ['select', 'pen', 'hl', 'eraser']) {
    toolBtns[t] = tbButton(t, TOOL_LABELS[/** @type {keyof typeof TOOL_LABELS} */ (t)], () => setTool(t), { pressed: false });
  }
  const shapesBtn = tbButton('shapes', 'Shapes', () => togglePop('shapes'), { expanded: false });
  shapesBtn.setAttribute('aria-pressed', 'false');
  toolBtns.text = tbButton('text', 'Text', () => setTool('text'), { pressed: false });
  const imageBtn = tbButton('image', 'Image', () => void chooseImage());
  imageBtn.dataset.action = 'image';

  const undoBtn = iconButton({ icon: 'undo', label: 'Undo', onClick: () => undo() });
  const redoBtn = iconButton({ icon: 'redo', label: 'Redo', onClick: () => redo() });
  undoBtn.classList.add('scratch-act');
  redoBtn.classList.add('scratch-act');
  const styleDot = h('span', { class: 'scratch-style-dot', 'aria-hidden': 'true' });
  const styleBtn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        type: 'button',
        class: 'scratch-style',
        'aria-label': 'Colour and size',
        title: 'Colour and size',
        'aria-haspopup': 'true',
        'aria-expanded': 'false',
        onClick: () => togglePop('style'),
      },
      styleDot,
    )
  );
  const moreBtn = iconButton({ icon: 'more', label: 'More options', onClick: () => togglePop('more') });
  moreBtn.classList.add('scratch-act');
  moreBtn.setAttribute('aria-haspopup', 'true');
  moreBtn.setAttribute('aria-expanded', 'false');
  const doneBtn = h('button', { type: 'button', class: 'scratch-done', onClick: () => void requestClose() }, icon('check', { size: 20 }), h('span', null, 'Done'));

  const toolbar = h(
    'div',
    { class: 'scratch-toolbar', role: 'toolbar', 'aria-label': 'Scratchpad tools' },
    h(
      'div',
      { class: 'scratch-tb-tools', role: 'group', 'aria-label': 'Tools' },
      toolBtns.select,
      toolBtns.pen,
      toolBtns.hl,
      toolBtns.eraser,
      shapesBtn,
      toolBtns.text,
      imageBtn,
    ),
    h(
      'div',
      { class: 'scratch-tb-actions' },
      h('div', { class: 'scratch-tb-group' }, undoBtn, redoBtn),
      h('div', { class: 'scratch-tb-group' }, styleBtn, moreBtn),
      h('span', { class: 'scratch-tb-spacer', 'aria-hidden': 'true' }),
      doneBtn,
    ),
  );

  /* popovers */
  const colorBtns = SCRATCH_COLORS.map((c) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        {
          type: 'button',
          class: 'scratch-swatch',
          'aria-label': c.name,
          title: c.name,
          'aria-pressed': 'false',
          dataset: { color: c.hex },
          onClick: () => setColor(c.hex),
        },
        h('span', { class: 'scratch-swatch-dot', 'aria-hidden': 'true' }),
      )
    ),
  );
  const sizeBtns = SCRATCH_SIZES.names.map((name, i) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        {
          type: 'button',
          class: `scratch-size scratch-size-${i}`,
          'aria-label': name,
          title: name,
          'aria-pressed': 'false',
          onClick: () => setSize(/** @type {0 | 1 | 2} */ (i)),
        },
        h('span', { class: 'scratch-size-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'scratch-size-label' }, name),
      )
    ),
  );
  const stylePop = h(
    'div',
    { class: 'scratch-pop scratch-pop-style', role: 'group', 'aria-label': 'Colour and size', hidden: true },
    h('div', { class: 'scratch-pop-title' }, 'Colour'),
    h('div', { class: 'scratch-swatches' }, colorBtns),
    h('div', { class: 'scratch-pop-title' }, 'Size'),
    h('div', { class: 'scratch-sizes' }, sizeBtns),
  );

  /** @type {Record<string, HTMLButtonElement>} */
  const shapeBtns = {};
  for (const s of SHAPE_TOOLS) {
    shapeBtns[s] = /** @type {HTMLButtonElement} */ (
      h(
        'button',
        {
          type: 'button',
          class: 'scratch-pop-item',
          'aria-pressed': 'false',
          dataset: { shape: s },
          onClick: () => {
            setTool(s);
            closePop();
          },
        },
        glyph(s, 22),
        h('span', null, TOOL_LABELS[/** @type {keyof typeof TOOL_LABELS} */ (s)]),
      )
    );
  }
  const shapesPop = h(
    'div',
    { class: 'scratch-pop scratch-pop-shapes', role: 'group', 'aria-label': 'Shapes', hidden: true },
    h('div', { class: 'scratch-pop-grid' }, Object.values(shapeBtns)),
    h('p', { class: 'scratch-pop-note' }, 'Drag on the page to draw. Hold Shift for straight lines and squares.'),
  );

  const viewSeg = segmented({
    ariaLabel: 'View',
    value: mode,
    options: [
      { value: 'over', label: 'Over question' },
      { value: 'split', label: 'Split' },
      { value: 'full', label: 'Full page' },
    ],
    onChange: (/** @type {string} */ v) => setMode(v),
  });
  const bgSeg = segmented({
    ariaLabel: 'Page',
    value: history.scene.page.bg,
    options: BACKGROUNDS.map((b) => ({ value: b, label: b[0].toUpperCase() + b.slice(1) })),
    onChange: (/** @type {string} */ v) => setBackground(v),
  });
  const opacityInput = /** @type {HTMLInputElement} */ (
    h('input', {
      type: 'range',
      min: '0',
      max: '90',
      step: '5',
      value: String(Math.round(opacity * 100)),
      class: 'scratch-range',
      id: `scratch-op-${qid.replace(/[^A-Za-z0-9_-]/g, '')}`,
      'aria-label': 'Paper opacity',
      onInput: (/** @type {Event} */ e) => setOpacity(Number(/** @type {HTMLInputElement} */ (e.target).value) / 100),
    })
  );
  const opacityRow = h(
    'div',
    { class: 'scratch-pop-row scratch-opacity' },
    h('label', { class: 'scratch-pop-title', for: opacityInput.id }, 'Paper behind your notes'),
    h('div', { class: 'scratch-range-row' }, h('span', { 'aria-hidden': 'true' }, 'See-through'), opacityInput, h('span', { 'aria-hidden': 'true' }, 'Solid')),
  );
  /**
   * @param {string} iconNode
   * @param {string} label
   * @param {() => void} onClick
   * @param {string} [kind]
   */
  const popAction = (iconNode, label, onClick, kind) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: ['scratch-pop-action', kind && `is-${kind}`], onClick },
        iconNode === 'fit' ? glyph('fit', 20) : icon(iconNode, { size: 20 }),
        h('span', null, label),
      )
    );
  const clearBtn = popAction('trash', 'Clear page', () => clearPage(), 'danger');
  const exportBtn = popAction('download', 'Save as image', () => void exportPng());
  const morePop = h(
    'div',
    { class: 'scratch-pop scratch-pop-more', role: 'group', 'aria-label': 'More options', hidden: true },
    h('div', { class: 'scratch-pop-title' }, 'View'),
    viewSeg,
    opacityRow,
    h('div', { class: 'scratch-pop-title' }, 'Page'),
    bgSeg,
    h(
      'div',
      { class: 'scratch-pop-actions' },
      popAction('fit', 'Fit to width', () => {
        fitWidth();
        closePop();
      }),
      exportBtn,
      clearBtn,
    ),
  );

  const content = h(
    'div',
    { class: 'scratch', dataset: { view: mode } },
    top,
    body,
    toolbar,
  );
  toolbar.append(stylePop, shapesPop, morePop);

  /* ---------------- renderer + tools ---------------- */

  const renderer = createRenderer({ sceneCanvas, liveCanvas, host: content, loadMedia: loadMediaBlob });

  /** CSS px per page unit. */
  const fitScale = () => fitWidthScale(vw || 1, margin());
  const margin = () => (mode === 'over' ? 0 : PAGE_MARGIN);
  const scale = () => fitScale() * (pv?.zoom ?? 1);

  const tools = createTools({
    el: viewport,
    toPage(cx, cy) {
      const r = rect || viewport.getBoundingClientRect();
      const s = scale();
      return { x: (pv?.x ?? 0) + (cx - r.left) / s, y: (pv?.y ?? 0) + (cy - r.top) / s };
    },
    scale,
    scene: () => history.scene,
    commit,
    renderer,
    tool: () => tool,
    style: () => ({ color, size }),
    selection: () => selection,
    select: (ids) => setSelection(ids),
    aspectLocked: () => aspectLock,
    drawInput: () => setting('drawInput', 'auto'),
    panKey: () => spaceDown,
    panBy: (dx, dy) => setView({ zoom: pv.zoom, x: pv.x + dx / scale(), y: pv.y + dy / scale() }),
    pinchStart(pts) {
      pinch = { view: { ...pv }, ...measurePinch(pts) };
    },
    pinchMove(pts) {
      if (!pinch) return;
      const m = measurePinch(pts);
      const ratio = pinch.dist > 0 && m.dist > 0 ? m.dist / pinch.dist : 1;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.view.zoom * ratio));
      const s0 = fitScale() * pinch.view.zoom;
      const s1 = fitScale() * zoom;
      const px = pinch.view.x + pinch.mid.x / s0;
      const py = pinch.view.y + pinch.mid.y / s0;
      setView({ zoom, x: px - m.mid.x / s1, y: py - m.mid.y / s1 });
    },
    pinchEnd() {
      pinch = null;
    },
    editText: (item, at) => openTextEditor(item, at),
    measure: renderer.measure,
    onGesture() {
      closePop();
      hideHint();
      selBar.hidden = true;
    },
    onIdle: () => placeSelBar(),
  });

  /** @type {null | { view: { zoom: number, x: number, y: number }, mid: { x: number, y: number }, dist: number }} */
  let pinch = null;

  /** @param {{ x: number, y: number }[]} pts */
  function measurePinch(pts) {
    const r = rect || viewport.getBoundingClientRect();
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length - r.left;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length - r.top;
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    return { mid: { x: mx, y: my }, dist };
  }

  // Runs before the tools' own listener: fresh rect, finish text editing.
  viewport.addEventListener(
    'pointerdown',
    () => {
      rect = viewport.getBoundingClientRect();
      if (editor) commitTextEditor();
      closePop();
    },
    { capture: true },
  );

  /* ---------------- view (zoom / pan) ---------------- */

  /** @param {{ zoom: number, x: number, y: number }} next */
  function setView(next) {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom));
    const s = fitScale() * zoom;
    const m = margin();
    pv = {
      zoom,
      x: vw ? clampPan(next.x, vw, s, PAGE_W, m) : next.x,
      y: vh ? clampPan(next.y, vh, s, PAGE_H, Math.max(m, vh * 0.25)) : next.y,
    };
    views.set(qid, pv);
    renderer.setView({ scale: s, x: pv.x, y: pv.y });
    const pct = Math.round(zoom * 100);
    zoomValue.textContent = `${pct}%`;
    zoomResetBtn.setAttribute('aria-label', `Zoom ${pct}%. Fit to width`);
    /** @type {HTMLButtonElement} */ (zoomOutBtn).disabled = zoom <= MIN_ZOOM + 1e-6;
    /** @type {HTMLButtonElement} */ (zoomInBtn).disabled = zoom >= MAX_ZOOM - 1e-6;
    tools.refresh();
    placeSelBar();
    if (editor) placeTextEditor();
  }

  function fitWidth() {
    setView({ zoom: 1, x: -margin() / fitScale(), y: pv ? pv.y : -margin() / fitScale() });
  }

  /** @param {number} factor */
  function zoomBy(factor) {
    const s0 = scale();
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pv.zoom * factor));
    const s1 = fitScale() * z;
    setView({ zoom: z, x: pv.x + vw / 2 / s0 - vw / 2 / s1, y: pv.y + vh / 2 / s0 - vh / 2 / s1 });
  }

  function resize() {
    const r = viewport.getBoundingClientRect();
    rect = r;
    const nw = Math.round(r.width);
    const nh = Math.round(r.height);
    if (!nw || !nh) return;
    const first = !vw;
    vw = nw;
    vh = nh;
    renderer.resize(vw, vh);
    if (first && !pv) pv = { zoom: 1, x: -margin() / fitScale(), y: -margin() / fitScale() };
    setView(pv || { zoom: 1, x: 0, y: 0 });
  }

  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = viewport.getBoundingClientRect();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh : 1;
      if (e.ctrlKey || e.metaKey) {
        const z = pv.zoom * Math.exp(-e.deltaY * unit * 0.01);
        const v = zoomAround(pv, z, e.clientX - r.left, e.clientY - r.top, { min: MIN_ZOOM, max: MAX_ZOOM, unit: fitScale() });
        setView(v);
      } else {
        const s = scale();
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * unit;
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * unit;
        setView({ zoom: pv.zoom, x: pv.x + dx / s, y: pv.y + dy / s });
      }
    },
    { passive: false },
  );

  /* ---------------- scene changes ---------------- */

  /**
   * Applies one undoable command.
   * @param {import('../scratch/scene.js').Command} cmd
   * @returns {boolean}
   */
  function commit(cmd) {
    if (!loaded) return false;
    const ok = history.apply(cmd);
    if (ok) afterChange();
    return ok;
  }

  function afterChange() {
    const scene = history.scene;
    renderer.setScene(scene);
    const ids = new Set(scene.items.map((i) => i.id));
    if (selection.some((id) => !ids.has(id))) selection = selection.filter((id) => ids.has(id));
    syncHistory();
    if (bgSeg.value !== scene.page.bg) bgSeg.value = scene.page.bg;
    tools.refresh();
    placeSelBar();
    if (scene.items.length) hideHint();
    scheduleSave();
  }

  function undo() {
    tools.cancel();
    if (editor) commitTextEditor();
    if (history.undo()) afterChange();
  }

  function redo() {
    tools.cancel();
    if (history.redo()) afterChange();
  }

  function syncHistory() {
    undoBtn.disabled = !history.canUndo();
    redoBtn.disabled = !history.canRedo();
    clearBtn.disabled = history.scene.items.length === 0;
  }

  /** @param {string[]} ids */
  function setSelection(ids) {
    selection = ids.slice();
    tools.refresh();
    placeSelBar();
  }

  /* ---------------- tool / style ---------------- */

  /** @param {string} t */
  function setTool(t) {
    const next = normalizeTool(t);
    if (editor) commitTextEditor();
    tool = next;
    if (SHAPE_TOOLS.includes(next)) lastShape = next;
    if (next !== 'select' && selection.length) setSelection([]);
    remember('scratchTool', next);
    syncTools();
  }

  function syncTools() {
    for (const [t, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(t === tool));
    const isShape = SHAPE_TOOLS.includes(tool);
    shapesBtn.setAttribute('aria-pressed', String(isShape));
    shapesBtn.querySelector('.scratch-tb-icon')?.replaceChildren(glyph(isShape ? tool : 'shapes'));
    for (const [s, b] of Object.entries(shapeBtns)) b.setAttribute('aria-pressed', String(s === tool));
    viewport.dataset.tool = tool;
    syncStyle();
  }

  function syncStyle() {
    const dark = isDark();
    for (const b of colorBtns) {
      b.setAttribute('aria-pressed', String(b.dataset.color === color));
      b.style.setProperty('--swatch', paintColor(b.dataset.color || '', dark));
    }
    sizeBtns.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === size));
      b.style.setProperty('--swatch', paintColor(color, dark));
    });
    styleDot.style.setProperty('--swatch', paintColor(color, dark));
    styleDot.dataset.size = String(size);
    styleDot.dataset.tool = tool;
  }

  /** @param {string} hex */
  function setColor(hex) {
    color = hex;
    remember('scratchColor', hex);
    if (selection.length) commit({ type: 'style', ids: selection, patch: { color: hex } });
    else if (tool === 'eraser' || tool === 'select' || tool === 'hand') setTool('pen');
    if (editor) editor.ta.style.color = paintColor(hex, isDark());
    syncStyle();
    closePop();
  }

  /** @param {0 | 1 | 2} i */
  function setSize(i) {
    size = i;
    remember('scratchSize', i);
    if (selection.length) {
      const items = history.scene.items.filter((it) => selection.includes(it.id));
      const updated = items
        .filter((it) => it.type !== 'image')
        .map((it) => {
          const key = it.type === 'stroke' ? (it.tool === 'hl' ? 'hl' : 'pen') : it.type === 'text' ? 'text' : 'shape';
          return { ...it, size: SCRATCH_SIZES[key][i] };
        });
      commit({ type: 'update', items: updated });
    } else if (tool === 'eraser' || tool === 'select' || tool === 'hand') setTool('pen');
    syncStyle();
    closePop();
  }

  /** @param {string} m */
  function setMode(m) {
    if (!VIEWS.includes(/** @type {any} */ (m))) return;
    const prevFit = fitScale();
    mode = m;
    content.dataset.view = m;
    root?.classList.toggle('is-over', m === 'over');
    handle.el.classList.toggle('is-over', m === 'over');
    remember('scratchView', m);
    if (m === 'split') fillQuestion();
    renderer.setPaper({ mode: m, opacity });
    opacityRow.hidden = m !== 'over';
    // Layout changes size: keep the same relative zoom, re-fit on the next resize.
    requestAnimationFrame(() => {
      resize();
      if (Math.abs(prevFit - fitScale()) > 1e-6) fitWidth();
    });
  }

  /** @param {number} v */
  function setOpacity(v) {
    opacity = Math.min(0.9, Math.max(0, v));
    renderer.setPaper({ mode, opacity });
    content.style.setProperty('--scratch-paper-opacity', String(opacity));
    remember('scratchOpacity', Math.round(opacity * 100) / 100);
  }

  /** @param {string} bg */
  function setBackground(bg) {
    remember('scratchBg', bg);
    commit({ type: 'page', bg });
    if (mode === 'over' && opacity < 0.3) setOpacity(0.5);
  }

  function clearPage() {
    closePop();
    const items = history.scene.items;
    if (!items.length) return;
    const entries = items.map((item, index) => ({ index, item }));
    if (commit({ type: 'clear' })) {
      setSelection([]);
      undoToast('Page cleared', () => {
        const present = new Set(history.scene.items.map((i) => i.id));
        commit({ type: 'insert', entries: entries.filter((e) => !present.has(e.item.id)) });
      });
    }
  }

  /* ---------------- popovers ---------------- */

  /** @type {null | 'style' | 'shapes' | 'more'} */
  let openPop = null;
  const pops = { style: stylePop, shapes: shapesPop, more: morePop };
  const popBtns = { style: styleBtn, shapes: shapesBtn, more: moreBtn };

  /** @param {'style' | 'shapes' | 'more'} name */
  function togglePop(name) {
    if (openPop === name) return closePop(true);
    closePop();
    openPop = name;
    pops[name].hidden = false;
    popBtns[name].setAttribute('aria-expanded', 'true');
    if (name === 'more') opacityRow.hidden = mode !== 'over';
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

  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (!openPop) return;
    const t = /** @type {Node} */ (e.target);
    if (pops[openPop].contains(t) || popBtns[openPop].contains(t)) return;
    closePop();
  };
  content.addEventListener('pointerdown', onOutside, true);

  /* ---------------- selection bar ---------------- */

  /**
   * @param {string} iconEl
   * @param {string} label
   * @param {() => void} onClick
   * @param {string} [action]
   */
  const selButton = (iconEl, label, onClick, action) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'scratch-sel-btn', 'aria-label': label, title: label, dataset: { action: action || '' }, onClick },
        ['trash', 'copy'].includes(iconEl) ? icon(iconEl, { size: 20 }) : glyph(iconEl, 20),
      )
    );
  const editBtn = selButton('text', 'Edit text', () => {
    const it = selectedItems()[0];
    if (it?.type === 'text') openTextEditor(it, { x: it.x, y: it.y });
  }, 'edit');
  const lockBtn = selButton('lock', 'Keep proportions', () => {
    aspectLock = !aspectLock;
    syncSelBar();
  }, 'aspect');
  const frontBtn = selButton('front', 'Bring to front', () => reorder('front'), 'front');
  const backBtn = selButton('back', 'Send to back', () => reorder('back'), 'back');
  const dupBtn = selButton('copy', 'Duplicate', () => duplicate(), 'duplicate');
  const delBtn = selButton('trash', 'Delete', () => deleteSelection(), 'delete');
  delBtn.classList.add('is-danger');
  selBar.append(editBtn, lockBtn, frontBtn, backBtn, dupBtn, delBtn);

  const selectedItems = () => history.scene.items.filter((i) => selection.includes(i.id));

  function syncSelBar() {
    const items = selectedItems();
    const single = items.length === 1 ? items[0] : null;
    editBtn.hidden = single?.type !== 'text';
    lockBtn.hidden = single?.type !== 'image';
    lockBtn.setAttribute('aria-pressed', String(aspectLock));
    lockBtn.replaceChildren(glyph(aspectLock ? 'lock' : 'unlock', 20));
    lockBtn.title = aspectLock ? 'Proportions locked (tap for free resize)' : 'Free resize (tap to keep proportions)';
  }

  function placeSelBar() {
    const items = selectedItems();
    if (!items.length || tools.isBusy() || editor || !vw) {
      selBar.hidden = true;
      return;
    }
    syncSelBar();
    const f = frameFor(items, scale(), renderer.measure);
    if (!f) return;
    const b = unionBounds(items.map((i) => itemBounds(i, { measure: renderer.measure })));
    if (!b) return;
    const s = scale();
    const left = (b.x - pv.x) * s;
    const topPx = (b.y - pv.y) * s;
    const bottom = (b.y + b.h - pv.y) * s;
    selBar.hidden = false;
    const bw = selBar.offsetWidth || 240;
    const bh = selBar.offsetHeight || 52;
    const rotSpace = f.kind === 'image' ? 44 : 14;
    let y = topPx - bh - rotSpace;
    if (y < 8) y = bottom + 14;
    if (y + bh > vh - 8) y = Math.max(8, Math.min(vh - bh - 8, topPx + 14));
    const x = Math.min(Math.max(8, left + (b.w * s) / 2 - bw / 2), Math.max(8, vw - bw - 8));
    selBar.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** @param {'front' | 'back'} where */
  function reorder(where) {
    commit({ type: 'order', ids: reorderIds(history.scene.items, selection, where) });
  }

  function duplicate() {
    const copies = selectedItems().map((it) => cloneItem(it, 40));
    if (commit({ type: 'add', items: copies })) setSelection(copies.map((c) => c.id));
  }

  function deleteSelection() {
    if (!selection.length) return;
    commit({ type: 'remove', ids: selection });
    setSelection([]);
  }

  /* ---------------- text editor ---------------- */

  /** @type {null | { ta: HTMLTextAreaElement, item: import('../scratch/scene.js').TextItem, isNew: boolean }} */
  let editor = null;

  /**
   * @param {import('../scratch/scene.js').TextItem | null} item
   * @param {{ x: number, y: number }} at
   */
  function openTextEditor(item, at) {
    if (editor) commitTextEditor();
    hideHint();
    const fs = SCRATCH_SIZES.text[size];
    const isNew = !item;
    const it = item || /** @type {import('../scratch/scene.js').TextItem} */ (
      makeItem({
        type: 'text',
        x: Math.max(0, at.x - fs * 0.2),
        y: Math.max(0, at.y - fs * 0.8),
        w: Math.max(fs * 4, Math.min(fs * 12, PAGE_W - Math.max(0, at.x) - 20)),
        text: '',
        color,
        size: fs,
      })
    );
    const ta = /** @type {HTMLTextAreaElement} */ (
      h('textarea', {
        class: 'scratch-text-editor',
        'aria-label': 'Text box',
        rows: '1',
        spellcheck: 'true',
        placeholder: 'Type here',
      })
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
        viewport.focus({ preventScroll: true });
      }
    });
    editor = { ta, item: it, isNew };
    if (!isNew) renderer.setHidden([it.id]);
    selBar.hidden = true;
    stage.append(ta);
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
    const s = scale();
    const pad = item.size * TEXT_PAD * s;
    Object.assign(ta.style, {
      left: `${(item.x - pv.x) * s}px`,
      top: `${(item.y - pv.y) * s}px`,
      width: `${item.w * s}px`,
      fontSize: `${item.size * s}px`,
      lineHeight: String(TEXT_LINE),
      padding: `${pad}px`,
      color: paintColor(editor.isNew ? color : item.color, isDark()),
    });
    autosize();
  }

  function commitTextEditor() {
    const e = editor;
    if (!e) return;
    editor = null;
    const text = e.ta.value.replace(/\s+$/, '');
    e.ta.remove();
    renderer.setHidden([]);
    if (e.isNew) {
      if (text.trim()) {
        const it = { ...e.item, text, color };
        commit({ type: 'add', items: [it] });
        setSelection([]);
      }
    } else if (!text.trim()) {
      commit({ type: 'remove', ids: [e.item.id] });
    } else if (text !== e.item.text) {
      commit({ type: 'update', items: [{ ...e.item, text }] });
    }
    tools.refresh();
    placeSelBar();
  }

  /* ---------------- images ---------------- */

  async function chooseImage() {
    closePop();
    const file = await pickImageFile();
    if (file) await addImages([file]);
  }

  /** @param {File[]} files */
  async function addImages(files) {
    if (!files.length || closed) return;
    hideHint();
    const busy = files.length > 0 ? toast(files.length > 1 ? 'Adding pictures…' : 'Adding picture…', { duration: 20000 }) : null;
    /** @type {string[]} */
    const added = [];
    try {
      let offset = 0;
      for (const file of files) {
        try {
          const res = await importImage(file, { qid });
          if (closed) return;
          const s = scale();
          const visible = { x: pv.x, y: pv.y, w: vw / s, h: vh / s };
          const box = insertBox(res.width, res.height, visible, s);
          const item = makeItem({ type: 'image', media: res.id, x: box.x + offset, y: box.y + offset, w: box.w, h: box.h, rot: 0 });
          renderer.primeImage(res.id, res.bitmap || undefined);
          if (commit({ type: 'add', items: [item] })) added.push(item.id);
          offset += 40;
        } catch (err) {
          const msg = err instanceof MediaError ? err.userMessage : "This picture couldn't be added. Please try again.";
          if (!(err instanceof MediaError)) console.warn('[scratchpad] image import failed', err);
          toast(msg, { kind: 'danger', duration: 6000 });
        }
      }
    } finally {
      busy?.close();
    }
    if (added.length) {
      tool = 'select';
      remember('scratchTool', 'select');
      syncTools();
      setSelection(added);
    }
  }

  /** @param {ClipboardEvent} e */
  const onPaste = (e) => {
    if (closed || editor || isEditable(e.target)) return;
    const files = imageFilesFrom(e);
    if (!files.length) return;
    e.preventDefault();
    void addImages(files);
  };
  document.addEventListener('paste', onPaste);
  viewport.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) {
      e.preventDefault();
      viewport.classList.add('is-drop');
    }
  });
  viewport.addEventListener('dragleave', () => viewport.classList.remove('is-drop'));
  viewport.addEventListener('drop', (e) => {
    viewport.classList.remove('is-drop');
    const files = imageFilesFrom(e);
    if (!files.length) return;
    e.preventDefault();
    void addImages(files);
  });

  /* ---------------- export ---------------- */

  async function exportPng() {
    closePop();
    try {
      const canvas = await renderer.renderPage({ width: 1400 });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('encode failed');
      const { saveFile } = await import('../backup.js');
      const safe = qid.replace(/[^A-Za-z0-9_-]/g, '_');
      const how = await saveFile(/** @type {Blob} */ (blob), `scratchpad-${safe}.png`);
      if (how === 'downloaded') toast('Image saved to your downloads.', { kind: 'success' });
    } catch (err) {
      console.warn('[scratchpad] export failed', err);
      toast("The image couldn't be saved. Please try again.", { kind: 'danger' });
    }
  }

  /* ---------------- hint ---------------- */

  let hintTimer = 0;
  function hideHint() {
    if (hint.hidden) return;
    hint.classList.add('is-hidden');
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      hint.hidden = true;
    }, 300);
  }

  /* ---------------- split view ---------------- */

  let questionFilled = false;
  function fillQuestion() {
    if (questionFilled) return;
    questionFilled = true;
    const stem = renderStem(question);
    stem.removeAttribute('data-block');
    const order = Array.isArray(choiceOrder) && choiceOrder.length ? choiceOrder : (question.choices || []).map((c) => c.id);
    const byId = new Map((question.choices || []).map((c) => [c.id, c]));
    const list = h(
      'ol',
      { class: 'scratch-q-choices' },
      order
        .map((id, i) => {
          const c = byId.get(id);
          if (!c) return null;
          return h(
            'li',
            { class: 'scratch-q-choice' },
            h('span', { class: 'scratch-q-letter', 'aria-hidden': 'true' }, String.fromCharCode(65 + i)),
            h('span', { class: 'scratch-q-text' }, renderInline(c.text)),
          );
        })
        .filter(Boolean),
    );
    questionPane.replaceChildren(h('div', { class: 'scratch-q-label' }, 'Question'), stem, list);
  }

  function applySplit() {
    body.style.setProperty('--split', `${Math.round(splitRatio * 1000) / 10}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(splitRatio * 100)));
  }

  function isSideBySide() {
    return getComputedStyle(body).flexDirection === 'row';
  }

  /** @type {null | { id: number }} */
  let dividerDrag = null;
  divider.addEventListener('pointerdown', (e) => {
    dividerDrag = { id: e.pointerId };
    divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  divider.addEventListener('pointermove', (e) => {
    if (!dividerDrag || e.pointerId !== dividerDrag.id) return;
    const r = body.getBoundingClientRect();
    const f = isSideBySide() ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
    splitRatio = Math.min(0.85, Math.max(0.15, f));
    applySplit();
  });
  const endDivider = () => {
    if (!dividerDrag) return;
    dividerDrag = null;
    resize();
  };
  divider.addEventListener('pointerup', endDivider);
  divider.addEventListener('pointercancel', endDivider);
  divider.addEventListener('keydown', (e) => {
    const side = isSideBySide();
    const dec = side ? 'ArrowLeft' : 'ArrowUp';
    const inc = side ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== dec && e.key !== inc) return;
    e.preventDefault();
    splitRatio = Math.min(0.85, Math.max(0.15, splitRatio + (e.key === inc ? 0.05 : -0.05)));
    applySplit();
    resize();
  });

  /* ---------------- keyboard ---------------- */

  /** @param {KeyboardEvent} e */
  function onKeydown(e) {
    if (e.isComposing || isEditable(e.target)) return;
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else if (k === 'd' && selection.length) duplicate();
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey) return;
    if (e.key === 'Escape') {
      if (openPop) closePop(true);
      else if (selection.length) setSelection([]);
      else return; // the sheet closes
      e.preventDefault();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length) {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (e.key === ' ' && /** @type {HTMLElement} */ (e.target)?.tagName !== 'BUTTON') {
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        viewport.dataset.pan = 'true';
      }
      return;
    }
    if (e.target && /** @type {HTMLElement} */ (e.target).closest?.('[role="radiogroup"]') && /^arrow/.test(k)) return;
    const t = /** @type {Record<string, string>} */ (TOOL_KEYS)[k];
    if (t) setTool(t);
    else if (k === 's') setTool(SHAPE_TOOLS.includes(tool) ? SHAPE_TOOLS[(SHAPE_TOOLS.indexOf(tool) + 1) % 4] : lastShape);
    else if (k === 'i') void chooseImage();
    else if (e.key === '+' || e.key === '=') zoomBy(ZOOM_STEP);
    else if (e.key === '-') zoomBy(1 / ZOOM_STEP);
    else if (e.key === '0') fitWidth();
    else return;
    e.preventDefault();
  }
  /** @param {KeyboardEvent} e */
  function onKeyup(e) {
    if (e.key === ' ') {
      spaceDown = false;
      delete viewport.dataset.pan;
    }
  }
  content.addEventListener('keydown', onKeydown);
  content.addEventListener('keyup', onKeyup);

  /* ---------------- saving ---------------- */

  /** @type {ReturnType<typeof setTimeout> | null} */
  let saveTimer = null;
  /** @type {Promise<boolean>} */
  let saveChain = Promise.resolve(true);
  let lastErrorToast = 0;

  function scheduleSave() {
    dirty = true;
    unsaved.set(qid, history.scene);
    saveState.textContent = '';
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flush();
    }, SAVE_DELAY_MS);
  }

  /**
   * Saves now. Resolves true when everything is stored.
   * @returns {Promise<boolean>}
   */
  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveChain = saveChain.then(async () => {
      if (!loaded) return true;
      if (!dirty) return true;
      const scene = history.scene;
      dirty = false;
      try {
        await inkRepo.set(qid, 'scratch', { qversion, strokes: [], scene: serialize(scene) });
        if (history.scene === scene) unsaved.delete(qid);
        if (!closed) saveState.textContent = 'Saved';
        return true;
      } catch (err) {
        dirty = true;
        console.warn('[scratchpad] save failed', err);
        const now = Date.now();
        if (now - lastErrorToast > 8000) {
          lastErrorToast = now;
          toast("Your scratchpad couldn't be saved. Free up some storage space, then tap Retry. Your work stays here.", {
            kind: 'danger',
            duration: 8000,
            action: { label: 'Retry', onClick: () => void flush() },
          });
        }
        return false;
      }
    });
    return saveChain;
  }

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  const onPageHide = () => void flush();
  document.addEventListener('visibilitychange', onHidden);
  globalThis.addEventListener('pagehide', onPageHide);

  /* ---------------- theme ---------------- */

  const themeObserver = new MutationObserver(() => {
    renderer.refresh();
    syncStyle();
    if (editor) placeTextEditor();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---------------- open / close ---------------- */

  /** @type {(v?: void) => void} */
  let resolveClosed = () => {};
  const closedPromise = new Promise((res) => {
    resolveClosed = res;
  });

  const ro = new ResizeObserver(() => resize());

  const handle = sheet({
    title: 'Scratchpad',
    content,
    size: 'full',
    onClose: () => void finalize(),
  });
  handle.el.classList.add('scratch-sheet');
  const root = handle.el.parentElement;
  root?.classList.add('scratch-root');
  root?.classList.toggle('is-over', mode === 'over');
  handle.el.classList.toggle('is-over', mode === 'over');

  async function requestClose() {
    if (closed) return;
    tools.cancel();
    if (editor) commitTextEditor();
    await handle.close('done');
  }

  async function finalize() {
    if (closed) return;
    tools.cancel();
    if (editor) commitTextEditor();
    closed = true;
    ro.disconnect();
    const ok = await flush();
    document.removeEventListener('visibilitychange', onHidden);
    globalThis.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('paste', onPaste);
    themeObserver.disconnect();
    content.removeEventListener('pointerdown', onOutside, true);
    tools.destroy();
    renderer.destroy();
    clearTimeout(hintTimer);
    // Undo history is gone now: images no longer in the scene can go.
    if (ok && loaded) await pruneMedia(qid, mediaIds(history.scene));
    resolveClosed();
  }

  // Initial UI state.
  renderer.setPaper({ mode, opacity });
  content.style.setProperty('--scratch-paper-opacity', String(opacity));
  opacityRow.hidden = mode !== 'over';
  applySplit();
  if (mode === 'split') fillQuestion();
  syncTools();
  syncHistory();
  renderer.setScene(history.scene);
  ro.observe(viewport);
  resize();
  (toolBtns[tool] || shapesBtn).focus({ preventScroll: true });

  // Load the stored scene (or the unsaved one from a failed save).
  void (async () => {
    let scene = null;
    let migrated = false;
    const pending = unsaved.get(qid);
    if (pending) {
      scene = pending;
      migrated = true;
    } else {
      try {
        const rec = await inkRepo.get(qid, 'scratch');
        if (rec && rec.scene && typeof rec.scene === 'object') scene = deserialize(rec.scene, { bg: setting('scratchBg', 'dots') });
        else if (rec && Array.isArray(rec.strokes) && rec.strokes.length) {
          scene = migrateV1(rec.strokes, { bg: setting('scratchBg', 'dots') });
          migrated = true;
        }
      } catch (err) {
        console.warn('[scratchpad] could not load', err);
        toast("Your saved scratchpad couldn't be loaded. Reload the app to try again.", { kind: 'danger' });
      }
    }
    if (closed) return;
    if (scene) history.reset(scene);
    loaded = true;
    bgSeg.value = history.scene.page.bg;
    afterChangeQuiet();
    if (migrated) scheduleSave();
    if (history.scene.items.length) hint.hidden = true;
    content.dataset.ready = 'true';
  })();

  function afterChangeQuiet() {
    renderer.setScene(history.scene);
    syncHistory();
    tools.refresh();
  }

  const result = /** @type {Promise<void> & { close: () => Promise<void> }} */ (closedPromise);
  result.close = async () => {
    await requestClose();
    await closedPromise;
  };
  return result;
}

export { PAGE_W as SCRATCH_WIDTH, PAGE_H as SCRATCH_HEIGHT };
