/**
 * User highlights on the stem, choices, choice notes and explanation blocks
 * (docs/ARCHITECTURE.md §7.7, Highlight record §4).
 *
 * - Stored highlights are re-applied to every `[data-block]` element inside
 *   `root` by wrapping text in `<mark class="uhl uhl-<color>" data-hl="<id>">`
 *   (split across text nodes safely; `data-anchor-skip` subtrees, canvases and
 *   other UI chrome are never touched — see `anchor.js`).
 * - Selecting text inside one block (mouse, touch long-press, keyboard) shows a
 *   small floating bar: four colours (the last used one first and marked) and
 *   "Copy". Choosing a colour saves at once. A selection over several blocks is
 *   clipped to the first block.
 * - Tapping (or Enter on) a highlight shows a bar to change its colour, copy it
 *   or remove it (with an Undo toast).
 * - Highlights whose text can no longer be found (the question was edited) are
 *   reported through `onOrphans(list)` instead of being dropped silently.
 *
 * The bar sits below the selection on touch screens (the native iOS/Android
 * selection menu sits above it) and above it with a mouse; it is a toolbar
 * (←/→ move between buttons, Esc closes, Tab from the text jumps into it).
 *
 * Importing this module does not touch `document`.
 *
 * @module features/annotate/highlight
 */

import { h, listen } from '../../core/dom.js';
import { bus } from '../../core/events.js';
import { getSetting, setSetting } from '../../core/settings.js';
import { highlightsRepo } from '../../core/store/repo.js';
import { icon } from '../../ui/icons.js';
import { toast, undoToast } from '../../ui/components.js';
import { makeAnchor, findAnchor, blockText, blockTextNodes, rangeFromOffsets, textOffsetsInElement } from './anchor.js';

/** Highlight colours, in display order (§4). */
export const HIGHLIGHT_COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink']);

/** Human names for the colours (labels). */
const COLOR_NAMES = Object.freeze({ yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink' });

/** Parents where a `<mark>` would be invalid markup (whitespace between cells/items). */
const NO_MARK_PARENTS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'COLGROUP', 'UL', 'OL', 'DL', 'SELECT']);

/** Interactive ancestors: a tap on a highlight inside one keeps its own meaning (e.g. choosing an answer). */
const INTERACTIVE_SEL = 'button, a[href], label, [role="button"], [role="radio"], [role="checkbox"], [role="option"]';

/** Tags whose subtree is never highlightable text. */
const CHROME_TAGS = /^(canvas|svg|input|textarea|select|script|style|template|noscript)$/i;

/** Selector of applied highlight marks. */
const MARK_SEL = 'mark.uhl[data-hl]';

/** Live instances, so {@link highlightSelection} can find the one that owns the selection. */
const instances = new Set();

/** @type {WeakMap<Document, string>} Shared screen-reader hint for focusable highlights, per document. */
const hints = new WeakMap();

/**
 * Id of a hidden "Highlight. Press Enter for options." element (created once per document).
 * @param {Document} doc
 * @returns {string}
 */
function hintId(doc) {
  const known = hints.get(doc);
  if (known && doc.getElementById(known)) return known;
  const id = `uhl-hint-${Math.random().toString(36).slice(2, 8)}`;
  doc.body.append(h('span', { id, hidden: true }, 'Highlight. Press Enter for options.'));
  hints.set(doc, id);
  return id;
}

/**
 * @typedef {import('./anchor.js').Anchor} Anchor
 * @typedef {{ id: string, qid: string, qversion: number, block: string, quote: string, prefix: string,
 *   suffix: string, start: number, color: string, ts: number, updated?: number }} Highlight
 * @typedef {{ el: Element, block: string, start: number, end: number }} Snapshot
 *   A selection clipped to one block, in block-text offsets.
 */

/**
 * @param {unknown} c
 * @returns {string} A valid colour (unknown → yellow).
 */
function validColor(c) {
  return HIGHLIGHT_COLORS.includes(/** @type {string} */ (c)) ? /** @type {string} */ (c) : 'yellow';
}

/** @returns {string} The remembered colour (setting `highlightColor`). */
function rememberedColor() {
  try {
    return validColor(getSetting('highlightColor'));
  } catch {
    return 'yellow';
  }
}

/**
 * Whether `block` still exists in the question data (a block that is merely
 * not rendered yet — e.g. the explanation before answering — is not an orphan).
 * @param {any} q
 * @param {string} block
 * @returns {boolean}
 */
export function blockExists(q, block) {
  if (!q || typeof block !== 'string') return false;
  if (block === 'stem') return true;
  if (block.startsWith('choice-')) {
    const id = block.slice(7);
    return Array.isArray(q.choices) && q.choices.some((c) => c && c.id === id);
  }
  if (block.startsWith('note-')) {
    const id = block.slice(5);
    if (q.choiceNotes && typeof q.choiceNotes === 'object' && Object.hasOwn(q.choiceNotes, id)) return true;
  }
  return Array.isArray(q.explanation) && q.explanation.some((b) => b && b.id === block);
}

/**
 * Trims whitespace off both ends of a block-text span.
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @returns {{ start: number, end: number }}
 */
export function trimSpan(text, start, end) {
  let a = start;
  let b = end;
  while (a < b && /\s/.test(text[a])) a += 1;
  while (b > a && /\s/.test(text[b - 1])) b -= 1;
  return { start: a, end: b };
}

/**
 * A stable signature of the visible state of a list of highlights (ignores
 * timestamps), used to skip needless re-renders after our own writes.
 * @param {Highlight[]} list
 * @returns {string}
 */
function signature(list) {
  return list
    .map((r) => [r.id, r.block, r.start, r.quote, r.prefix, r.suffix, r.color, r.qversion].join('\u0001'))
    .sort()
    .join('\u0002');
}

/**
 * Copies text to the clipboard (async API, then a hidden-textarea fallback).
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const ta = /** @type {HTMLTextAreaElement} */ (
      h('textarea', { 'aria-hidden': 'true', readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } })
    );
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Starts highlights for one rendered question.
 *
 * @param {Element} root Element that contains the question's `[data-block]` elements.
 * @param {{ id: string, version?: number, choices?: any[], choiceNotes?: object, explanation?: any[] }} question
 * @param {{ onOrphans?: (list: Highlight[]) => void }} [opts]
 *   `onOrphans` is called whenever the set of highlights that no longer match changes
 *   (with `[]` once they are all gone again).
 * @returns {{ destroy: () => void, refresh: () => Promise<void> }}
 *   `refresh()` reloads the saved highlights and re-applies them (call it after re-rendering).
 */
export function initHighlights(root, question, { onOrphans } = {}) {
  const qid = question?.id;
  const qversion = Number.isInteger(question?.version) ? /** @type {number} */ (question.version) : 1;
  const doc = root.ownerDocument || document;
  const win = doc.defaultView || window;

  /** @type {Highlight[]} */
  let records = [];
  let destroyed = false;
  let loadGen = 0;
  /** Saves in flight (store reloads wait for them). */
  let pending = 0;
  let orphanSig = '';
  /** @type {'touch' | 'mouse' | 'keyboard'} */
  let lastInput = 'mouse';
  /** @type {(() => void)[]} */
  const offs = [];

  // ---------------------------------------------------------------- bar state
  /** @type {null | { mode: 'create', snap: Snapshot } | { mode: 'edit', id: string, snap?: Snapshot }} */
  let barState = null;
  let barPointer = false;
  /** Selection key the user dismissed with Esc (not shown again until it changes). */
  let dismissedKey = '';
  /** @type {HTMLElement | null} */
  let returnFocus = null;
  /** @type {HTMLElement | null} */
  let bar = null;
  let selTimer = 0;
  let posFrame = 0;

  // ------------------------------------------------------------------ blocks

  /** @returns {Map<string, Element>} Block id → first element with it. */
  function blocks() {
    /** @type {Map<string, Element>} */
    const map = new Map();
    const list = root.matches?.('[data-block]') ? [root, ...root.querySelectorAll('[data-block]')] : root.querySelectorAll('[data-block]');
    for (const el of list) {
      const id = el.getAttribute('data-block');
      if (id && !map.has(id)) map.set(id, el);
    }
    return map;
  }

  /**
   * The `[data-block]` element a node belongs to, inside root and outside UI chrome.
   * @param {Node | null} node
   * @returns {Element | null}
   */
  function blockOf(node) {
    let el = node && node.nodeType === 1 ? /** @type {Element} */ (node) : node?.parentElement ?? null;
    while (el) {
      if (el.hasAttribute('data-block')) return root.contains(el) ? el : null;
      // UI chrome (letter badges, canvases, icons, form fields). A <button> is not a stop: a choice
      // button may wrap the choice's text block.
      if (el.hasAttribute('data-anchor-skip') || CHROME_TAGS.test(el.tagName)) return null;
      el = el.parentElement;
    }
    return null;
  }

  // ------------------------------------------------------------- DOM apply

  /** Removes every applied mark and merges the split text nodes back. */
  function unwrapAll() {
    /** @type {Set<Node>} */
    const parents = new Set();
    for (const m of root.querySelectorAll(MARK_SEL)) {
      const p = m.parentNode;
      if (!p) continue;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      p.removeChild(m);
      parents.add(p);
    }
    for (const p of parents) if (p.isConnected || root.contains(p)) p.normalize();
  }

  /**
   * Wraps `[start, end)` of a block's text in marks for `rec`.
   * @param {Element} el
   * @param {{ start: number, end: number }} span
   * @param {Highlight} rec
   * @returns {HTMLElement[]}
   */
  function wrap(el, span, rec) {
    /** @type {HTMLElement[]} */
    const marks = [];
    const color = validColor(rec.color);
    for (const { node, start: ns } of blockTextNodes(el)) {
      const ne = ns + node.data.length;
      if (ne <= span.start || ns >= span.end) continue;
      const parent = node.parentNode;
      if (!parent || NO_MARK_PARENTS.has(parent.nodeName)) continue;
      const s = Math.max(span.start, ns) - ns;
      const e = Math.min(span.end, ne) - ns;
      if (e <= s) continue;
      let target = node;
      if (e < target.data.length) target.splitText(e);
      if (s > 0) target = target.splitText(s);
      const mark = h('mark', { class: ['uhl', `uhl-${color}`], dataset: { hl: rec.id } });
      parent.insertBefore(mark, target);
      mark.append(target);
      marks.push(mark);
    }
    // One keyboard stop per highlight (not inside interactive elements such as a choice button).
    const first = marks[0];
    if (first && !first.closest(INTERACTIVE_SEL)) {
      first.tabIndex = 0;
      first.setAttribute('aria-describedby', hintId(doc));
    }
    return marks;
  }

  let observer = /** @type {MutationObserver | null} */ (null);
  let applyFrame = 0;

  /** Re-applies the current records to the DOM and reports orphans. */
  function apply() {
    if (destroyed) return;
    observer?.disconnect();
    const activeHl = /** @type {HTMLElement | null} */ (doc.activeElement)?.closest?.(MARK_SEL)?.getAttribute('data-hl') ?? null;
    unwrapAll();
    const map = blocks();
    /** @type {Highlight[]} */
    const orphans = [];
    /** @type {Highlight[]} */
    const heal = [];
    const sorted = records.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const rec of sorted) {
      if (!blockExists(question, rec.block)) {
        orphans.push(rec);
        continue;
      }
      const el = map.get(rec.block);
      if (!el) continue; // block not rendered right now (e.g. explanation before answering)
      const text = blockText(el);
      const span = findAnchor(text, rec);
      if (!span) {
        orphans.push(rec);
        continue;
      }
      wrap(el, span, rec);
      if (rec.qversion !== qversion) heal.push({ ...rec, ...makeAnchor(text, span.start, span.end), qversion });
    }
    if (activeHl) markFor(activeHl)[0]?.focus({ preventScroll: true });
    if (barState?.mode === 'edit') markFor(barState.id).forEach((m) => m.classList.add('is-active'));
    observe();
    reportOrphans(orphans);
    if (heal.length) healRecords(heal);
  }

  /**
   * Quietly moves highlights that survived a question edit to the new version.
   * @param {Highlight[]} list
   */
  async function healRecords(list) {
    for (const next of list) {
      try {
        const saved = await highlightsRepo.update(next);
        records = records.map((r) => (r.id === saved.id ? saved : r));
      } catch (err) {
        console.warn('[highlight] Could not update a highlight to the new question version.', err);
      }
    }
  }

  /** @param {Highlight[]} list */
  function reportOrphans(list) {
    const sig = signature(list);
    if (sig === orphanSig) return;
    orphanSig = sig;
    try {
      onOrphans?.(list.slice());
    } catch (err) {
      console.error('[highlight] onOrphans failed', err);
    }
  }

  /** @param {string} id @returns {HTMLElement[]} */
  function markFor(id) {
    return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(MARK_SEL)].filter((m) => m.getAttribute('data-hl') === id));
  }

  /** Re-apply when other code re-renders blocks inside root (e.g. the explanation appears). */
  function observe() {
    if (destroyed || typeof MutationObserver !== 'function') return;
    if (!observer) {
      observer = new MutationObserver((muts) => {
        if (muts.some(relevantMutation)) scheduleApply();
      });
    }
    observer.observe(root, { childList: true, subtree: true });
  }

  /** @param {MutationRecord} m */
  function relevantMutation(m) {
    for (const n of m.addedNodes) {
      if (n.nodeType === 3) {
        if (blockOf(n)) return true;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = /** @type {Element} */ (n);
      if (el.matches(MARK_SEL) || el.tagName === 'CANVAS' || el.hasAttribute('data-anchor-skip')) continue;
      if (el.matches('[data-block]') || el.querySelector('[data-block]') || blockOf(el)) return true;
    }
    return false;
  }

  function scheduleApply() {
    if (applyFrame) return;
    applyFrame = win.requestAnimationFrame(() => {
      applyFrame = 0;
      apply();
    });
  }

  // ------------------------------------------------------------- loading

  /** Reloads records from storage and re-applies them. */
  async function refresh() {
    if (destroyed || !qid) return;
    const gen = ++loadGen;
    let list;
    try {
      list = await highlightsRepo.byQid(qid);
    } catch (err) {
      console.error('[highlight] Could not load highlights', err);
      if (!destroyed && gen === loadGen) {
        toast('Your highlights could not be loaded. Reload the app to try again.', { kind: 'danger' });
      }
      return;
    }
    if (destroyed || gen !== loadGen) return;
    records = list;
    apply();
  }

  let storeTimer = 0;
  /** A store change from elsewhere (e.g. backup import): reload when it differs from what we show. */
  function onStoreChange(payload) {
    if (!payload || (payload.store !== 'highlights' && payload.store !== '*')) return;
    win.clearTimeout(storeTimer);
    storeTimer = win.setTimeout(async () => {
      if (destroyed) return;
      if (pending > 0) return onStoreChange(payload); // our own save is still settling
      const gen = ++loadGen;
      let list;
      try {
        list = await highlightsRepo.byQid(qid);
      } catch {
        return;
      }
      if (destroyed || gen !== loadGen || pending > 0) return;
      if (signature(list) === signature(records)) {
        records = list;
        return;
      }
      records = list;
      if (barState?.mode === 'edit' && !records.some((r) => r.id === barState?.id)) hideBar();
      apply();
    }, 60);
  }

  // ------------------------------------------------------------- actions

  /**
   * The current selection clipped to the first block it touches, or null.
   * @returns {Snapshot | null}
   */
  function snapshotSelection() {
    const sel = win.getSelection?.();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!range.intersectsNode(root)) return null;
    let el = blockOf(range.startContainer);
    if (!el) {
      // The selection starts outside any block (e.g. on a letter badge): use the first block it covers.
      for (const b of blocks().values()) {
        if (range.intersectsNode(b)) {
          el = b;
          break;
        }
      }
    }
    if (!el) return null;
    const block = el.getAttribute('data-block') || '';
    const { start, end } = textOffsetsInElement(el, range);
    const span = trimSpan(blockText(el), start, end);
    if (span.end <= span.start) return null;
    return { el, block, start: span.start, end: span.end };
  }

  /**
   * The saved highlight that fully contains a snapshot, if any.
   * @param {Snapshot} snap
   * @returns {Highlight | null}
   */
  function containingHighlight(snap) {
    const text = blockText(snap.el);
    for (const rec of records) {
      if (rec.block !== snap.block) continue;
      const span = findAnchor(text, rec);
      if (span && span.start <= snap.start && span.end >= snap.end) return rec;
    }
    return null;
  }

  /** @param {unknown} err */
  function saveFailed(err) {
    console.error('[highlight] Save failed', err);
    const quota = /** @type {any} */ (err)?.name === 'QuotaExceededError';
    toast(
      quota
        ? 'Your device storage is full, so the highlight was not saved. Free some space, then try again.'
        : 'The highlight could not be saved. Please try again.',
      { kind: 'danger' },
    );
  }

  /** @param {string} color */
  function remember(color) {
    if (color === rememberedColor()) return;
    setSetting('highlightColor', color).catch((err) => console.warn('[highlight] Could not remember colour', err));
  }

  /**
   * Saves a new highlight for a snapshot (or recolours the highlight it lies in).
   * @param {Snapshot} snap
   * @param {string} color
   * @returns {Promise<boolean>}
   */
  async function create(snap, color) {
    color = validColor(color);
    remember(color);
    const inside = containingHighlight(snap);
    if (inside) {
      if (inside.color !== color) await recolor(inside.id, color);
      return true;
    }
    const text = blockText(snap.el);
    const anchor = makeAnchor(text, snap.start, snap.end);
    if (!anchor.quote.trim()) return false;
    // Highlights fully covered by the new one are absorbed by it.
    const covered = records.filter((r) => {
      if (r.block !== snap.block) return false;
      const span = findAnchor(text, r);
      return span && span.start >= anchor.start && span.end <= anchor.start + anchor.quote.length;
    });
    const tempId = `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    /** @type {Highlight} */
    const draft = { id: tempId, qid, qversion, block: snap.block, ...anchor, color, ts: Date.now() };
    const coveredIds = new Set(covered.map((r) => r.id));
    records = records.filter((r) => !coveredIds.has(r.id)).concat(draft);
    apply(); // instant feedback
    pending += 1;
    try {
      const { id: _drop, ...data } = draft;
      const saved = await highlightsRepo.add(data);
      records = records.map((r) => (r.id === tempId ? saved : r));
      for (const m of markFor(tempId)) m.dataset.hl = saved.id;
      for (const r of covered) {
        try {
          await highlightsRepo.remove(r.id);
        } catch (err) {
          console.warn('[highlight] Could not merge a covered highlight', err);
        }
      }
      return true;
    } catch (err) {
      records = records.filter((r) => r.id !== tempId).concat(covered);
      apply();
      saveFailed(err);
      return false;
    } finally {
      pending -= 1;
    }
  }

  /**
   * @param {string} id
   * @param {string} color
   */
  async function recolor(id, color) {
    color = validColor(color);
    remember(color);
    const prev = records.find((r) => r.id === id);
    if (!prev || prev.color === color) return;
    records = records.map((r) => (r.id === id ? { ...r, color } : r));
    for (const m of markFor(id)) {
      m.classList.remove(...HIGHLIGHT_COLORS.map((c) => `uhl-${c}`));
      m.classList.add(`uhl-${color}`);
    }
    pending += 1;
    try {
      const saved = await highlightsRepo.update({ ...prev, color });
      records = records.map((r) => (r.id === id ? saved : r));
    } catch (err) {
      records = records.map((r) => (r.id === id ? prev : r));
      apply();
      saveFailed(err);
    } finally {
      pending -= 1;
    }
  }

  /** @param {string} id */
  async function removeHl(id) {
    const prev = records.find((r) => r.id === id);
    if (!prev) return;
    records = records.filter((r) => r.id !== id);
    apply();
    pending += 1;
    try {
      await highlightsRepo.remove(id);
    } catch (err) {
      records = records.concat(prev);
      apply();
      console.error('[highlight] Remove failed', err);
      toast('The highlight could not be removed. Please try again.', { kind: 'danger' });
      return;
    } finally {
      pending -= 1;
    }
    undoToast('Highlight removed', async () => {
      if (destroyed) {
        try {
          await highlightsRepo.update(prev);
        } catch (err) {
          saveFailed(err);
        }
        return;
      }
      records = records.filter((r) => r.id !== id).concat(prev);
      apply();
      pending += 1;
      try {
        const saved = await highlightsRepo.update(prev);
        records = records.map((r) => (r.id === id ? saved : r));
      } catch (err) {
        records = records.filter((r) => r.id !== id);
        apply();
        saveFailed(err);
      } finally {
        pending -= 1;
      }
    });
  }

  // ------------------------------------------------------------- the bar

  /** @param {Event} e */
  function onBarPointerDown(e) {
    // Keep the text selection and focus where they are.
    e.preventDefault();
    barPointer = true;
  }

  function ensureBar() {
    if (bar) return bar;
    bar = h('div', {
      class: 'hl-bar',
      role: 'toolbar',
      'aria-label': 'Highlight options',
      'aria-orientation': 'horizontal',
      'data-anchor-skip': '',
      hidden: true,
      onPointerDown: onBarPointerDown,
      onKeyDown: onBarKeyDown,
    });
    doc.body.append(bar);
    return bar;
  }

  /**
   * Fills the bar for its current mode.
   * @param {string} [current] Colour of the highlight being edited.
   */
  function fillBar(current) {
    const el = ensureBar();
    const last = rememberedColor();
    const editing = barState?.mode === 'edit';
    const order = editing ? HIGHLIGHT_COLORS.slice() : [last, ...HIGHLIGHT_COLORS.filter((c) => c !== last)];
    const swatches = order.map((c) => {
      const isCurrent = editing && c === current;
      const isLast = !editing && c === last;
      const label = editing ? `Change to ${COLOR_NAMES[c].toLowerCase()}` : `Highlight ${COLOR_NAMES[c].toLowerCase()}${isLast ? ' (last used)' : ''}`;
      return h(
        'button',
        {
          type: 'button',
          class: ['hl-swatch', `hl-swatch-${c}`, isLast && 'is-last'],
          'aria-label': label,
          title: label,
          'aria-pressed': editing ? String(isCurrent) : undefined,
          dataset: { color: c },
          onClick: () => onColor(c),
        },
        h('span', { class: 'hl-dot', 'aria-hidden': 'true' }, isCurrent ? icon('check', { size: 16 }) : null),
      );
    });
    const children = [
      ...swatches,
      h('span', { class: 'hl-sep', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'hl-action hl-copy', onClick: onCopy }, 'Copy'),
    ];
    if (editing) {
      children.push(
        h(
          'button',
          { type: 'button', class: 'hl-action hl-remove', 'aria-label': 'Remove highlight', title: 'Remove highlight', onClick: onRemove },
          icon('trash', { size: 20 }),
        ),
      );
    }
    el.replaceChildren(...children);
    const buttons = /** @type {HTMLElement[]} */ ([...el.querySelectorAll('button')]);
    buttons.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
  }

  /** @returns {DOMRect[]} Client rects of what the bar points at. */
  function targetRects() {
    if (!barState) return [];
    if (barState.mode === 'create') {
      const { el, start, end } = barState.snap;
      if (!el.isConnected) return [];
      return [...rangeFromOffsets(el, start, end).getClientRects()].filter((r) => r.width > 0 || r.height > 0);
    }
    return markFor(barState.id).flatMap((m) => [...m.getClientRects()]);
  }

  /** Places the bar next to its target, clamped to the visible viewport. */
  function position() {
    posFrame = 0;
    if (!bar || bar.hidden || !barState) return;
    const rects = targetRects();
    if (rects.length === 0) {
      hideBar();
      return;
    }
    const vv = win.visualViewport;
    const vLeft = vv ? vv.offsetLeft : 0;
    const vTop = vv ? vv.offsetTop : 0;
    const vW = vv ? vv.width : win.innerWidth;
    const vH = vv ? vv.height : win.innerHeight;
    const margin = 8;
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const bw = bar.offsetWidth;
    const bh = bar.offsetHeight;
    // Touch: below, clear of the selection handles, so the native menu (above) stays usable.
    const touch = lastInput === 'touch' && barState.mode === 'create';
    const gapBelow = touch ? 30 : 10;
    const gapAbove = 10;
    const below = bottom + gapBelow;
    const above = top - gapAbove - bh;
    const fitsBelow = below + bh <= vTop + vH - margin;
    const fitsAbove = above >= vTop + margin;
    let y;
    if (touch) y = fitsBelow || !fitsAbove ? below : above;
    else y = fitsAbove || !fitsBelow ? above : below;
    y = Math.min(Math.max(y, vTop + margin), vTop + vH - bh - margin);
    let x = (left + right) / 2 - bw / 2;
    x = Math.min(Math.max(x, vLeft + margin), vLeft + vW - bw - margin);
    bar.style.left = `${Math.round(x)}px`;
    bar.style.top = `${Math.round(y)}px`;
    bar.dataset.side = y >= bottom ? 'below' : 'above';
  }

  function schedulePosition() {
    if (!posFrame) posFrame = win.requestAnimationFrame(position);
  }

  /**
   * @param {{ mode: 'create', snap: Snapshot } | { mode: 'edit', id: string, snap?: Snapshot }} state
   * @param {{ focus?: boolean }} [opts]
   */
  function showBar(state, { focus = false } = {}) {
    for (const m of root.querySelectorAll(`${MARK_SEL}.is-active`)) m.classList.remove('is-active');
    barState = state;
    let current;
    if (state.mode === 'edit') {
      current = records.find((r) => r.id === state.id)?.color;
      markFor(state.id).forEach((m) => m.classList.add('is-active'));
    }
    fillBar(current);
    const el = /** @type {HTMLElement} */ (bar);
    el.dataset.mode = state.mode;
    el.hidden = false;
    position();
    if (focus) {
      returnFocus = /** @type {HTMLElement | null} */ (doc.activeElement);
      /** @type {HTMLElement | null} */ (el.querySelector('button'))?.focus();
    }
  }

  /** @param {{ restoreFocus?: boolean }} [opts] */
  function hideBar({ restoreFocus = false } = {}) {
    for (const m of root.querySelectorAll(`${MARK_SEL}.is-active`)) m.classList.remove('is-active');
    const hadFocus = bar?.contains(doc.activeElement);
    barState = null;
    if (bar) bar.hidden = true;
    if (posFrame) win.cancelAnimationFrame(posFrame);
    posFrame = 0;
    if ((restoreFocus || hadFocus) && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  /** @param {Snapshot} s */
  function snapKey(s) {
    return `${s.block}:${s.start}:${s.end}`;
  }

  /** Shows/hides the bar to match the current selection. */
  function evaluateSelection() {
    selTimer = 0;
    if (destroyed || barPointer) return;
    if (bar && bar.contains(doc.activeElement)) return;
    const snap = snapshotSelection();
    if (!snap) {
      if (barState?.mode === 'create') hideBar();
      dismissedKey = '';
      return;
    }
    if (snapKey(snap) === dismissedKey) return;
    const inside = containingHighlight(snap);
    // A selection inside an existing highlight edits it (the way to reach highlights inside choice buttons).
    if (inside) showBar({ mode: 'edit', id: inside.id, snap });
    else showBar({ mode: 'create', snap });
  }

  function onSelectionChange() {
    if (destroyed) return;
    win.clearTimeout(selTimer);
    // Touch: wait for the handles to settle; mouse/keyboard: respond quickly.
    selTimer = win.setTimeout(evaluateSelection, lastInput === 'touch' ? 350 : 120);
  }

  /** @param {string} color */
  async function onColor(color) {
    const state = barState;
    barPointer = false;
    if (!state) return;
    const restore = bar?.contains(doc.activeElement);
    if (state.mode === 'create') {
      hideBar();
      win.getSelection?.()?.removeAllRanges();
      await create(state.snap, color);
      if (restore) markFor(records[records.length - 1]?.id || '')[0]?.focus({ preventScroll: true });
    } else {
      await recolor(state.id, color);
      if (barState === state) fillBar(color);
      markFor(state.id).forEach((m) => m.classList.add('is-active'));
      if (restore) /** @type {HTMLElement | null} */ (bar?.querySelector(`[data-color="${color}"]`))?.focus();
    }
  }

  async function onCopy() {
    const state = barState;
    barPointer = false;
    if (!state) return;
    const snap = state.snap;
    const text = snap
      ? blockText(snap.el).slice(snap.start, snap.end)
      : (state.mode === 'edit' && records.find((r) => r.id === state.id)?.quote) || '';
    hideBar({ restoreFocus: true });
    if (!text) return;
    const ok = await copyText(text);
    if (ok) toast('Copied', { duration: 1500, kind: 'success' });
    else toast("Couldn't copy. Use your device's Copy option instead.", { kind: 'danger' });
  }

  function onRemove() {
    const state = barState;
    barPointer = false;
    if (!state || state.mode !== 'edit') return;
    const focusAfter = returnFocus?.closest?.('[data-block]') || null;
    hideBar();
    win.getSelection?.()?.removeAllRanges();
    removeHl(state.id);
    if (focusAfter instanceof HTMLElement && focusAfter.tabIndex >= 0) focusAfter.focus({ preventScroll: true });
  }

  /** @param {KeyboardEvent} e */
  function onBarKeyDown(e) {
    if (!bar) return;
    const buttons = /** @type {HTMLElement[]} */ ([...bar.querySelectorAll('button')]);
    const i = buttons.indexOf(/** @type {HTMLElement} */ (doc.activeElement));
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      buttons.forEach((b, j) => (b.tabIndex = j === next ? 0 : -1));
      buttons[next].focus();
    }
  }

  function dismiss() {
    const snap = barState?.snap;
    dismissedKey = snap ? snapKey(snap) : '';
    hideBar({ restoreFocus: true });
  }

  // ------------------------------------------------------------- input wiring

  /** @param {PointerEvent} e */
  function onPointerDownDoc(e) {
    lastInput = e.pointerType === 'mouse' ? 'mouse' : 'touch';
    if (!bar || bar.hidden) return;
    const t = /** @type {Node} */ (e.target);
    if (bar.contains(t)) return;
    if (barState?.mode === 'edit') {
      const m = /** @type {Element} */ (t)?.closest?.(MARK_SEL);
      if (!m || m.getAttribute('data-hl') !== barState.id) hideBar();
    }
  }

  function onPointerUpDoc() {
    if (barPointer) {
      // A tap on the bar that did not end in a click (e.g. moved off): let selection logic resume.
      win.setTimeout(() => (barPointer = false), 0);
    }
  }

  /** @param {KeyboardEvent} e */
  function onKeyDownDoc(e) {
    if (e.key === 'Shift' || e.shiftKey || e.key.startsWith('Arrow')) lastInput = 'keyboard';
    if (!bar || bar.hidden || bar.contains(doc.activeElement)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    } else if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Tab from the selected text jumps into the bar.
      e.preventDefault();
      returnFocus = /** @type {HTMLElement | null} */ (doc.activeElement);
      /** @type {HTMLElement | null} */ (bar.querySelector('button[tabindex="0"]') || bar.querySelector('button'))?.focus();
    }
  }

  /** @param {MouseEvent} e */
  function onRootClick(e) {
    const m = /** @type {Element} */ (e.target)?.closest?.(MARK_SEL);
    if (!m || !root.contains(m)) return;
    const sel = win.getSelection?.();
    if (sel && !sel.isCollapsed) return; // the user is selecting, not tapping
    if (m.closest(INTERACTIVE_SEL)) return; // e.g. a choice button: tapping still chooses
    const id = m.getAttribute('data-hl');
    if (!id || id.startsWith('tmp-')) return;
    returnFocus = /** @type {HTMLElement} */ (m);
    showBar({ mode: 'edit', id }, { focus: e.detail === 0 });
  }

  /** @param {KeyboardEvent} e */
  function onRootKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const m = /** @type {Element} */ (e.target)?.closest?.(MARK_SEL);
    if (!m || m !== e.target) return;
    const id = m.getAttribute('data-hl');
    if (!id || id.startsWith('tmp-')) return;
    e.preventDefault();
    showBar({ mode: 'edit', id }, { focus: true });
    returnFocus = /** @type {HTMLElement} */ (m);
  }

  function onViewportChange() {
    if (bar && !bar.hidden) schedulePosition();
  }

  // ------------------------------------------------------------- start

  const instance = {
    root,
    /** @returns {Snapshot | null} */
    snapshot() {
      return snapshotSelection() || (barState?.mode === 'create' ? barState.snap : null);
    },
    /** @param {Snapshot} snap @param {string} [color] */
    async highlight(snap, color) {
      hideBar();
      win.getSelection?.()?.removeAllRanges();
      return create(snap, color || rememberedColor());
    },
  };

  if (qid) {
    instances.add(instance);
    offs.push(
      bus.on('store:change', onStoreChange),
      listen(doc, 'selectionchange', onSelectionChange),
      listen(doc, 'pointerdown', onPointerDownDoc, true),
      listen(doc, 'pointerup', onPointerUpDoc, true),
      listen(doc, 'pointercancel', onPointerUpDoc, true),
      listen(doc, 'keydown', onKeyDownDoc, true),
      listen(root, 'click', onRootClick),
      listen(root, 'keydown', onRootKeyDown),
      listen(win, 'scroll', onViewportChange, { capture: true, passive: true }),
      listen(win, 'resize', onViewportChange),
    );
    if (win.visualViewport) {
      offs.push(
        listen(win.visualViewport, 'resize', onViewportChange),
        listen(win.visualViewport, 'scroll', onViewportChange),
      );
    }
    refresh();
  } else {
    console.warn('[highlight] initHighlights needs a question with an id; highlights are off.');
  }

  return {
    refresh,
    destroy() {
      if (destroyed) return;
      hideBar();
      destroyed = true;
      instances.delete(instance);
      offs.splice(0).forEach((off) => off());
      observer?.disconnect();
      observer = null;
      win.clearTimeout(selTimer);
      win.clearTimeout(storeTimer);
      if (applyFrame) win.cancelAnimationFrame(applyFrame);
      bar?.remove();
      bar = null;
    },
  };
}

/**
 * One-tap "Highlight" (e.g. the player's bottom-bar button): highlights the
 * current text selection — or the one the floating bar is showing for — in
 * `color` (default: the last used colour). Resolves `false` when no question
 * on screen has selected text, so the caller can show a hint such as
 * "Select some text first".
 * @param {string} [color] 'yellow' | 'green' | 'blue' | 'pink'
 * @returns {Promise<boolean>}
 */
export async function highlightSelection(color) {
  for (const inst of instances) {
    const snap = inst.snapshot();
    if (snap) return inst.highlight(snap, color ? validColor(color) : undefined);
  }
  return false;
}
