/**
 * Voice notes: record, list, play and delete short audio notes per question
 * (docs/ARCHITECTURE.md §7.9). Audio stays on the device (IndexedDB through
 * `voiceRepo`) and plays offline.
 *
 * - `createRecorder()` wraps `getUserMedia` + `MediaRecorder` with a mime
 *   preference (`audio/webm;codecs=opus`, `audio/mp4`, `audio/webm`, browser
 *   default), a 5-minute auto-stop and a live input level (AnalyserNode).
 *   The microphone is released on stop, cancel and failure.
 * - `createVoiceNotes(qid)` is the UI: a big record button, live timer and
 *   level meter while recording, Stop / Cancel, and the list of notes with
 *   play/pause, scrubber, duration, date and delete (Undo restores).
 *   Permission denied, no microphone, busy microphone and unsupported
 *   browsers get plain-language help with a next step.
 * - Never lose work: leaving the screen, hiding the app or removing the
 *   element while recording stops and **saves** the recording; a failed save
 *   keeps the audio in memory and offers "Try again".
 * - Only one voice note plays at a time in the whole app. Object URLs are
 *   revoked as soon as they are no longer needed.
 *
 * Importing this module does not touch `document`/`window`.
 *
 * @module features/voice
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { mergeStore, voiceRepo } from '../core/store/repo.js';
import { formatDate, formatDuration, formatRelative, uid } from '../core/util.js';
import { button, iconButton, toast, undoToast } from '../ui/components.js';
import { icon } from '../ui/icons.js';

/** Longest recording; the recorder stops itself at this length. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
/** Recordings shorter than this are not saved (an accidental tap). */
export const MIN_RECORDING_MS = 600;
/** The timer turns to a warning color this long before the limit. */
const WARN_BEFORE_MS = 30 * 1000;
/** Mime types tried in order; the browser default is used when none is supported. */
export const MIME_PREFERENCE = Object.freeze(['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']);
/** Audio bitrate: speech stays clear and 5 minutes stay around 2.4 MB. */
const AUDIO_BITS_PER_SECOND = 64000;

/** Grace period before a detached element counts as removed (it may just be moving). */
const REMOVAL_GRACE_MS = 500;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Recording failure with a plain-language message.
 * `code`: 'unsupported' | 'denied' | 'no-mic' | 'busy' | 'insecure' | 'empty' | 'busy-recorder' | 'aborted' | 'failed'.
 */
export class VoiceError extends Error {
  /**
   * @param {string} code
   * @param {string} userMessage
   * @param {unknown} [cause]
   */
  constructor(code, userMessage, cause) {
    super(userMessage);
    this.name = 'VoiceError';
    this.code = code;
    this.userMessage = userMessage;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Maps a getUserMedia / MediaRecorder error to a VoiceError.
 * @param {any} err
 * @returns {VoiceError}
 */
function toVoiceError(err) {
  if (err instanceof VoiceError) return err;
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return new VoiceError('denied', 'Microphone access is blocked.', err);
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return new VoiceError('no-mic', 'No microphone was found.', err);
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return new VoiceError('busy', 'The microphone is busy or not working.', err);
  }
  return new VoiceError('failed', "Recording couldn't start.", err);
}

// ---------------------------------------------------------------------------
// Support + mime
// ---------------------------------------------------------------------------

/**
 * True when this browser can record audio (`getUserMedia` + `MediaRecorder`,
 * which also need a secure context).
 * @returns {boolean}
 */
export function isVoiceSupported() {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder === 'function'
  );
}

/**
 * The first supported mime type of {@link MIME_PREFERENCE}, or '' (browser default).
 * @param {(type: string) => boolean} [isTypeSupported]
 * @returns {string}
 */
export function pickMimeType(isTypeSupported) {
  const test =
    isTypeSupported ??
    ((/** @type {string} */ t) =>
      typeof MediaRecorder === 'function' && typeof MediaRecorder.isTypeSupported === 'function'
        ? MediaRecorder.isTypeSupported(t)
        : false);
  for (const type of MIME_PREFERENCE) {
    try {
      if (test(type)) return type;
    } catch {
      /* keep trying */
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/**
 * @typedef {{ blob: Blob, mime: string, durationMs: number }} Recording
 * @typedef {'idle' | 'starting' | 'recording' | 'stopping'} RecorderState
 * @typedef {{
 *   start: () => Promise<void>,
 *   stop: () => Promise<Recording>,
 *   cancel: () => void,
 *   readonly state: RecorderState,
 *   readonly elapsedMs: number,
 *   onLevel: (fn: (level: number) => void) => () => void,
 * }} Recorder
 */

/**
 * Creates a one-shot audio recorder.
 *
 * - `start()` asks for the microphone (rejects with {@link VoiceError}).
 * - `stop()` resolves with `{ blob, mime, durationMs }` (the same promise when called twice).
 * - `cancel()` throws the recording away. Both release the microphone.
 * - `onLevel(fn)` receives the input level 0–1 about 30 times a second.
 * - At `maxMs` the recorder stops itself and calls `onAutoStop(promise)`;
 *   it also stops when the microphone goes away (`onAutoStop` too).
 *
 * @param {{ maxMs?: number, onAutoStop?: (result: Promise<Recording>) => void }} [opts]
 * @returns {Recorder}
 */
export function createRecorder({ maxMs = MAX_RECORDING_MS, onAutoStop } = {}) {
  /** @type {RecorderState} */
  let state = 'idle';
  /** @type {MediaStream | null} */
  let stream = null;
  /** @type {MediaRecorder | null} */
  let recorder = null;
  /** @type {Blob[]} */
  let chunks = [];
  let mime = '';
  let startedAt = 0;
  let stoppedAt = 0;
  /** @type {Promise<Recording> | null} */
  let stopPromise = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let maxTimer;
  /** @type {AudioContext | null} */
  let audioCtx = null;
  let raf = 0;
  /** @type {Set<(level: number) => void>} */
  const levelListeners = new Set();
  let cancelled = false;

  function releaseLevel() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (audioCtx) {
      const ctx = audioCtx;
      audioCtx = null;
      ctx.close().catch(() => {});
    }
  }

  /** Stops every track so the browser's "recording" indicator goes away. */
  function release() {
    clearTimeout(maxTimer);
    maxTimer = undefined;
    releaseLevel();
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
      stream = null;
    }
  }

  function startLevel() {
    if (!stream) return;
    const Ctx = /** @type {typeof AudioContext | undefined} */ (
      window.AudioContext || /** @type {any} */ (window).webkitAudioContext
    );
    if (!Ctx) return;
    try {
      audioCtx = new Ctx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      let last = 0;
      const tick = (/** @type {number} */ t) => {
        raf = requestAnimationFrame(tick);
        if (t - last < 33 || levelListeners.size === 0) return;
        last = t;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        // RMS of speech is small; a square root + gain spreads it over 0–1.
        const level = Math.min(1, Math.sqrt(Math.sqrt(sum / data.length)) * 1.6);
        for (const fn of levelListeners) {
          try {
            fn(level);
          } catch (err) {
            console.error('[voice] level listener failed', err);
          }
        }
      };
      raf = requestAnimationFrame(tick);
    } catch (err) {
      console.warn('[voice] level meter unavailable', err);
      releaseLevel();
    }
  }

  function autoStop() {
    if (state !== 'recording') return;
    const p = stop();
    if (typeof onAutoStop === 'function') onAutoStop(p);
    else p.catch(() => {});
  }

  /**
   * Asks for the microphone and starts recording.
   * @returns {Promise<void>}
   */
  async function start() {
    if (state !== 'idle') throw new VoiceError('busy-recorder', 'A recording is already running.');
    if (!isVoiceSupported()) {
      throw new VoiceError(
        typeof window !== 'undefined' && window.isSecureContext === false ? 'insecure' : 'unsupported',
        "Voice notes aren't available in this browser.",
      );
    }
    state = 'starting';
    cancelled = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      state = 'idle';
      throw toVoiceError(err);
    }
    if (cancelled) {
      release();
      state = 'idle';
      throw new VoiceError('aborted', 'Recording was cancelled.');
    }
    mime = pickMimeType();
    try {
      try {
        recorder = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}),
          audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        });
      } catch {
        recorder = new MediaRecorder(stream); // option not accepted: use the browser default
      }
      chunks = [];
      recorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      });
      // A timeslice keeps data flowing, so little is lost if the page dies mid-recording.
      recorder.start(1000);
    } catch (err) {
      release();
      recorder = null;
      state = 'idle';
      throw toVoiceError(err);
    }
    startedAt = performance.now();
    stoppedAt = 0;
    state = 'recording';
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', autoStop);
    maxTimer = setTimeout(autoStop, Math.max(1000, maxMs));
    startLevel();
  }

  /**
   * Stops and returns the recording.
   * @returns {Promise<Recording>}
   */
  function stop() {
    if (stopPromise) return stopPromise;
    if (state === 'starting') {
      cancelled = true;
      return Promise.reject(new VoiceError('aborted', 'Recording was cancelled.'));
    }
    if (state !== 'recording' || !recorder) {
      return Promise.reject(new VoiceError('failed', 'Nothing is being recorded.'));
    }
    state = 'stopping';
    stoppedAt = performance.now();
    const rec = recorder;
    stopPromise = new Promise((resolve, reject) => {
      const done = () => {
        release();
        recorder = null;
        state = 'idle';
        stopPromise = null;
        const type = rec.mimeType || mime || chunks[0]?.type || 'audio/webm';
        const blob = new Blob(chunks, { type });
        chunks = [];
        if (blob.size === 0) {
          reject(new VoiceError('empty', 'Nothing was recorded.'));
          return;
        }
        resolve({ blob, mime: type, durationMs: Math.round(stoppedAt - startedAt) });
      };
      rec.addEventListener('stop', done, { once: true });
      rec.addEventListener(
        'error',
        (e) => {
          release();
          recorder = null;
          state = 'idle';
          stopPromise = null;
          reject(toVoiceError(/** @type {any} */ (e).error || e));
        },
        { once: true },
      );
      try {
        if (rec.state !== 'inactive') rec.stop();
        else done();
      } catch (err) {
        release();
        recorder = null;
        state = 'idle';
        stopPromise = null;
        reject(toVoiceError(err));
      }
    });
    return stopPromise;
  }

  /** Throws the recording away and releases the microphone. */
  function cancel() {
    cancelled = true;
    if (recorder) {
      const rec = recorder;
      recorder = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* ignore */
      }
    }
    chunks = [];
    release();
    stopPromise = null;
    if (state !== 'starting') state = 'idle';
  }

  return {
    start,
    stop,
    cancel,
    get state() {
      return state;
    },
    get elapsedMs() {
      if (!startedAt) return 0;
      return Math.max(0, Math.round((stoppedAt || performance.now()) - startedAt));
    },
    onLevel(fn) {
      if (typeof fn !== 'function') throw new TypeError('onLevel: listener must be a function');
      levelListeners.add(fn);
      return () => levelListeners.delete(fn);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared playback (one voice note at a time in the whole app)
// ---------------------------------------------------------------------------

/** @type {(() => void) | null} */
let stopOtherPlayback = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calls `fn` once `el` has been in the document and then stays out of it for
 * {@link REMOVAL_GRACE_MS} (a quick move between containers is not a removal).
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
 * Help shown for a recording problem: what happened and what to do next.
 * @param {VoiceError} err
 * @returns {{ title: string, steps: string[] }}
 */
function helpFor(err) {
  switch (err.code) {
    case 'denied':
      return {
        title: 'Microphone access is blocked, so voice notes can’t record.',
        steps: [
          'iPhone/iPad: open the Settings app > Safari > Microphone > Allow (or, in Safari, tap “aA” > Website Settings > Microphone > Allow).',
          'Android: in Chrome tap the icon left of the address > Permissions > Microphone > Allow. For the installed app: long-press its icon > App info > Permissions > Microphone.',
          'Then tap Record again.',
        ],
      };
    case 'no-mic':
      return {
        title: 'No microphone was found.',
        steps: ['Connect a microphone or headset, or check that it is switched on.', 'Then tap Record again.'],
      };
    case 'busy':
      return {
        title: 'The microphone is being used by another app or isn’t working.',
        steps: ['Close other apps that may be using it (calls, video, recorders).', 'Then tap Record again.'],
      };
    case 'insecure':
    case 'unsupported':
      return {
        title: 'Voice notes aren’t available in this browser.',
        steps: [
          'iPhone/iPad: use Safari (iOS 14.5 or later). Android: use Chrome.',
          'Your saved voice notes can still be played here.',
        ],
      };
    default:
      return {
        title: 'Recording couldn’t start.',
        steps: ['Tap Record to try again. If it keeps failing, reload the app.'],
      };
  }
}

/**
 * Plain-language length, e.g. "1 minute 5 seconds" (for screen readers).
 * @param {number} ms
 * @returns {string}
 */
function spokenDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const parts = [];
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/**
 * @typedef {import('../core/store/repo.js').VoiceNote} VoiceNote
 * @typedef {{ rec: VoiceNote, el: HTMLElement, playBtn: HTMLButtonElement, range: HTMLInputElement,
 *   time: HTMLElement, durationMs: number, pendingSeekMs: number }} Item
 */

/**
 * Creates the voice notes section for a question.
 *
 * The element also has `destroy()` (stops recording and saves it, stops
 * playback, removes listeners). It cleans up by itself once removed from the
 * document.
 *
 * @param {string} qid Question id.
 * @returns {HTMLElement & { destroy: () => void }} `<section class="voice-notes">`.
 */
export function createVoiceNotes(qid) {
  if (typeof qid !== 'string' || qid === '') throw new TypeError('createVoiceNotes: qid is required');

  const labelId = `voice-label-${uid()}`;
  const supported = isVoiceSupported();

  // ---- Recorder area ----------------------------------------------------
  const recordBtn = button({
    label: 'Record',
    icon: 'mic',
    variant: 'primary',
    size: 'l',
    onClick: () => void startRecording(),
    ariaLabel: 'Record a voice note',
  });
  recordBtn.classList.add('voice-record');
  const recordHint = h('p', { class: 'voice-record-hint' }, 'Up to 5 minutes. Stays on this device.');

  const dot = h('span', { class: 'voice-dot', 'aria-hidden': 'true' });
  const timer = h('span', { class: 'voice-timer', role: 'timer', 'aria-live': 'off' }, '0:00');
  const limit = h('span', { class: 'voice-limit' }, `/ ${formatDuration(MAX_RECORDING_MS)}`);
  const meterFill = h('span', { class: 'voice-meter-fill' });
  const meter = h('span', { class: 'voice-meter', 'aria-hidden': 'true' }, meterFill);
  const stopBtn = button({
    label: 'Stop',
    icon: 'stop',
    variant: 'danger',
    size: 'l',
    onClick: () => void stopRecording('user'),
    ariaLabel: 'Stop and save the recording',
  });
  stopBtn.classList.add('voice-stop');
  const cancelBtn = iconButton({ icon: 'close', label: 'Cancel recording', onClick: () => cancelRecording() });
  cancelBtn.classList.add('voice-cancel');
  const live = h(
    'div',
    { class: 'voice-live', hidden: true },
    h('div', { class: 'voice-live-row' }, dot, h('span', { class: 'voice-live-label' }, 'Recording'), timer, limit),
    meter,
    h('div', { class: 'voice-live-actions' }, cancelBtn, stopBtn),
  );
  const idle = h('div', { class: 'voice-idle' }, recordBtn, recordHint);

  const helpTitle = h('p', { class: 'voice-help-title' });
  const helpSteps = h('ul', { class: 'voice-help-steps' });
  const help = h(
    'div',
    { class: 'voice-help', hidden: true },
    h('span', { class: 'voice-help-icon', 'aria-hidden': 'true' }, icon('alert', { size: 20 })),
    h('div', { class: 'voice-help-body' }, helpTitle, helpSteps),
  );
  const announcer = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

  // ---- List -------------------------------------------------------------
  const list = h('ul', { class: 'voice-list', 'aria-labelledby': labelId });
  const empty = h('p', { class: 'voice-empty', hidden: true }, 'No voice notes yet.');
  const countEl = h('span', { class: 'voice-count' });

  const el = /** @type {HTMLElement & { destroy: () => void }} */ (
    h(
      'section',
      { class: 'voice-notes', 'aria-labelledby': labelId, dataset: { qid } },
      h(
        'p',
        { class: 'voice-label', id: labelId },
        icon('mic', { size: 18 }),
        h('span', null, 'Voice notes'),
        countEl,
      ),
      supported ? h('div', { class: 'voice-recorder' }, idle, live) : null,
      help,
      list,
      empty,
      announcer,
    )
  );

  /** @type {Map<string, Item>} */
  const items = new Map();
  let disposed = false;
  /** @type {Recorder | null} */
  let recorder = null;
  /** @type {(() => void) | null} */
  let offLevel = null;
  let tickTimer = 0;
  /** A finished recording that couldn't be saved yet (kept for "Try again"). */
  /** @type {Recording | null} */
  let unsaved = null;

  // ---- Playback state ---------------------------------------------------
  /** @type {HTMLAudioElement | null} */
  let audio = null;
  /** @type {Item | null} */
  let playing = null;
  /** @type {string | null} */
  let objectUrl = null;
  let playRaf = 0;

  /** @param {string} text */
  function announce(text) {
    announcer.textContent = '';
    // A fresh text node makes screen readers announce repeated messages too.
    requestAnimationFrame(() => {
      announcer.textContent = text;
    });
  }

  /**
   * @param {VoiceError | null} err
   * @param {{ alert?: boolean }} [opts] alert: announce it now (a problem the user just ran into).
   */
  function showHelp(err, { alert = true } = {}) {
    if (!err) {
      help.hidden = true;
      help.removeAttribute('role');
      return;
    }
    if (alert) help.setAttribute('role', 'alert');
    else help.removeAttribute('role');
    const { title, steps } = helpFor(err);
    helpTitle.textContent = title;
    helpSteps.replaceChildren(...steps.map((s) => h('li', null, s)));
    help.hidden = false;
  }

  if (!supported) showHelp(new VoiceError('unsupported', ''), { alert: false });

  // ---- Recording --------------------------------------------------------

  /** @param {boolean} on */
  function setRecordingUi(on) {
    idle.hidden = on;
    live.hidden = !on;
    el.classList.toggle('is-recording', on);
    if (!on) {
      timer.textContent = '0:00';
      timer.classList.remove('is-warning');
      meterFill.style.transform = 'scaleX(0)';
    }
  }

  function tick() {
    if (!recorder) return;
    const ms = recorder.elapsedMs;
    timer.textContent = formatDuration(ms);
    timer.classList.toggle('is-warning', ms >= MAX_RECORDING_MS - WARN_BEFORE_MS);
  }

  async function startRecording() {
    if (recorder || disposed) return;
    showHelp(null);
    stopPlayback();
    recordBtn.disabled = true;
    recordBtn.setAttribute('aria-busy', 'true');
    const r = createRecorder({
      onAutoStop: (p) => void finishRecording(p, 'auto'),
    });
    recorder = r;
    try {
      await r.start();
    } catch (err) {
      recorder = null;
      recordBtn.disabled = false;
      recordBtn.removeAttribute('aria-busy');
      const ve = toVoiceError(err);
      if (ve.code === 'aborted') return;
      console.warn('[voice] start failed', err);
      showHelp(ve);
      return;
    }
    recordBtn.disabled = false;
    recordBtn.removeAttribute('aria-busy');
    if (disposed || recorder !== r) {
      // Removed or cancelled while the permission prompt was open.
      r.cancel();
      return;
    }
    offLevel = r.onLevel((level) => {
      meterFill.style.transform = `scaleX(${level.toFixed(3)})`;
    });
    setRecordingUi(true);
    tick();
    tickTimer = window.setInterval(tick, 250);
    stopBtn.focus({ preventScroll: true });
    announce('Recording. Tap Stop to save.');
  }

  function endRecordingUi() {
    clearInterval(tickTimer);
    tickTimer = 0;
    offLevel?.();
    offLevel = null;
    recorder = null;
    if (!disposed) {
      setRecordingUi(false);
      if (el.contains(document.activeElement) || document.activeElement === document.body) {
        recordBtn.focus({ preventScroll: true });
      }
    }
  }

  /**
   * @param {'user' | 'leave'} why
   * @returns {Promise<void>}
   */
  function stopRecording(why) {
    const r = recorder;
    if (!r) return Promise.resolve();
    if (r.state === 'starting') {
      r.cancel();
      recorder = null;
      return Promise.resolve();
    }
    return finishRecording(r.stop(), why);
  }

  /**
   * Waits for the recording and saves it.
   * @param {Promise<Recording>} result
   * @param {'user' | 'auto' | 'leave'} why
   */
  async function finishRecording(result, why) {
    endRecordingUi();
    /** @type {Recording} */
    let rec;
    try {
      rec = await result;
    } catch (err) {
      const ve = toVoiceError(err);
      if (ve.code === 'aborted') return;
      console.warn('[voice] stop failed', err);
      if (!disposed) toast('Nothing was recorded. Tap Record and speak close to the microphone.', { kind: 'danger' });
      return;
    }
    if (rec.durationMs < MIN_RECORDING_MS && why === 'user') {
      toast('That was too short to save. Tap Record, speak, then tap Stop.');
      return;
    }
    await save(rec, why);
  }

  /**
   * @param {Recording} rec
   * @param {'user' | 'auto' | 'leave' | 'retry'} why
   */
  async function save(rec, why) {
    try {
      const stored = await voiceRepo.add({ qid, blob: rec.blob, mime: rec.mime, durationMs: rec.durationMs });
      unsaved = null;
      if (!disposed) {
        upsert(stored);
        renderMeta();
      }
      if (why === 'auto') {
        toast('Recording stopped at the 5-minute limit and was saved.', { kind: 'success' });
      } else if (why === 'leave') {
        toast('Your voice note was saved.', { kind: 'success' });
      } else {
        announce(`Voice note saved, ${spokenDuration(rec.durationMs)}.`);
      }
    } catch (err) {
      console.warn('[voice] save failed', err);
      unsaved = rec;
      toast("Your voice note couldn't be saved. Your device storage may be full. Free some space, then tap Try again.", {
        kind: 'danger',
        duration: 0,
        action: { label: 'Try again', onClick: () => unsaved && void save(unsaved, 'retry') },
      });
    }
  }

  function cancelRecording() {
    const r = recorder;
    if (!r) return;
    r.cancel();
    endRecordingUi();
    announce('Recording cancelled.');
  }

  // ---- Playback ---------------------------------------------------------

  function releaseUrl() {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  /** @param {Item} item */
  function renderItemTime(item, posMs = Number(item.range.value) || 0) {
    item.time.textContent = `${formatDuration(posMs)} / ${formatDuration(item.durationMs)}`;
    item.range.setAttribute('aria-valuetext', `${spokenDuration(posMs)} of ${spokenDuration(item.durationMs)}`);
    item.range.style.setProperty('--pct', `${item.durationMs ? Math.min(100, (posMs / item.durationMs) * 100) : 0}%`);
  }

  /**
   * @param {Item} item
   * @param {boolean} on
   */
  function setPlayIcon(item, on) {
    item.playBtn.replaceChildren(icon(on ? 'pause' : 'play', { size: 22 }));
    item.playBtn.setAttribute('aria-label', on ? 'Pause voice note' : 'Play voice note');
    item.playBtn.title = on ? 'Pause' : 'Play';
    item.el.classList.toggle('is-playing', on);
  }

  function followPosition() {
    cancelAnimationFrame(playRaf);
    const step = () => {
      if (!audio || !playing) return;
      const ms = audio.currentTime * 1000;
      playing.range.value = String(Math.min(ms, playing.durationMs));
      renderItemTime(playing, Math.min(ms, playing.durationMs));
      if (!audio.paused) playRaf = requestAnimationFrame(step);
    };
    playRaf = requestAnimationFrame(step);
  }

  /** Stops playback and forgets the current note (keeps its scrubber at 0). */
  function stopPlayback() {
    cancelAnimationFrame(playRaf);
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      try {
        audio.load();
      } catch {
        /* ignore */
      }
    }
    if (playing) {
      setPlayIcon(playing, false);
      playing.range.value = '0';
      renderItemTime(playing, 0);
    }
    playing = null;
    releaseUrl();
    if (stopOtherPlayback === stopPlayback) stopOtherPlayback = null;
  }

  /** @returns {HTMLAudioElement} */
  function getAudio() {
    if (audio) return audio;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('ended', () => {
      if (!playing) return;
      const item = playing;
      cancelAnimationFrame(playRaf);
      setPlayIcon(item, false);
      item.range.value = '0';
      renderItemTime(item, 0);
      playing = null;
      releaseUrl();
      if (stopOtherPlayback === stopPlayback) stopOtherPlayback = null;
    });
    a.addEventListener('pause', () => {
      if (playing) setPlayIcon(playing, false);
    });
    a.addEventListener('play', () => {
      if (playing) {
        setPlayIcon(playing, true);
        followPosition();
      }
    });
    a.addEventListener('loadedmetadata', () => {
      if (playing && !playing.durationMs && Number.isFinite(a.duration)) {
        playing.durationMs = Math.round(a.duration * 1000);
        playing.range.max = String(playing.durationMs);
        renderItemTime(playing);
      }
    });
    audio = a;
    return a;
  }

  /** @param {Item} item */
  async function togglePlay(item) {
    if (recorder) return;
    const a = getAudio();
    if (playing === item) {
      if (a.paused) {
        try {
          await a.play();
        } catch (err) {
          playFailed(err);
        }
      } else {
        a.pause();
      }
      return;
    }
    if (!(item.rec.blob instanceof Blob)) {
      toast('The audio of this voice note is missing. It may have been imported without media.', { kind: 'danger' });
      return;
    }
    // One player in the whole app.
    if (stopOtherPlayback && stopOtherPlayback !== stopPlayback) stopOtherPlayback();
    stopPlayback();
    stopOtherPlayback = stopPlayback;
    playing = item;
    objectUrl = URL.createObjectURL(item.rec.blob);
    a.src = objectUrl;
    const startMs = Number(item.range.value) || item.pendingSeekMs || 0;
    item.pendingSeekMs = 0;
    if (startMs > 0) {
      try {
        a.currentTime = startMs / 1000;
      } catch {
        /* seek after metadata */
      }
    }
    try {
      await a.play();
    } catch (err) {
      playFailed(err);
    }
  }

  /** @param {any} err */
  function playFailed(err) {
    if (err && err.name === 'AbortError') return; // replaced by another play/stop
    console.warn('[voice] play failed', err);
    stopPlayback();
    toast(
      err && err.name === 'NotSupportedError'
        ? "This voice note can't be played on this device (its audio format isn't supported here). Try it on the device where you recorded it."
        : "This voice note couldn't be played. Check that your device isn't muted, then try again.",
      { kind: 'danger', duration: 8000 },
    );
  }

  // ---- List items -------------------------------------------------------

  /**
   * @param {VoiceNote} rec
   * @returns {Item}
   */
  function createItem(rec) {
    const durationMs = Math.max(0, Number(rec.durationMs) || 0);
    const playBtn = /** @type {HTMLButtonElement} */ (
      h('button', { type: 'button', class: 'voice-play', 'aria-label': 'Play voice note', title: 'Play' }, icon('play', { size: 22 }))
    );
    const range = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'range',
        class: 'voice-scrub',
        min: 0,
        max: Math.max(1, durationMs),
        step: 100,
        value: 0,
        'aria-label': 'Position in voice note',
      })
    );
    const time = h('span', { class: 'voice-time' });
    const validTs = Number.isFinite(rec.ts) && rec.ts > 0;
    const when = h(
      'time',
      {
        class: 'voice-date',
        datetime: validTs ? new Date(rec.ts).toISOString() : null,
        title: validTs ? formatDate(rec.ts) : null,
      },
      validTs ? formatRelative(rec.ts) : 'Voice note',
    );
    const del = iconButton({ icon: 'trash', label: 'Delete voice note', onClick: () => void remove(item) });
    del.classList.add('voice-delete');
    const li = h(
      'li',
      { class: 'voice-item', dataset: { id: rec.id } },
      playBtn,
      h('div', { class: 'voice-item-body' }, h('div', { class: 'voice-item-top' }, when, time), range),
      del,
    );
    /** @type {Item} */
    const item = { rec, el: li, playBtn, range, time, durationMs, pendingSeekMs: 0 };
    playBtn.addEventListener('click', () => void togglePlay(item));
    range.addEventListener('input', () => {
      const ms = Number(range.value) || 0;
      renderItemTime(item, ms);
      if (playing === item && audio) {
        try {
          audio.currentTime = ms / 1000;
        } catch {
          /* not seekable yet */
        }
      } else {
        item.pendingSeekMs = ms;
      }
    });
    if (!(rec.blob instanceof Blob)) {
      playBtn.disabled = true;
      li.classList.add('is-missing');
      time.textContent = 'Audio missing';
    } else {
      renderItemTime(item, 0);
    }
    return item;
  }

  /**
   * Adds or updates one note in the list (sorted oldest first, like the repo).
   * @param {VoiceNote} rec
   */
  function upsert(rec) {
    if (items.has(rec.id)) return;
    const item = createItem(rec);
    items.set(rec.id, item);
    const after = [...items.values()].filter((i) => i !== item && i.rec.ts > rec.ts).sort((a, b) => a.rec.ts - b.rec.ts)[0];
    if (after) list.insertBefore(item.el, after.el);
    else list.append(item.el);
  }

  /** @param {Item} item */
  function dropItem(item) {
    if (playing === item) stopPlayback();
    items.delete(item.rec.id);
    item.el.remove();
  }

  function renderMeta() {
    const n = items.size;
    countEl.textContent = n ? String(n) : '';
    empty.hidden = n > 0 || !supported;
    list.hidden = n === 0;
  }

  /** @param {Item} item */
  async function remove(item) {
    const rec = item.rec;
    // Move focus to a neighbour so keyboard users don't lose their place.
    const next = /** @type {HTMLElement | null} */ (item.el.nextElementSibling || item.el.previousElementSibling);
    dropItem(item);
    renderMeta();
    (next?.querySelector('.voice-play') ?? (supported ? recordBtn : null))?.focus?.({ preventScroll: true });
    try {
      await voiceRepo.remove(rec.id);
    } catch (err) {
      console.warn('[voice] delete failed', err);
      if (!disposed) {
        upsert(rec);
        renderMeta();
      }
      toast("The voice note couldn't be deleted. Please try again.", { kind: 'danger' });
      return;
    }
    undoToast('Voice note deleted', () => {
      // Restore the same record (same id and date), so it keeps its place.
      mergeStore('voice', [rec])
        .then(() => {
          if (!disposed) {
            upsert(rec);
            renderMeta();
          }
        })
        .catch((err) => {
          console.warn('[voice] restore failed', err);
          toast("The voice note couldn't be restored. Your device storage may be full.", { kind: 'danger' });
        });
    });
  }

  /** Reloads the list from storage, keeping items (and playback) that still exist. */
  async function reload() {
    try {
      const recs = await voiceRepo.byQid(qid);
      if (disposed) return;
      const ids = new Set(recs.map((r) => r.id));
      for (const item of [...items.values()]) if (!ids.has(item.rec.id)) dropItem(item);
      for (const rec of recs) upsert(rec);
      renderMeta();
    } catch (err) {
      console.warn('[voice] load failed', err);
      if (!disposed && items.size === 0) {
        empty.hidden = false;
        empty.textContent = "Your voice notes couldn't be loaded. Reload the app to try again.";
      }
    }
  }

  // ---- Lifecycle --------------------------------------------------------

  /** Leaving (screen change, background, removal): stop and save; never lose a recording. */
  function leave() {
    if (recorder) void stopRecording('leave');
    if (audio && !audio.paused) audio.pause();
  }

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') leave();
  };
  const onPageHide = () => leave();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);

  const offs = [
    bus.on('route:change', () => leave()),
    bus.on('store:change', (payload) => {
      if (payload && payload.store === 'voice') void reload();
    }),
    () => document.removeEventListener('visibilitychange', onVisibility),
    () => window.removeEventListener('pagehide', onPageHide),
  ];

  /** Stops recording (saving it), stops playback and removes listeners. Idempotent. */
  function destroy() {
    if (disposed) return;
    leave();
    disposed = true;
    for (const off of offs.splice(0)) off();
    stopPlayback();
    audio = null;
  }
  offs.push(whenRemoved(el, destroy));
  el.destroy = destroy;

  renderMeta();
  list.hidden = true;
  empty.hidden = true;
  void reload();
  return el;
}
