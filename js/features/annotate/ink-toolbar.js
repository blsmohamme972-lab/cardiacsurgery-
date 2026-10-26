/**
 * Ink tool palette (docs/ARCHITECTURE.md §7.7 "annotate/ink-toolbar.js").
 *
 * Docked at the bottom above the safe area. Big (44 px) targets: pen,
 * highlighter, eraser, undo, redo, 6 colours, 3 sizes, clear, scratchpad,
 * Done. On phones and iPad portrait the colours, sizes, Clear and Scratchpad
 * live in one small popover (the "style" button shows the current colour
 * and size); from 900 px wide everything sits inline in one row.
 *
 * Remembers the last tool, colour and size in settings (`inkTool`,
 * `inkColor`, `inkSize`) and restores them. Clear is undoable (Undo button
 * and an undo toast), so it never asks "Are you sure?".
 * Keyboard: Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y redo, Esc closes the popover.
 *
 * @module features/annotate/ink-toolbar
 */

import { h } from '../../core/dom.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { icon } from '../../ui/icons.js';
import { iconButton, undoToast } from '../../ui/components.js';
import { INK_COLORS, INK_SIZES, displayColor } from './ink.js';

let toolbarSeq = 0;

/**
 * Saves a setting without ever throwing (storage failures are already logged).
 * @param {string} key
 * @param {any} value
 */
function remember(key, value) {
  setSetting(key, value).catch(() => {});
}

/** @returns {boolean} */
function isDark() {
  return document.documentElement.dataset.theme === 'dark';
}

/**
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isEditable(target) {
  const el = /** @type {HTMLElement | null} */ (target);
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Nearest palette size to a value.
 * @param {number} v
 */
function nearestSize(v) {
  let best = INK_SIZES[0].value;
  for (const s of INK_SIZES) if (Math.abs(s.value - v) < Math.abs(best - v)) best = s.value;
  return best;
}

/**
 * Builds the drawing toolbar for an ink controller.
 *
 * @param {import('./ink.js').InkController} controller
 * @param {object} [opts]
 * @param {() => void} [opts.onDone] "Done" pressed (the caller turns drawing off).
 * @param {() => void} [opts.onScratchpad] Opens the scratchpad; the button is hidden when omitted.
 * @returns {HTMLElement} The toolbar (`role="toolbar"`). Remove it from the DOM to dispose;
 *   it also cleans up when the controller is destroyed.
 */
export function createInkToolbar(controller, { onDone, onScratchpad } = {}) {
  const id = `ink-tb-${++toolbarSeq}`;
  /** @type {(() => void)[]} */
  const offs = [];

  // Restore the last tool, colour and size.
  const savedTool = getSetting('inkTool');
  const savedColor = getSetting('inkColor');
  const savedSize = getSetting('inkSize');
  if (savedTool) controller.setTool(savedTool);
  if (savedColor) controller.setColor(savedColor);
  if (savedSize) controller.setSize(savedSize);

  /* ---------- tools ---------- */

  /** @type {Record<string, HTMLButtonElement>} */
  const toolBtns = {};
  const TOOLS = [
    { tool: 'pen', icon: 'pen', label: 'Pen' },
    { tool: 'hl', icon: 'highlighter', label: 'Highlighter' },
    { tool: 'eraser', icon: 'eraser', label: 'Eraser' },
  ];
  for (const t of TOOLS) {
    const b = iconButton({
      icon: t.icon,
      label: t.label,
      pressed: false,
      onClick: () => {
        controller.setTool(/** @type {any} */ (t.tool));
        remember('inkTool', t.tool);
      },
    });
    b.classList.add('ink-tb-btn');
    b.dataset.tool = t.tool;
    toolBtns[t.tool] = b;
  }

  const undoBtn = iconButton({ icon: 'undo', label: 'Undo', onClick: () => controller.undo() });
  const redoBtn = iconButton({ icon: 'redo', label: 'Redo', onClick: () => controller.redo() });
  undoBtn.classList.add('ink-tb-btn');
  redoBtn.classList.add('ink-tb-btn');

  /* ---------- colours and sizes ---------- */

  /** @type {HTMLButtonElement[]} */
  const colorBtns = INK_COLORS.map((c) => {
    const b = /** @type {HTMLButtonElement} */ (
      h(
        'button',
        {
          type: 'button',
          class: 'ink-swatch',
          'aria-label': c.name,
          title: c.name,
          'aria-pressed': 'false',
          dataset: { color: c.hex },
          onClick: () => {
            controller.setColor(c.hex);
            remember('inkColor', c.hex);
            if (controller.getState().tool === 'eraser') {
              controller.setTool('pen');
              remember('inkTool', 'pen');
            }
            closePanel();
          },
        },
        h('span', { class: 'ink-swatch-dot', 'aria-hidden': 'true' }),
      )
    );
    return b;
  });

  /** @type {HTMLButtonElement[]} */
  const sizeBtns = INK_SIZES.map((s, i) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        {
          type: 'button',
          class: `ink-size ink-size-${i + 1}`,
          'aria-label': s.name,
          title: s.name,
          'aria-pressed': 'false',
          dataset: { size: String(s.value) },
          onClick: () => {
            controller.setSize(s.value);
            remember('inkSize', s.value);
            if (controller.getState().tool === 'eraser') {
              controller.setTool('pen');
              remember('inkTool', 'pen');
            }
            closePanel();
          },
        },
        h('span', { class: 'ink-size-dot', 'aria-hidden': 'true' }),
      )
    ),
  );

  /**
   * A labelled action (label visible in the popover, icon-only inline).
   * @param {string} iconName
   * @param {string} label
   * @param {() => void} onClick
   */
  const action = (iconName, label, onClick) =>
    /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'ink-tb-action', 'aria-label': label, title: label, onClick },
        icon(iconName, { size: 22 }),
        h('span', { class: 'ink-tb-action-label', 'aria-hidden': 'true' }, label),
      )
    );

  const clearBtn = action('trash', 'Clear all', () => {
    closePanel();
    const token = controller.clearAll();
    if (token) undoToast('Drawing cleared', () => controller.undo(token));
  });
  clearBtn.dataset.action = 'clear';

  const scratchBtn =
    typeof onScratchpad === 'function'
      ? action('note', 'Scratchpad', () => {
          closePanel();
          onScratchpad();
        })
      : null;
  if (scratchBtn) scratchBtn.dataset.action = 'scratchpad';

  const panel = h(
    'div',
    { class: 'ink-tb-panel', id: `${id}-panel`, role: 'group', 'aria-label': 'Colour and size' },
    h('div', { class: 'ink-tb-group ink-tb-colors', role: 'group', 'aria-label': 'Colour' }, colorBtns),
    h('div', { class: 'ink-tb-group ink-tb-sizes', role: 'group', 'aria-label': 'Size' }, sizeBtns),
    h('div', { class: 'ink-tb-group ink-tb-actions' }, clearBtn, scratchBtn),
  );

  const styleDot = h('span', { class: 'ink-style-dot', 'aria-hidden': 'true' });
  const styleBtn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        type: 'button',
        class: 'ink-tb-style',
        'aria-label': 'Colour, size and more',
        title: 'Colour, size and more',
        'aria-expanded': 'false',
        'aria-controls': `${id}-panel`,
        onClick: () => (panelOpen ? closePanel() : openPanel()),
      },
      styleDot,
      icon('chevron-up', { size: 16 }),
    )
  );

  const doneBtn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      { type: 'button', class: 'ink-tb-done', onClick: () => onDone?.() },
      icon('check', { size: 20 }),
      h('span', null, 'Done'),
    )
  );

  const bar = h(
    'div',
    {
      class: 'ink-toolbar',
      id,
      role: 'toolbar',
      'aria-label': 'Drawing tools',
      dataset: { open: 'false' },
    },
    h('div', { class: 'ink-tb-group ink-tb-tools', role: 'group', 'aria-label': 'Tool' }, Object.values(toolBtns)),
    h('div', { class: 'ink-tb-group ink-tb-history' }, undoBtn, redoBtn),
    styleBtn,
    panel,
    h('span', { class: 'ink-tb-spacer', 'aria-hidden': 'true' }),
    doneBtn,
  );

  /* ---------- popover ---------- */

  let panelOpen = false;

  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (!bar.contains(/** @type {Node} */ (e.target))) closePanel();
  };

  function openPanel() {
    if (panelOpen) return;
    panelOpen = true;
    bar.dataset.open = 'true';
    styleBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    const current = /** @type {HTMLElement | null} */ (panel.querySelector('[aria-pressed="true"]'));
    (current || colorBtns[0]).focus({ preventScroll: true });
  }

  function closePanel({ restoreFocus = false } = {}) {
    if (!panelOpen) return;
    panelOpen = false;
    bar.dataset.open = 'false';
    styleBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (restoreFocus) styleBtn.focus({ preventScroll: true });
  }

  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelOpen) {
      e.stopPropagation();
      e.preventDefault();
      closePanel({ restoreFocus: true });
    }
  });

  /* ---------- state sync ---------- */

  function syncTool() {
    const { tool, color, size } = controller.getState();
    for (const [t, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(t === tool));
    const dark = isDark();
    const sizeValue = nearestSize(size);
    for (const b of colorBtns) {
      b.setAttribute('aria-pressed', String(b.dataset.color === color));
      b.style.setProperty('--swatch', displayColor(b.dataset.color || '', dark));
    }
    for (const b of sizeBtns) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.size) === sizeValue));
      b.style.setProperty('--swatch', displayColor(color, dark));
    }
    styleDot.style.setProperty('--swatch', displayColor(color, dark));
    styleDot.dataset.size = String(INK_SIZES.findIndex((s) => s.value === sizeValue) + 1);
    styleDot.dataset.tool = tool;
  }

  function syncHistory() {
    undoBtn.disabled = !controller.canUndo();
    redoBtn.disabled = !controller.canRedo();
    clearBtn.disabled = controller.isEmpty();
  }

  offs.push(controller.on('tool', syncTool));
  offs.push(controller.on('change', syncHistory));
  offs.push(controller.on('strokestart', () => closePanel()));
  offs.push(controller.on('destroy', dispose));
  syncTool();
  syncHistory();

  // Theme changes swap the swatch colours.
  const themeObserver = new MutationObserver(syncTool);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  /* ---------- keyboard shortcuts ---------- */

  let wasConnected = false;
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (!bar.isConnected) {
      if (wasConnected) dispose();
      return;
    }
    wasConnected = true;
    if (!(e.ctrlKey || e.metaKey) || e.altKey || isEditable(e.target)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault();
      controller.undo();
    } else if ((k === 'z' && e.shiftKey) || k === 'y') {
      e.preventDefault();
      controller.redo();
    }
  };
  document.addEventListener('keydown', onKey);

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    closePanel();
    for (const off of offs) off();
    themeObserver.disconnect();
    document.removeEventListener('keydown', onKey);
  }

  return bar;
}
