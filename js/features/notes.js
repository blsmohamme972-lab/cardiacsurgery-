/**
 * Text note editor for one question (docs/ARCHITECTURE.md §7.8).
 *
 * - Labelled, auto-growing textarea that loads the saved note.
 * - Autosave: 500 ms after the last keystroke, and immediately on blur, when
 *   the page is hidden or closed (`visibilitychange` / `pagehide`), when the
 *   screen changes (`route:change`) and when the editor leaves the document.
 * - A calm "Saved" indicator in a polite live region.
 * - Clearing the text deletes the note (`notesRepo.set` does that).
 * - A failed save keeps the text, says so in plain language and offers
 *   "Try again"; the next keystroke or blur retries too.
 * - The character count appears only from 1,000 characters.
 * - Follows changes made elsewhere (another editor of the same question,
 *   a backup import). Text the user is typing is never replaced: while there
 *   are unsaved keystrokes the user's words win; otherwise the new text is
 *   shown and the caret is kept where it was.
 *
 * The returned element also has `flush(): Promise<void>` (saves a pending
 * change now) and `destroy()` (flushes and removes every listener), for a
 * parent view that manages its own lifecycle. Both are optional: the editor
 * cleans up by itself once it is removed from the document.
 *
 * Importing this module does not touch `document`.
 *
 * @module features/notes
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { notesRepo } from '../core/store/repo.js';
import { debounce, formatNumber, uid } from '../core/util.js';
import { toast } from '../ui/components.js';
import { icon } from '../ui/icons.js';

/** Autosave delay after the last keystroke. */
export const NOTE_SAVE_DELAY_MS = 500;
/** The character count is shown from this length on. */
export const NOTE_COUNT_FROM = 1000;

/** How long "Saved" stays fully visible before it fades to a quiet tick. */
const SAVED_FADE_MS = 2500;

/**
 * Calls `fn` once `el` has been in the document and is then removed.
 * @param {Element} el
 * @param {() => void} fn
 * @returns {() => void} Stops watching.
 */
function whenRemoved(el, fn) {
  if (typeof MutationObserver !== 'function') return () => {};
  let seen = el.isConnected;
  const mo = new MutationObserver(() => {
    if (el.isConnected) {
      seen = true;
    } else if (seen) {
      mo.disconnect();
      fn();
    }
  });
  mo.observe(document, { childList: true, subtree: true });
  return () => mo.disconnect();
}

/**
 * Creates the note editor for a question.
 *
 * @param {string} qid Question id (the note's key).
 * @returns {HTMLElement & { flush: () => Promise<void>, destroy: () => void }} `<section class="note-editor">`.
 */
export function createNoteEditor(qid) {
  if (typeof qid !== 'string' || qid === '') throw new TypeError('createNoteEditor: qid is required');

  const id = `note-${uid()}`;
  const statusId = `${id}-status`;
  const countId = `${id}-count`;

  const textarea = /** @type {HTMLTextAreaElement} */ (
    h('textarea', {
      id,
      class: 'note-input',
      rows: 3,
      placeholder: 'Loading your note…',
      'aria-describedby': `${statusId} ${countId}`,
      'aria-busy': 'true',
      spellcheck: true,
      autocapitalize: 'sentences',
      enterkeyhint: 'enter',
    })
  );
  const statusText = h('span', { class: 'note-status-text' });
  const status = h(
    'p',
    { class: 'note-status', id: statusId, role: 'status', 'aria-live': 'polite', dataset: { state: 'idle' } },
    h('span', { class: 'note-status-icon', 'aria-hidden': 'true' }, icon('check', { size: 16 })),
    statusText,
  );
  const count = h('p', { class: 'note-count', id: countId, hidden: true });

  const el = /** @type {HTMLElement & { flush: () => Promise<void>, destroy: () => void }} */ (
    h(
      'section',
      { class: 'note-editor', dataset: { qid } },
      h('label', { class: 'note-label', for: id }, icon('note', { size: 18 }), h('span', null, 'Your note')),
      textarea,
      h('div', { class: 'note-meta' }, status, count),
    )
  );

  /** Text known to be in storage. */
  let savedText = '';
  let loaded = false;
  let loadFailed = false;
  /** The user typed since the last successful save. */
  let dirty = false;
  /** The last save failed: retry even if the text didn't change since. */
  let dirtyAfterFailure = false;
  /** A failure toast is showing for the current failure streak. */
  let failureShown = false;
  /** Serialises saves so an older write never lands after a newer one. */
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** Saves started by this editor that haven't finished (to ignore our own store:change). */
  let inFlight = 0;
  /** Increments on every external refresh, so a slow read never overwrites a newer one. */
  let refreshSeq = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let fadeTimer = null;
  let disposed = false;

  // ---- UI helpers -------------------------------------------------------

  /**
   * @param {'idle'|'saving'|'saved'|'error'} state
   * @param {string} [message]
   */
  function setStatus(state, message = '') {
    status.dataset.state = state;
    status.classList.remove('is-faded');
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = null;
    statusText.textContent = message;
    if (state === 'saved') {
      fadeTimer = setTimeout(() => status.classList.add('is-faded'), SAVED_FADE_MS);
    }
  }

  function autoGrow() {
    if (!textarea.isConnected) return;
    // Measure from a collapsed height, then grow to fit; keep the page from jumping.
    const scrollY = window.scrollY;
    textarea.style.height = 'auto';
    const cs = getComputedStyle(textarea);
    const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    textarea.style.height = `${textarea.scrollHeight + (Number.isFinite(borders) ? borders : 0)}px`;
    if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY });
  }

  function updateCount() {
    const n = textarea.value.length;
    if (n >= NOTE_COUNT_FROM) {
      count.hidden = false;
      count.textContent = `${formatNumber(n)} characters`;
    } else if (!count.hidden) {
      count.hidden = true;
      count.textContent = '';
    }
  }

  /**
   * Shows `text`, keeping the caret when the editor has focus.
   * @param {string} text
   */
  function showValue(text) {
    const focused = document.activeElement === textarea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = text;
    if (focused) {
      const max = text.length;
      textarea.setSelectionRange(Math.min(start, max), Math.min(end, max));
    }
    updateCount();
    autoGrow();
  }

  // ---- Saving -----------------------------------------------------------

  /**
   * Saves the current text (queued behind any running save).
   * @returns {Promise<void>}
   */
  function saveNow() {
    if (!loaded || loadFailed) return chain;
    chain = chain.then(async () => {
      const text = textarea.value;
      if (text === savedText && !dirtyAfterFailure) {
        dirty = false;
        return;
      }
      if (!disposed) setStatus('saving', 'Saving…');
      inFlight += 1;
      try {
        await notesRepo.set(qid, text);
        savedText = text;
        dirtyAfterFailure = false;
        failureShown = false;
        if (textarea.value === text) dirty = false;
        if (!disposed) setStatus('saved', text.trim() === '' ? 'Note cleared' : 'Saved');
      } catch (err) {
        console.warn('[notes] save failed', err);
        dirtyAfterFailure = true;
        setStatus('error', 'Not saved yet. Your text is still here.');
        if (!failureShown) {
          failureShown = true;
          toast("Your note couldn't be saved. Your device storage may be full. Your text is still here.", {
            kind: 'danger',
            duration: 8000,
            action: { label: 'Try again', onClick: () => void saveNow() },
          });
        }
      } finally {
        inFlight -= 1;
      }
    });
    return chain;
  }
  const scheduleSave = debounce(() => void saveNow(), NOTE_SAVE_DELAY_MS);

  /**
   * Saves a pending change right away.
   * @returns {Promise<void>}
   */
  function flush() {
    if (scheduleSave.pending()) scheduleSave.cancel();
    if (dirty || dirtyAfterFailure) return saveNow();
    return chain;
  }
  el.flush = flush;

  // ---- Loading ----------------------------------------------------------

  async function load() {
    try {
      const rec = await notesRepo.get(qid);
      if (disposed) return;
      savedText = rec && typeof rec.text === 'string' ? rec.text : '';
      loaded = true;
      // Keep anything typed while loading (the user's newest words win).
      if (!dirty) showValue(savedText);
      else void saveNow();
    } catch (err) {
      console.warn('[notes] load failed', err);
      loadFailed = true;
      // Editing now could overwrite a note we couldn't read, so lock it.
      textarea.readOnly = true;
      setStatus('error', "Your saved note couldn't be loaded. Reload the app to try again.");
    } finally {
      textarea.removeAttribute('aria-busy');
      textarea.placeholder = loadFailed ? '' : 'Write a note for this question…';
    }
  }

  /** Shows a change made elsewhere, unless the user has unsaved keystrokes here. */
  async function refreshFromStore() {
    if (!loaded || loadFailed || disposed) return;
    if (dirty || dirtyAfterFailure || inFlight > 0) return; // the user's words win
    const seq = ++refreshSeq;
    try {
      const rec = await notesRepo.get(qid);
      if (seq !== refreshSeq || disposed) return;
      // The user may have typed while we were reading.
      if (dirty || dirtyAfterFailure || inFlight > 0) return;
      const text = rec && typeof rec.text === 'string' ? rec.text : '';
      if (text === savedText && text === textarea.value) return;
      savedText = text;
      showValue(text);
    } catch {
      /* keep what is shown */
    }
  }

  // ---- Events -----------------------------------------------------------

  textarea.addEventListener('input', () => {
    dirty = true;
    autoGrow();
    updateCount();
    if (status.dataset.state === 'saved') setStatus('idle');
    scheduleSave();
  });
  textarea.addEventListener('blur', () => void flush());

  const onPageHide = () => void flush();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);

  /** @type {ResizeObserver | null} */
  let resizeObserver = null;
  let lastWidth = 0;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0;
      if (width !== lastWidth) {
        lastWidth = width;
        autoGrow();
      }
    });
    resizeObserver.observe(textarea);
  }

  /** Cleanups for listeners on window/document/bus. */
  const offs = [
    bus.on('route:change', () => void flush()),
    bus.on('store:change', (payload) => {
      if (payload && payload.store === 'notes' && (payload.key === qid || payload.key == null)) {
        void refreshFromStore();
      }
    }),
    bus.on('settings:change', (payload) => {
      if (payload && payload.key === 'fontScale') requestAnimationFrame(autoGrow);
    }),
    () => window.removeEventListener('pagehide', onPageHide),
    () => document.removeEventListener('visibilitychange', onVisibility),
    () => resizeObserver?.disconnect(),
    whenRemoved(el, () => destroy()),
  ];

  /** Saves what is pending and removes every listener. Idempotent. */
  function destroy() {
    if (disposed) return;
    void flush();
    disposed = true;
    for (const off of offs.splice(0)) off();
    if (fadeTimer) clearTimeout(fadeTimer);
  }
  el.destroy = destroy;

  // Size correctly once in the document (fonts and width are known then).
  requestAnimationFrame(autoGrow);

  void load();
  return el;
}
