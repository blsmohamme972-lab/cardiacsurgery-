/**
 * Read aloud with the device's own voices (docs/ARCHITECTURE.md §7.15).
 *
 * Web Speech API `speechSynthesis` only: free, offline, no key, no server.
 * Text never leaves the device.
 *
 * - `pickBestVoice`, `rankVoices`, `questionSpeechText`, `speechText` and
 *   `splitForSpeech` are pure (unit-tested in Node).
 * - `createReader()` speaks a list of chunks one short utterance at a time.
 *   Short utterances avoid the long-utterance cut-off of Chrome (about 15 s)
 *   and iOS; Chrome desktop network voices also get a periodic
 *   pause/resume keep-alive. Pause is implemented as "stop and remember the
 *   chunk" and resume restarts that chunk, because native pause/resume is
 *   unreliable on Android. Voices that load late (iOS, Chrome) are picked up
 *   through `voiceschanged`; speech starts at once inside the tap either way.
 * - `createListenButton()` is the Listen / Pause / Resume + Stop control.
 *   It stops when the question changes (the control leaves the page), the
 *   screen changes (`route:change`) or the app goes to the background, and
 *   is hidden when `speechSynthesis` is missing.
 * - `listEnglishVoices()` / `previewVoice()` are for the Settings voice picker.
 *
 * Only one thing speaks at a time in the whole app: starting a reader or a
 * preview stops the previous one.
 *
 * Importing this module does not touch `document`/`window`.
 *
 * @module features/tts
 */

import { h, svg } from '../core/dom.js';
import { bus } from '../core/events.js';
import { getSetting } from '../core/settings.js';
import { clamp } from '../core/util.js';
import { button, iconButton, toast } from '../ui/components.js';
import { hasIcon, icon } from '../ui/icons.js';
import { inlineToPlain } from './explain/inline.js';

/** Longest utterance (characters); longer chunks are split at sentence/phrase boundaries. */
export const MAX_UTTERANCE_CHARS = 220;
/** Read-aloud speed bounds (setting `ttsRate`). */
export const TTS_RATE_MIN = 0.8;
export const TTS_RATE_MAX = 1.4;
/** Sentence spoken by {@link previewVoice}. */
export const PREVIEW_TEXT = 'This is how your questions will sound.';

/** How long to wait for late voices before giving up (ms). */
const VOICES_WAIT_MS = 2000;
/** Chrome desktop keep-alive period for network voices (ms). */
const KEEPALIVE_MS = 10000;

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Words spoken for arrow characters. */
const ARROW_WORDS = Object.freeze({
  '→': 'leads to',
  '⇒': 'leads to',
  '←': 'comes from',
  '↔': 'and back to',
  '⇔': 'is equivalent to',
  '↑': 'increased',
  '↓': 'decreased',
});
const ARROW_RE = /\s*([→⇒←↔⇔↑↓])\s*/g;

/** Spoken names of callout kinds. */
const CALLOUT_NAMES = Object.freeze({ key: 'Key point', pearl: 'Pearl', pitfall: 'Pitfall', mnemonic: 'Mnemonic' });

/** Voice names that are known high-quality voices (lower-case substrings). */
const QUALITY_NAMES = [
  'google',
  'siri',
  'samantha',
  'alex',
  'ava',
  'allison',
  'susan',
  'tom',
  'daniel',
  'karen',
  'moira',
  'tessa',
  'serena',
  'kate',
  'oliver',
  'evan',
  'nathan',
  'zoe',
  'microsoft aria',
  'microsoft jenny',
  'microsoft guy',
  'microsoft sonia',
  'microsoft ryan',
];
/** Novelty voices (macOS/iOS) that are never a good default (lower-case, whole first word). */
const NOVELTY_NAMES = new Set([
  'albert',
  'bad',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'good',
  'jester',
  'organ',
  'superstar',
  'trinoids',
  'whisper',
  'wobble',
  'zarvox',
  'fred',
  'junior',
  'ralph',
  'kathy',
  'grandma',
  'grandpa',
  'rocko',
  'eddy',
  'flo',
  'reed',
  'sandy',
  'shelley',
  'deranged',
  'hysterical',
  'pipe',
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name?: string, lang?: string, voiceURI?: string, localService?: boolean, default?: boolean }} VoiceLike
 */

/**
 * Normalised BCP-47 language tag, e.g. `"en_us"` → `"en-us"`.
 * @param {unknown} lang
 * @returns {string}
 */
function normLang(lang) {
  return typeof lang === 'string' ? lang.trim().toLowerCase().replace(/_/g, '-') : '';
}

/**
 * True for an English voice (`en`, `en-*`).
 * @param {VoiceLike | null | undefined} v
 * @returns {boolean}
 */
export function isEnglishVoice(v) {
  const lang = normLang(v?.lang);
  return lang === 'en' || lang.startsWith('en-');
}

/**
 * Quality tier of an English voice (higher is better), per §7.15:
 * Premium 6 > Enhanced 5 > Neural/Natural 4 > known quality voices 3 >
 * local en-US/en-GB 2 > any English 1 > novelty voices 0.
 * @param {VoiceLike} v
 * @returns {number}
 */
export function voiceTier(v) {
  const text = `${v?.name ?? ''} ${v?.voiceURI ?? ''}`.toLowerCase();
  const name = String(v?.name ?? '').toLowerCase();
  const lang = normLang(v?.lang);
  const usGb = lang === 'en-us' || lang === 'en-gb';
  if (text.includes('premium')) return 6;
  if (text.includes('enhanced')) return 5;
  if (/\b(neural|natural)\b/.test(text)) return 4;
  if (NOVELTY_NAMES.has(name.split(/[\s(]/)[0])) return 0;
  if (QUALITY_NAMES.some((q) => (q.includes(' ') ? name.includes(q) : new RegExp(`\\b${q}\\b`).test(name)))) return 3;
  if (v?.localService !== false && usGb) return 2;
  return 1;
}

/**
 * English voices only, best first. Ties: on-device voice before network
 * voice, en-US before en-GB before other English, the browser's default
 * voice first, then the original order.
 * @template {VoiceLike} V
 * @param {readonly V[] | null | undefined} voices
 * @returns {V[]}
 */
export function rankVoices(voices) {
  if (!Array.isArray(voices)) return [];
  const langRank = (/** @type {VoiceLike} */ v) => {
    const lang = normLang(v.lang);
    return lang === 'en-us' ? 0 : lang === 'en-gb' ? 1 : 2;
  };
  return voices
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v && isEnglishVoice(v))
    .sort(
      (a, b) =>
        voiceTier(b.v) - voiceTier(a.v) ||
        Number(b.v.localService !== false) - Number(a.v.localService !== false) ||
        langRank(a.v) - langRank(b.v) ||
        Number(Boolean(b.v.default)) - Number(Boolean(a.v.default)) ||
        a.i - b.i,
    )
    .map(({ v }) => v);
}

/**
 * The best English voice: the user's saved voice when it is available and
 * English, else the top of {@link rankVoices}. Never a non-English voice.
 * @template {VoiceLike} V
 * @param {readonly V[] | null | undefined} voices
 * @param {{ preferredURI?: string | null }} [opts]
 * @returns {V | null}
 */
export function pickBestVoice(voices, { preferredURI = null } = {}) {
  if (!Array.isArray(voices)) return null;
  if (preferredURI) {
    const saved = voices.find((v) => v && v.voiceURI === preferredURI && isEnglishVoice(v));
    if (saved) return saved;
  }
  return rankVoices(voices)[0] ?? null;
}

/**
 * Plain spoken text of an inline mini-markup string: markup removed, arrows
 * read as words, whitespace collapsed.
 * @param {unknown} text
 * @returns {string}
 */
export function speechText(text) {
  let out = '';
  try {
    out = inlineToPlain(text);
  } catch {
    out = typeof text === 'string' ? text : '';
  }
  return String(out ?? '')
    .replace(ARROW_RE, (_, a) => ` ${ARROW_WORDS[/** @type {keyof typeof ARROW_WORDS} */ (a)]} `)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ends a phrase with a full stop when it has no closing punctuation, so the
 * voice pauses between parts.
 * @param {string} s
 * @returns {string}
 */
function sentence(s) {
  if (!s) return '';
  return /[.!?:;…]["')\]]*$/.test(s) ? s : `${s}.`;
}

/**
 * Spoken text of one explanation block (§3.4).
 * @param {any} block
 * @returns {string}
 */
function blockSpeech(block) {
  if (!block || typeof block !== 'object') return '';
  /** @type {string[]} */
  const parts = [];
  const add = (/** @type {unknown} */ s) => {
    const t = sentence(speechText(s));
    if (t) parts.push(t);
  };
  switch (block.type) {
    case 'heading':
    case 'p':
      add(block.text);
      break;
    case 'list': {
      const walk = (/** @type {any[]} */ items) => {
        for (const it of Array.isArray(items) ? items : []) {
          if (typeof it === 'string') add(it);
          else if (it && typeof it === 'object') {
            add(it.text);
            walk(it.items);
          }
        }
      };
      walk(block.items);
      break;
    }
    case 'table': {
      add(block.caption);
      const head = Array.isArray(block.head) ? block.head.map(speechText) : [];
      for (const row of Array.isArray(block.rows) ? block.rows : []) {
        if (!Array.isArray(row)) continue;
        const cells = row
          .map((cell, i) => {
            const v = speechText(cell);
            if (!v) return '';
            return head[i] && i > 0 ? `${head[i]}: ${v}` : v;
          })
          .filter(Boolean);
        if (cells.length) parts.push(sentence(cells.join(', ')));
      }
      break;
    }
    case 'flow': {
      add(block.title);
      const steps = Array.isArray(block.steps) ? block.steps : [];
      steps.forEach((step, i) => {
        if (!step || typeof step !== 'object') return;
        if (Array.isArray(step.branches)) {
          const branches = step.branches
            .map((/** @type {any} */ b) => {
              const label = speechText(b?.label);
              const text = speechText(b?.text);
              return label && text ? `${label}: ${text}` : text;
            })
            .filter(Boolean);
          if (branches.length) parts.push(sentence(`${i ? 'Then, either ' : 'Either '}${branches.join(', or ')}`));
          return;
        }
        const label = speechText(step.label);
        const text = speechText(step.text);
        if (!text) return;
        if (i === 0) parts.push(sentence(text));
        else parts.push(sentence(label ? `${label}, leads to ${text}` : `Leads to ${text}`));
      });
      break;
    }
    case 'mindmap': {
      add(block.center);
      for (const br of Array.isArray(block.branches) ? block.branches : []) {
        const text = speechText(br?.text);
        const kids = (Array.isArray(br?.children) ? br.children : []).map(speechText).filter(Boolean);
        if (text && kids.length) parts.push(sentence(`${text}: ${kids.join(', ')}`));
        else if (text) parts.push(sentence(text));
      }
      break;
    }
    case 'callout': {
      const name = CALLOUT_NAMES[/** @type {keyof typeof CALLOUT_NAMES} */ (block.kind)] ?? 'Note';
      const title = speechText(block.title);
      parts.push(sentence(title ? `${name}: ${title}` : name));
      add(block.text);
      for (const it of Array.isArray(block.items) ? block.items : []) add(it);
      break;
    }
    case 'quote': {
      add(block.text);
      const ref = speechText(block.ref);
      if (ref) parts.push(sentence(`Source: ${ref}`));
      break;
    }
    case 'image': {
      const alt = speechText(block.alt);
      if (alt) parts.push(sentence(`Image: ${alt}`));
      add(block.caption);
      break;
    }
    default:
      break;
  }
  return parts.join(' ');
}

/**
 * Ordered utterance chunks for a question: the stem, then "A. …", "B. …" in
 * the displayed order, then (with `includeExplanation`) the correct answer
 * line and one chunk per explanation block. Plain text, arrows read as
 * words, empty parts left out.
 *
 * @param {any} question Question object (§3.3).
 * @param {{ choiceOrder?: string[], includeExplanation?: boolean }} [opts]
 * @returns {string[]}
 */
export function questionSpeechText(question, { choiceOrder, includeExplanation = false } = {}) {
  if (!question || typeof question !== 'object') return [];
  /** @type {string[]} */
  const chunks = [];
  const stem = sentence(speechText(question.stem));
  if (stem) chunks.push(stem);

  const choices = Array.isArray(question.choices) ? question.choices.filter((c) => c && typeof c.id === 'string') : [];
  const byId = new Map(choices.map((c) => [c.id, c]));
  /** @type {any[]} */
  const ordered = [];
  const used = new Set();
  for (const id of Array.isArray(choiceOrder) ? choiceOrder : []) {
    if (byId.has(id) && !used.has(id)) {
      ordered.push(byId.get(id));
      used.add(id);
    }
  }
  for (const c of choices) if (!used.has(c.id)) ordered.push(c);

  /** @type {string | null} */
  let answerLine = null;
  ordered.forEach((c, i) => {
    const letter = LETTERS[i] ?? String(i + 1);
    const text = sentence(speechText(c.text));
    if (text) chunks.push(`${letter}. ${text}`);
    if (c.id === question.answer) answerLine = `The correct answer is ${letter}. ${text}`.trim();
  });

  if (includeExplanation) {
    if (answerLine) chunks.push(answerLine);
    for (const block of Array.isArray(question.explanation) ? question.explanation : []) {
      const t = blockSpeech(block);
      if (t) chunks.push(t);
    }
  }
  return chunks;
}

/**
 * Splits text into utterances of at most `max` characters: at sentence ends
 * first, then at commas/semicolons/colons, then at spaces (a word longer than
 * `max` is cut hard).
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
export function splitForSpeech(text, max = MAX_UTTERANCE_CHARS) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];
  /** @type {string[]} */
  const out = [];
  /**
   * @param {string} s
   * @param {RegExp[]} seps
   */
  const pack = (s, seps) => {
    if (s.length <= max) {
      out.push(s);
      return;
    }
    const [sep, ...rest] = seps;
    if (!sep) {
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      return;
    }
    const pieces = s.split(sep).filter(Boolean);
    let buf = '';
    for (const piece of pieces) {
      const next = buf ? `${buf} ${piece.trim()}` : piece.trim();
      if (next.length <= max) {
        buf = next;
        continue;
      }
      if (buf) out.push(buf);
      if (piece.trim().length > max) {
        pack(piece.trim(), rest);
        buf = '';
      } else {
        buf = piece.trim();
      }
    }
    if (buf) out.push(buf);
  };
  // Keep the separator with the left part: split *after* it.
  pack(clean, [/(?<=[.!?…])\s+/, /(?<=[,;:])\s+/, /\s+/]);
  return out.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Browser: voices
// ---------------------------------------------------------------------------

/**
 * True when the browser can read aloud.
 * @returns {boolean}
 */
export function isTtsSupported() {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.speechSynthesis?.speak === 'function' &&
    typeof window.SpeechSynthesisUtterance === 'function'
  );
}

/** @type {SpeechSynthesisVoice[]} */
let voiceCache = [];
let voicesHooked = false;

/** Reads the current voices and keeps them fresh through `voiceschanged`. */
function primeVoices() {
  if (!isTtsSupported()) return [];
  try {
    const list = speechSynthesis.getVoices();
    if (list.length) voiceCache = list;
  } catch {
    /* some browsers throw before voices exist */
  }
  if (!voicesHooked) {
    voicesHooked = true;
    try {
      speechSynthesis.addEventListener('voiceschanged', () => {
        try {
          const list = speechSynthesis.getVoices();
          if (list.length) voiceCache = list;
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* old WebKit without EventTarget on speechSynthesis */
    }
  }
  return voiceCache;
}

/**
 * The voices, waiting for `voiceschanged` (iOS and Chrome load them late).
 * Resolves with whatever is there after {@link VOICES_WAIT_MS}.
 * @returns {Promise<SpeechSynthesisVoice[]>}
 */
function loadVoices() {
  if (!isTtsSupported()) return Promise.resolve([]);
  const now = primeVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    let done = false;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    let poll;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        speechSynthesis.removeEventListener('voiceschanged', check);
      } catch {
        /* ignore */
      }
      resolve(primeVoices());
    };
    const check = () => {
      if (primeVoices().length) finish();
    };
    try {
      speechSynthesis.addEventListener('voiceschanged', check);
    } catch {
      /* fall back to polling */
    }
    poll = setInterval(check, 250); // Safari sometimes never fires the event
    timer = setTimeout(finish, VOICES_WAIT_MS);
  });
}

/**
 * English voices of this device, best first (for the Settings voice picker).
 * Waits briefly for voices that load late.
 * @returns {Promise<SpeechSynthesisVoice[]>} Empty when read aloud is unsupported or no English voice exists.
 */
export async function listEnglishVoices() {
  return rankVoices(await loadVoices());
}

/**
 * The voice to use now: the saved one (setting `ttsVoice`) or the best English voice.
 * @returns {SpeechSynthesisVoice | null}
 */
function currentVoice() {
  return pickBestVoice(primeVoices(), { preferredURI: getSetting('ttsVoice') ?? null });
}

/** @returns {number} Setting `ttsRate`, clamped. */
function currentRate() {
  const r = Number(getSetting('ttsRate'));
  return clamp(Number.isFinite(r) && r > 0 ? r : 1, TTS_RATE_MIN, TTS_RATE_MAX);
}

/**
 * Stops whatever is speaking in this app (only one speaker at a time).
 * @type {(() => void) | null}
 */
let stopActive = null;

/**
 * @param {() => void} stop
 */
function claimSpeaker(stop) {
  if (stopActive && stopActive !== stop) {
    const prev = stopActive;
    stopActive = null;
    prev();
  }
  stopActive = stop;
}

/**
 * @param {() => void} stop
 */
function releaseSpeaker(stop) {
  if (stopActive === stop) stopActive = null;
}

/** @returns {boolean} Chrome on desktop (network voices there stop after ~15 s without a keep-alive). */
function needsKeepAlive() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Chrome\//.test(ua) && !/Android|Mobile|Edg\//.test(ua);
}

/**
 * Speaks one sample sentence with a voice (Settings "Preview").
 * Stops anything else that is speaking.
 * @param {SpeechSynthesisVoice | null} voice null = the device default English voice.
 * @param {number} [rate] Defaults to the `ttsRate` setting.
 * @returns {Promise<void>} Resolves when the sample ends or is interrupted; rejects with a plain-language Error.
 */
export function previewVoice(voice, rate) {
  if (!isTtsSupported()) return Promise.reject(new Error('Read aloud is not available in this browser.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = () => {
      if (settled) return;
      settled = true;
      try {
        speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
      resolve();
    };
    claimSpeaker(stop);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(PREVIEW_TEXT);
      if (voice) u.voice = voice;
      u.lang = voice?.lang || 'en-US';
      u.rate = clamp(Number.isFinite(Number(rate)) ? Number(rate) : currentRate(), TTS_RATE_MIN, TTS_RATE_MAX);
      u.onend = () => {
        if (settled) return;
        settled = true;
        releaseSpeaker(stop);
        resolve();
      };
      u.onerror = (e) => {
        if (settled) return;
        settled = true;
        releaseSpeaker(stop);
        if (e.error === 'interrupted' || e.error === 'canceled') resolve();
        else reject(new Error("This voice couldn't play. Try another voice, or check your device's text-to-speech settings."));
      };
      speechSynthesis.speak(u);
      if (speechSynthesis.paused) speechSynthesis.resume();
    } catch (err) {
      settled = true;
      releaseSpeaker(stop);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * @typedef {'idle' | 'speaking' | 'paused'} ReaderState
 * @typedef {{
 *   speak: (chunks: string[] | string, opts?: { voice?: SpeechSynthesisVoice | null, rate?: number }) => void,
 *   pause: () => void,
 *   resume: () => void,
 *   stop: () => void,
 *   readonly state: ReaderState,
 *   on: (event: 'state' | 'chunk' | 'error', fn: (payload: any) => void) => () => void,
 * }} Reader
 */

/**
 * Creates a reader that speaks chunks one short utterance at a time.
 *
 * Events: `'state'` (ReaderState), `'chunk'` ({ index, total, text } before
 * each utterance), `'error'` ({ message } in plain language; the reader is
 * idle afterwards). Voice and rate default to the settings at `speak()` time.
 *
 * @returns {Reader}
 */
export function createReader() {
  /** @type {ReaderState} */
  let state = 'idle';
  /** @type {string[]} */
  let queue = [];
  let index = 0;
  /** Bumped on every speak/stop/pause so callbacks of old utterances are ignored. */
  let generation = 0;
  /** @type {SpeechSynthesisVoice | null} */
  let voice = null;
  let voiceExplicit = false;
  let rate = 1;
  let triedFallback = false;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let keepAlive;
  /** @type {Map<string, Set<(payload: any) => void>>} */
  const listeners = new Map();
  /** The current utterance (kept referenced: Safari drops events of collected ones). */
  /** @type {SpeechSynthesisUtterance | null} */
  let current = null;

  /**
   * @param {string} name
   * @param {any} payload
   */
  function emit(name, payload) {
    for (const fn of [...(listeners.get(name) ?? [])]) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[tts] listener failed', err);
      }
    }
  }

  /** @param {ReaderState} next */
  function setState(next) {
    if (state === next) return;
    state = next;
    emit('state', next);
  }

  function stopKeepAlive() {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }

  function cancelSynth() {
    try {
      speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }

  function speakCurrent() {
    const gen = ++generation;
    if (index >= queue.length) {
      finish();
      return;
    }
    if (!voiceExplicit && (!voice || !primeVoices().includes(voice))) voice = currentVoice();
    const text = queue[index];
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || 'en-US';
    u.rate = rate;
    u.onend = () => {
      if (gen !== generation) return;
      index += 1;
      speakCurrent();
    };
    u.onerror = (e) => {
      if (gen !== generation) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return; // we stopped it
      // A network voice fails offline: retry this chunk once with an on-device voice.
      if (!triedFallback && voice && voice.localService === false) {
        triedFallback = true;
        const local = rankVoices(primeVoices()).find((v) => v.localService !== false) ?? null;
        voice = local;
        voiceExplicit = true;
        speakCurrent();
        return;
      }
      console.warn('[tts] speech error', e.error);
      fail(
        e.error === 'not-allowed'
          ? 'Read aloud was blocked. Tap Listen again to start it.'
          : "Read aloud stopped. Check that your device has an English voice installed (Settings > Read aloud).",
      );
    };
    current = u;
    emit('chunk', { index, total: queue.length, text });
    try {
      speechSynthesis.speak(u);
      // A previous native pause (another app part, or the OS) would keep us silent.
      if (speechSynthesis.paused) speechSynthesis.resume();
    } catch (err) {
      console.warn('[tts] speak failed', err);
      fail("Read aloud couldn't start on this device.");
    }
  }

  function finish() {
    generation += 1;
    stopKeepAlive();
    current = null;
    queue = [];
    index = 0;
    releaseSpeaker(stop);
    setState('idle');
  }

  /** @param {string} message */
  function fail(message) {
    cancelSynth();
    finish();
    emit('error', { message });
  }

  function startKeepAlive() {
    stopKeepAlive();
    if (!needsKeepAlive() || !voice || voice.localService !== false) return;
    keepAlive = setInterval(() => {
      if (state !== 'speaking') return;
      try {
        if (speechSynthesis.speaking && !speechSynthesis.paused) {
          speechSynthesis.pause();
          speechSynthesis.resume();
        }
      } catch {
        /* ignore */
      }
    }, KEEPALIVE_MS);
  }

  /**
   * Starts reading `chunks` from the beginning (stops anything else speaking).
   * Call it inside a tap: iOS only allows speech that starts from a user gesture.
   * @param {string[] | string} chunks
   * @param {{ voice?: SpeechSynthesisVoice | null, rate?: number }} [opts]
   */
  function speak(chunks, opts = {}) {
    if (!isTtsSupported()) {
      emit('error', { message: 'Read aloud is not available in this browser.' });
      return;
    }
    const list = (Array.isArray(chunks) ? chunks : [chunks]).flatMap((c) => splitForSpeech(String(c ?? '')));
    generation += 1;
    cancelSynth();
    if (!list.length) {
      finish();
      return;
    }
    claimSpeaker(stop);
    primeVoices();
    queue = list;
    index = 0;
    triedFallback = false;
    voiceExplicit = opts.voice !== undefined;
    voice = voiceExplicit ? opts.voice ?? null : currentVoice();
    rate = clamp(Number.isFinite(Number(opts.rate)) ? Number(opts.rate) : currentRate(), TTS_RATE_MIN, TTS_RATE_MAX);
    setState('speaking');
    startKeepAlive();
    speakCurrent();
  }

  /** Pauses at the current chunk (resume restarts that chunk). */
  function pause() {
    if (state !== 'speaking') return;
    generation += 1;
    stopKeepAlive();
    cancelSynth();
    setState('paused');
  }

  /** Continues from the chunk that was paused. */
  function resume() {
    if (state !== 'paused') return;
    claimSpeaker(stop);
    setState('speaking');
    startKeepAlive();
    speakCurrent();
  }

  /** Stops and forgets the chunks. */
  function stop() {
    if (state === 'idle' && !current) return;
    cancelSynth();
    finish();
  }

  return {
    speak,
    pause,
    resume,
    stop,
    get state() {
      return state;
    },
    on(event, fn) {
      if (typeof fn !== 'function') throw new TypeError('reader.on: listener must be a function');
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
      return () => set?.delete(fn);
    },
  };
}

// ---------------------------------------------------------------------------
// Listen button
// ---------------------------------------------------------------------------

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

/**
 * Speaker icon (falls back to a local drawing until icons.js has "volume").
 * @returns {SVGElement}
 */
function speakerIcon() {
  if (hasIcon('volume')) return icon('volume');
  return svg(
    'svg',
    {
      class: 'icon',
      width: 20,
      height: 20,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('path', { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z' }),
    svg('path', { d: 'M15.5 9a4.2 4.2 0 0 1 0 6' }),
    svg('path', { d: 'M18.3 6.3a8 8 0 0 1 0 11.4' }),
  );
}

/**
 * Creates the Listen control: "Listen" → "Pause" → "Resume", plus "Stop"
 * while reading. Reads the stem and choices in the displayed order, and the
 * answer + explanation once revealed. Uses the `ttsRate` / `ttsVoice`
 * settings. Hidden (empty, `hidden`) when read aloud is unsupported.
 *
 * The element also has `stop()` and `destroy()` for a parent view.
 *
 * @param {any} question Question object.
 * @param {() => { choiceOrder?: string[], revealed?: boolean }} getContext Called on every Listen tap.
 * @returns {HTMLElement & { stop: () => void, destroy: () => void }} `<div class="listen">`.
 */
export function createListenButton(question, getContext) {
  const el = /** @type {HTMLElement & { stop: () => void, destroy: () => void }} */ (
    h('div', { class: 'listen', role: 'group', 'aria-label': 'Read aloud' })
  );
  if (!isTtsSupported()) {
    el.hidden = true;
    el.stop = () => {};
    el.destroy = () => {};
    return el;
  }
  primeVoices();

  const reader = createReader();
  const mainIcon = h('span', { class: 'listen-icon' });
  const mainLabel = h('span', { class: 'btn-label' });
  const main = button({ variant: 'secondary', onClick: onMain });
  main.classList.add('listen-btn');
  main.append(mainIcon, mainLabel);
  const stopBtn = iconButton({ icon: 'stop', label: 'Stop reading', variant: 'secondary', onClick: () => reader.stop() });
  stopBtn.classList.add('listen-stop');
  const progress = h('span', { class: 'listen-progress', 'aria-hidden': 'true' });
  el.append(main, stopBtn, progress);

  function render() {
    const s = reader.state;
    el.dataset.state = s;
    mainIcon.replaceChildren(s === 'speaking' ? icon('pause') : s === 'paused' ? icon('play') : speakerIcon());
    mainLabel.textContent = s === 'speaking' ? 'Pause' : s === 'paused' ? 'Resume' : 'Listen';
    main.setAttribute(
      'aria-label',
      s === 'speaking' ? 'Pause reading' : s === 'paused' ? 'Resume reading' : 'Listen: read this question aloud',
    );
    stopBtn.hidden = s === 'idle';
    if (s === 'idle') progress.textContent = '';
  }

  function onMain() {
    const s = reader.state;
    if (s === 'speaking') return reader.pause();
    if (s === 'paused') return reader.resume();
    /** @type {any} */
    let ctx = {};
    try {
      ctx = (typeof getContext === 'function' && getContext()) || {};
    } catch (err) {
      console.warn('[tts] getContext failed', err);
    }
    const chunks = questionSpeechText(question, {
      choiceOrder: ctx.choiceOrder,
      includeExplanation: Boolean(ctx.revealed),
    });
    if (!chunks.length) {
      toast('There is nothing to read on this question.');
      return;
    }
    reader.speak(chunks);
  }

  const offs = [
    reader.on('state', render),
    reader.on('chunk', ({ index, total }) => {
      progress.textContent = total > 1 ? `${index + 1}/${total}` : '';
    }),
    reader.on('error', ({ message }) => toast(message, { kind: 'danger', duration: 8000 })),
    bus.on('route:change', () => reader.stop()),
  ];
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') reader.stop();
  };
  const onPageHide = () => reader.stop();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  offs.push(
    () => document.removeEventListener('visibilitychange', onVisibility),
    () => window.removeEventListener('pagehide', onPageHide),
  );

  function destroy() {
    reader.stop();
    for (const off of offs.splice(0)) off();
  }
  offs.push(whenRemoved(el, destroy));
  el.stop = () => reader.stop();
  el.destroy = destroy;

  render();
  return el;
}
