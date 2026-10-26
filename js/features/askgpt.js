/**
 * "Ask GPT" button (docs/ARCHITECTURE.md §7.10).
 *
 * Opens ChatGPT (the app when installed, else the website) with the question,
 * its choices in the displayed order, the user's answer and the app's answer
 * pre-filled through `https://chatgpt.com/?q=<encoded prompt>`. No API, no
 * key, no cost. ChatGPT is an outside source: a one-time notice says so.
 *
 * - `buildPrompt` / `askGptUrl` are pure (unit-tested in Node).
 * - Opening: `window.open(url, '_blank', 'noopener')`. With `noopener` the
 *   browser never says whether a pop-up blocker stopped it, so every tap
 *   also copies the prompt and shows a toast with an "Open ChatGPT" action
 *   (a fresh tap the browser always allows). The copy also helps when the
 *   ChatGPT app ignores the pre-filled text. If `window.open` throws, the
 *   toast says ChatGPT didn't open.
 * - Offline: the button is disabled and a visible hint says "Needs internet".
 *   It follows `net:change` and the browser's `online`/`offline` events.
 *
 * Importing this module does not touch `document`/`window`.
 *
 * @module features/askgpt
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { getSetting, setSetting } from '../core/settings.js';
import { uid } from '../core/util.js';
import { button, sheet, toast } from '../ui/components.js';
import { inlineToPlain } from './explain/inline.js';

/** ChatGPT address with a pre-filled prompt. */
export const CHATGPT_URL = 'https://chatgpt.com/?q=';
/** Longest prompt put in the URL (characters). */
export const MAX_PROMPT_CHARS = 4000;
/** Longest single choice in the prompt (characters). */
const MAX_CHOICE_CHARS = 400;
/** Letters for choices in display order. */
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const ELLIPSIS = '…';

const INTRO =
  'I am a cardiac surgery resident preparing for the cardiac surgery board exam. ' +
  'Please help me with this multiple-choice question.';
const REQUEST =
  "Please explain concisely why the app's answer is correct and why each of the other choices is wrong. " +
  'Keep it focused on what matters for the board exam.';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Replaces lone UTF-16 surrogates (which `encodeURIComponent` rejects) with U+FFFD.
 * @param {string} s
 * @returns {string}
 */
function wellFormed(s) {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

/**
 * Plain visible text of an inline mini-markup string, whitespace collapsed.
 * @param {unknown} s
 * @returns {string}
 */
function plain(s) {
  let out = '';
  try {
    out = inlineToPlain(s);
  } catch {
    out = typeof s === 'string' ? s : '';
  }
  return wellFormed(String(out ?? '')).replace(/\s+/g, ' ').trim();
}

/**
 * Cuts `s` to at most `max` characters at a word boundary when one is close,
 * never inside a surrogate pair, and adds "…" when it was cut.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncateText(s, max) {
  const text = String(s ?? '');
  if (text.length <= max) return text;
  if (max <= 1) return max === 1 ? ELLIPSIS : '';
  let cut = max - 1;
  const space = text.lastIndexOf(' ', cut);
  if (space > cut * 0.7) cut = space;
  if (/[\uD800-\uDBFF]/.test(text.charAt(cut - 1))) cut -= 1;
  return text.slice(0, cut).replace(/[\s,;:.-]+$/, '') + ELLIPSIS;
}

/**
 * Choices in display order, each with its letter. Unknown ids in
 * `choiceOrder` are ignored; choices it misses are appended in data order.
 * @param {any} question
 * @param {string[] | undefined} choiceOrder
 * @returns {{ id: string, letter: string, text: string }[]}
 */
export function orderedChoices(question, choiceOrder) {
  const choices = Array.isArray(question?.choices) ? question.choices.filter((c) => c && typeof c.id === 'string') : [];
  const byId = new Map(choices.map((c) => [c.id, c]));
  /** @type {any[]} */
  const ordered = [];
  const used = new Set();
  for (const id of Array.isArray(choiceOrder) ? choiceOrder : []) {
    const c = byId.get(id);
    if (c && !used.has(id)) {
      ordered.push(c);
      used.add(id);
    }
  }
  for (const c of choices) if (!used.has(c.id)) ordered.push(c);
  return ordered.map((c, i) => ({ id: c.id, letter: LETTERS[i] ?? String(i + 1), text: plain(c.text) }));
}

/**
 * Builds the ChatGPT prompt: role, the question, lettered choices in the
 * displayed order, the user's answer, the app's correct answer and the
 * request. Inline markup is removed. Long stems and choices are shortened so
 * the whole prompt fits {@link MAX_PROMPT_CHARS}.
 *
 * @param {any} question Question object (§3.3).
 * @param {{ choiceOrder?: string[], userChoice?: string | null }} [context]
 * @returns {string}
 */
export function buildPrompt(question, { choiceOrder, userChoice = null } = {}) {
  const choices = orderedChoices(question, choiceOrder).map((c) => ({
    ...c,
    text: truncateText(c.text, MAX_CHOICE_CHARS),
  }));
  const describe = (/** @type {string | null | undefined} */ id) => {
    const c = choices.find((x) => x.id === id);
    return c ? `${c.letter}. ${c.text}` : null;
  };
  const mine = describe(userChoice);
  const correct = describe(question?.answer);

  const choiceLines = choices.map((c) => `${c.letter}. ${c.text}`).join('\n');
  const answerLines = [
    `My answer: ${mine ?? 'I have not answered yet.'}`,
    correct ? `The app's answer: ${correct}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const build = (/** @type {string} */ stem) =>
    [INTRO, `Question:\n${stem}`, `Choices:\n${choiceLines}`, answerLines, REQUEST].join('\n\n');

  const stem = plain(question?.stem) || '(no question text)';
  const full = build(stem);
  if (full.length <= MAX_PROMPT_CHARS) return full;
  const room = MAX_PROMPT_CHARS - (full.length - stem.length);
  return build(truncateText(stem, Math.max(80, room)));
}

/**
 * The ChatGPT URL for a prompt. A prompt longer than {@link MAX_PROMPT_CHARS}
 * is shortened in the middle: the last paragraph (the request) is kept and
 * the text before it is cut at a word boundary, so the URL stays valid and
 * the question still makes sense. Lone surrogates are replaced so encoding
 * never throws.
 *
 * @param {string} prompt
 * @returns {string} `'https://chatgpt.com/?q=' + encodeURIComponent(prompt)`
 */
export function askGptUrl(prompt) {
  let text = wellFormed(String(prompt ?? ''));
  if (text.length > MAX_PROMPT_CHARS) {
    const split = text.lastIndexOf('\n\n');
    const tail = split > 0 ? text.slice(split) : '';
    if (tail && tail.length < MAX_PROMPT_CHARS / 3) {
      text = truncateText(text.slice(0, split), MAX_PROMPT_CHARS - tail.length) + tail;
    } else {
      text = truncateText(text, MAX_PROMPT_CHARS);
    }
  }
  return CHATGPT_URL + encodeURIComponent(text);
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

/**
 * Copies text to the clipboard: async Clipboard API first, then the old
 * hidden-textarea + `execCommand('copy')` way.
 * @param {string} text
 * @returns {Promise<boolean>} true when copied.
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy way */
  }
  const ta = /** @type {HTMLTextAreaElement} */ (
    h('textarea', {
      class: 'askgpt-copy-buffer',
      readonly: true,
      'aria-hidden': 'true',
      tabindex: '-1',
      style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' },
    })
  );
  ta.value = text;
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  document.body.append(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    active?.focus?.({ preventScroll: true });
  }
}

/**
 * Opens a URL in a new tab/app without giving it access to this page.
 * @param {string} url
 * @returns {boolean} false when the browser refused (threw).
 */
function openExternal(url) {
  try {
    window.open(url, '_blank', 'noopener');
    return true;
  } catch (err) {
    console.warn('[askgpt] window.open failed', err);
    return false;
  }
}

/** Grace period before a detached element counts as removed (it may just be moving). */
const REMOVAL_GRACE_MS = 500;

/**
 * Calls `fn` once `el` has been in the document and then stays out of it for
 * {@link REMOVAL_GRACE_MS}.
 * @param {Element} el
 * @param {() => void} fn
 * @returns {() => void} Stops watching.
 */
function whenRemoved(el, fn) {
  if (typeof MutationObserver !== 'function') return () => {};
  let seen = el.isConnected;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const mo = new MutationObserver(() => {
    if (el.isConnected) {
      seen = true;
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!seen || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (el.isConnected) return;
      mo.disconnect();
      fn();
    }, REMOVAL_GRACE_MS);
  });
  mo.observe(document, { childList: true, subtree: true });
  return () => {
    if (timer) clearTimeout(timer);
    mo.disconnect();
  };
}

/** @returns {boolean} */
function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

/**
 * Creates the "Ask GPT" button with its offline hint.
 *
 * @param {any} question Question object.
 * @param {() => { choiceOrder?: string[], userChoice?: string | null }} getContext
 *   Called on every tap, so the prompt always matches what is on screen.
 * @returns {HTMLElement} `<div class="askgpt">`.
 */
export function createAskGptButton(question, getContext) {
  const hintId = `askgpt-hint-${uid()}`;
  const btn = button({ label: 'Ask GPT', icon: 'sparkles', variant: 'secondary', onClick: onTap });
  btn.classList.add('askgpt-btn');
  btn.setAttribute('aria-describedby', hintId);
  const hint = h('span', { class: 'askgpt-hint', id: hintId });
  const el = h('div', { class: 'askgpt' }, btn, hint);

  let online = isOnline();
  function render() {
    btn.disabled = !online;
    el.classList.toggle('is-offline', !online);
    hint.textContent = online ? 'Opens ChatGPT, an outside source' : 'Needs internet';
  }
  render();

  /** @param {boolean} next */
  const setOnline = (next) => {
    if (next === online) return;
    online = next;
    render();
  };
  const onOnline = () => setOnline(true);
  const onOffline = () => setOnline(false);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  const offs = [
    bus.on('net:change', (payload) => {
      setOnline(payload && typeof payload.online === 'boolean' ? payload.online : isOnline());
    }),
    () => window.removeEventListener('online', onOnline),
    () => window.removeEventListener('offline', onOffline),
  ];
  offs.push(whenRemoved(el, () => {
    for (const off of offs.splice(0)) off();
  }));

  /** @returns {{ prompt: string, url: string }} */
  function prepare() {
    /** @type {any} */
    let ctx = {};
    try {
      ctx = (typeof getContext === 'function' && getContext()) || {};
    } catch (err) {
      console.warn('[askgpt] getContext failed', err);
    }
    const prompt = buildPrompt(question, { choiceOrder: ctx.choiceOrder, userChoice: ctx.userChoice ?? null });
    return { prompt, url: askGptUrl(prompt) };
  }

  /** Must run inside a user tap (pop-up rules). */
  function go() {
    if (!isOnline()) {
      online = false;
      render();
      toast('Ask GPT needs internet. Everything else still works offline.');
      return;
    }
    const { prompt, url } = prepare();
    // Start the copy first, while this page still has focus (the clipboard
    // refuses an unfocused page), then open ChatGPT inside the same tap.
    const copying = copyText(prompt);
    const opened = openExternal(url);
    void copying.then((copied) => {
      let message;
      if (opened) {
        message = copied
          ? "Opening ChatGPT. The question is also copied: if it doesn't appear there, paste it."
          : "Opening ChatGPT. If it didn't open, tap Open ChatGPT.";
      } else {
        message = copied
          ? "ChatGPT didn't open by itself. The question is copied: tap Open ChatGPT and paste it."
          : "ChatGPT didn't open by itself. Tap Open ChatGPT to try again.";
      }
      toast(message, {
        duration: opened ? 6000 : 10000,
        action: { label: 'Open ChatGPT', onClick: () => void openExternal(url) },
      });
    });
  }

  function onTap() {
    if (getSetting('askGptNoticeSeen')) {
      go();
      return;
    }
    showNotice();
  }

  function showNotice() {
    /** @type {{ close: (reason?: string) => Promise<void> } | null} */
    let s = null;
    const cancel = button({ label: 'Cancel', variant: 'ghost', onClick: () => s?.close('cancel') });
    const cont = button({
      label: 'Continue',
      variant: 'primary',
      onClick: () => {
        void setSetting('askGptNoticeSeen', true).catch(() => {});
        go(); // still inside the tap, so the browser allows opening ChatGPT
        void s?.close('continue');
      },
    });
    cont.setAttribute('data-autofocus', '');
    s = sheet({
      title: 'Ask ChatGPT',
      size: 's',
      content: h(
        'div',
        { class: 'askgpt-notice' },
        h('p', null, 'ChatGPT is an outside source and may not match your study sources.'),
        h(
          'ul',
          { class: 'askgpt-notice-list' },
          h('li', null, 'It opens ChatGPT with this question, the choices and your answer.'),
          h('li', null, 'Nothing else from the app is sent.'),
          h('li', null, 'Needs internet.'),
        ),
        h('p', { class: 'askgpt-notice-small' }, 'This note is shown only once.'),
      ),
      actions: [cancel, cont],
    });
  }

  return el;
}
