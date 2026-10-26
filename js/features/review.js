/**
 * Quality tools around the AI-generated question bank (docs/ARCHITECTURE.md §7.11):
 *
 * - "Report a problem" sheet for every learner ({@link openReportSheet}),
 *   saved on the device in the `reports` store.
 * - Reviewer panel for a specialist in reviewer mode ({@link createReviewerPanel}):
 *   Approve / Needs fix + comment, saved per question with the question version,
 *   so a review of an older version is shown as "check again".
 * - Review file export ({@link exportReviewFile}): reviews + reports as JSON
 *   the reviewer sends to the author.
 * - "Not yet reviewed" chip for questions with `reviewed: false` ({@link unreviewedBadge}).
 *
 * Everything stays on the device; nothing is sent anywhere. Styles: css/review.css.
 * Importing this module has no side effects (no DOM access at import time).
 *
 * @module features/review
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { dayKey, debounce, formatRelative, plural } from '../core/util.js';
import { reportsRepo, reviewsRepo } from '../core/store/repo.js';
import { APP_VERSION } from '../version.js';
import { button, chip, sheet, toast, undoToast } from '../ui/components.js';
import { icon } from '../ui/icons.js';

/**
 * @typedef {import('../core/data.js').Question} Question
 * @typedef {import('../core/store/repo.js').Review} Review
 * @typedef {import('../core/store/repo.js').Report} Report
 */

/** Reasons offered in the report sheet (stored as given). */
export const REPORT_REASONS = Object.freeze([
  'Wrong answer',
  'Unclear question',
  'Typo or formatting',
  'Explanation problem',
  'Other',
]);

/** `type` field of an exported review file. */
export const REVIEW_FILE_TYPE = 'cardiac-mcq-review';

/** Format version of the review file. */
export const REVIEW_FORMAT_VERSION = 1;

/** Longest free text kept for a report or review comment. */
export const MAX_COMMENT_LENGTH = 4000;

const SAVED_REPORT_MESSAGE = 'Thanks — saved on this device. Export it from Settings > Reviewer to send it.';
const UNREVIEWED_HINT = 'AI-generated question, not yet checked by a specialist.';
const COMMENT_SAVE_DELAY_MS = 600;

let seq = 0;
/**
 * @param {string} prefix
 * @returns {string}
 */
function nextId(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

/**
 * Plain-language text for a failed save.
 * @param {unknown} err
 * @param {string} fallback
 * @returns {string}
 */
function friendly(err, fallback) {
  const e = /** @type {any} */ (err);
  return (e && typeof e.userMessage === 'string' && e.userMessage) || fallback;
}

/**
 * Version number of a question (≥ 1).
 * @param {Question} question
 * @returns {number}
 */
function versionOf(question) {
  const v = Number(/** @type {any} */ (question)?.version);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/**
 * @param {unknown} question
 * @returns {string}
 */
function requireQid(question) {
  const id = /** @type {any} */ (question)?.id;
  if (typeof id !== 'string' || id === '') throw new TypeError('review: question must have an id');
  return id;
}

// ---------------------------------------------------------------------------
// Report sheet
// ---------------------------------------------------------------------------

/**
 * Opens the "Report a problem" sheet for a question: a reason (radio group),
 * optional details, and Send. The report is stored on the device
 * (`reportsRepo.add({qid, qversion, reason, text, ts})`); a success toast offers Undo.
 * A failed save keeps the sheet open with the text intact and explains why.
 *
 * @param {Question} question
 * @returns {{ close: () => Promise<void> }}
 */
export function openReportSheet(question) {
  const qid = requireQid(question);
  const qversion = versionOf(question);
  const groupName = nextId('rv-reason');
  const textId = nextId('rv-text');
  const hintId = nextId('rv-hint');
  const errorId = nextId('rv-error');
  /** @type {string | null} */
  let reason = null;
  let busy = false;

  const radios = REPORT_REASONS.map((label, i) => {
    const input = /** @type {HTMLInputElement} */ (
      h('input', { type: 'radio', name: groupName, value: label, class: 'rv-radio-input', 'data-autofocus': i === 0 ? '' : null })
    );
    input.addEventListener('change', () => {
      if (!input.checked) return;
      reason = label;
      sendBtn.disabled = false;
      errorEl.hidden = true;
    });
    return h(
      'label',
      { class: 'rv-option' },
      input,
      h('span', { class: 'rv-option-mark', 'aria-hidden': 'true' }),
      h('span', { class: 'rv-option-label' }, label),
    );
  });

  const textarea = /** @type {HTMLTextAreaElement} */ (
    h('textarea', {
      id: textId,
      class: 'rv-textarea',
      rows: 3,
      maxlength: MAX_COMMENT_LENGTH,
      placeholder: 'What should be fixed? (optional)',
      'aria-describedby': hintId,
      autocomplete: 'off',
    })
  );

  const existingNote = h('p', { class: 'rv-hint', hidden: true });
  const errorEl = h('p', { class: 'rv-error', id: errorId, role: 'alert', hidden: true });

  const content = h(
    'form',
    {
      class: 'rv-report',
      novalidate: true,
      onSubmit: (/** @type {Event} */ e) => {
        e.preventDefault();
        void send();
      },
    },
    h(
      'fieldset',
      { class: 'rv-fieldset' },
      h('legend', { class: 'rv-legend' }, "What's wrong?"),
      h('div', { class: 'rv-options' }, radios),
    ),
    h('label', { class: 'rv-label', htmlFor: textId }, 'Details'),
    textarea,
    h('p', { class: 'rv-hint', id: hintId }, `Question ${qid}. Saved on this device only.`),
    existingNote,
    errorEl,
  );

  const cancelBtn = button({ label: 'Cancel', variant: 'secondary', onClick: () => ref.close('cancel') });
  const sendBtn = button({ label: 'Send', icon: 'flag', variant: 'primary', disabled: true, onClick: () => void send() });

  const ref = sheet({ title: 'Report a problem', content, actions: [cancelBtn, sendBtn], size: 's' });

  // Tell the user when they already reported this question (no blocking).
  reportsRepo.byQid(qid).then(
    (list) => {
      if (!list.length || !existingNote.isConnected) return;
      existingNote.textContent = `You reported this question before (${plural(list.length, 'time')}). A new report is added to it.`;
      existingNote.hidden = false;
    },
    () => {},
  );

  async function send() {
    if (busy) return;
    if (!reason) {
      errorEl.textContent = 'Choose what is wrong first.';
      errorEl.hidden = false;
      return;
    }
    busy = true;
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const saved = await reportsRepo.add({
        qid,
        qversion,
        reason,
        text: textarea.value.trim().slice(0, MAX_COMMENT_LENGTH),
        ts: Date.now(),
      });
      await ref.close('sent');
      toast(SAVED_REPORT_MESSAGE, {
        kind: 'success',
        duration: 6000,
        action: {
          label: 'Undo',
          onClick: () => {
            reportsRepo.remove(saved.id).then(
              () => toast('Report removed.'),
              (err) => toast(friendly(err, "Couldn't remove the report. Please try again."), { kind: 'danger' }),
            );
          },
        },
      });
    } catch (err) {
      console.error('[review] report save failed', err);
      errorEl.textContent = friendly(err, "Couldn't save your report. Please try again.");
      errorEl.hidden = false;
      busy = false;
      sendBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  }

  return { close: () => ref.close('api') };
}

// ---------------------------------------------------------------------------
// Reviewer panel
// ---------------------------------------------------------------------------

/**
 * Reviewer-mode panel for one question: shows the bank status and the
 * reviewer's own verdict, and saves Approve / Needs fix + comment to
 * `reviewsRepo` with the current question version. Tapping the active verdict
 * again clears it. Every verdict change offers Undo. A verdict saved for an
 * older question version is shown as stale ("check it again").
 * The comment autosaves (debounced) once a verdict exists.
 *
 * The panel follows `store:change` for its question (e.g. after an import)
 * and stops listening once it has been removed from the page.
 *
 * @param {Question} question
 * @returns {HTMLElement}
 */
export function createReviewerPanel(question) {
  const qid = requireQid(question);
  const qversion = versionOf(question);
  const headingId = nextId('rv-panel-title');
  const commentId = nextId('rv-comment');
  /** @type {Review | null} */
  let current = null;
  let loaded = false;
  let saving = Promise.resolve();
  let commentDirty = false;

  const bankChip = question?.reviewed === true
    ? chip('Reviewed in the bank', { kind: 'success', icon: 'check' })
    : chip('Not yet reviewed in the bank', { kind: 'warning', icon: 'info' });

  const statusText = h('p', { class: 'rv-status-text', 'aria-live': 'polite' }, 'Loading your review…');
  const staleNote = h(
    'p',
    { class: 'rv-stale', hidden: true },
    icon('alert', { size: 18 }),
    h('span', { class: 'rv-stale-text' }),
  );

  const approveBtn = verdictButton('ok', 'Approve', 'check');
  const fixBtn = verdictButton('fix', 'Needs fix', 'flag');

  const textarea = /** @type {HTMLTextAreaElement} */ (
    h('textarea', {
      id: commentId,
      class: 'rv-textarea',
      rows: 2,
      maxlength: MAX_COMMENT_LENGTH,
      placeholder: 'Comment for the author (optional)',
      autocomplete: 'off',
    })
  );
  const savedNote = h('span', { class: 'rv-saved', 'aria-live': 'polite' });
  const commentHint = h('p', { class: 'rv-hint' }, 'Choose Approve or Needs fix to save the comment.');

  const el = h(
    'section',
    { class: 'rv-panel', 'aria-labelledby': headingId, dataset: { qid } },
    h(
      'div',
      { class: 'rv-panel-head' },
      h('h3', { class: 'rv-panel-title', id: headingId }, icon('eye', { size: 20 }), 'Specialist review'),
      bankChip,
    ),
    statusText,
    staleNote,
    h('div', { class: 'rv-verdicts', role: 'group', 'aria-label': 'Your verdict' }, approveBtn, fixBtn),
    h('div', { class: 'rv-comment-head' }, h('label', { class: 'rv-label', htmlFor: commentId }, 'Comment'), savedNote),
    textarea,
    commentHint,
  );

  /**
   * @param {'ok' | 'fix'} status
   * @param {string} label
   * @param {string} iconName
   * @returns {HTMLButtonElement}
   */
  function verdictButton(status, label, iconName) {
    const b = button({ label, icon: iconName, variant: 'secondary', onClick: () => void choose(status) });
    b.classList.add('rv-verdict', `rv-verdict-${status}`);
    b.setAttribute('aria-pressed', 'false');
    b.disabled = true;
    return b;
  }

  function render() {
    const status = current?.status ?? null;
    approveBtn.setAttribute('aria-pressed', String(status === 'ok'));
    fixBtn.setAttribute('aria-pressed', String(status === 'fix'));
    approveBtn.disabled = !loaded;
    fixBtn.disabled = !loaded;
    el.dataset.status = status ?? 'none';

    if (!loaded) return;
    if (!current) {
      statusText.textContent = 'You have not reviewed this question yet.';
    } else {
      const when = formatRelative(current.ts);
      statusText.textContent = `${current.status === 'ok' ? 'You approved this question' : 'You marked this question as needing a fix'}${when ? ` · ${when}` : ''}.`;
    }
    const stale = Boolean(current) && Number(current?.qversion) !== qversion;
    el.classList.toggle('is-stale', stale);
    staleNote.hidden = !stale;
    if (stale) {
      /** @type {HTMLElement} */ (staleNote.querySelector('.rv-stale-text')).textContent =
        `This question changed since your review (version ${current?.qversion} → ${qversion}). Please check it again and choose a verdict.`;
    }
    commentHint.hidden = Boolean(current);
    if (!commentDirty && document.activeElement !== textarea) textarea.value = current?.comment ?? '';
  }

  async function load() {
    try {
      current = (await reviewsRepo.get(qid)) ?? null;
    } catch (err) {
      console.error('[review] load failed', err);
      statusText.textContent = friendly(err, "Couldn't load your review. Reload the app to try again.");
      current = null;
    }
    loaded = true;
    render();
  }

  /**
   * Serialises writes so a fast double tap never races.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function queue(task) {
    const run = saving.then(task, task);
    saving = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Writes `next` (or removes when null) and updates the view.
   * @param {Review | null} next
   * @returns {Promise<void>}
   */
  async function write(next) {
    if (next) {
      current = await reviewsRepo.set(qid, { qversion: next.qversion, status: next.status, comment: next.comment });
    } else {
      await reviewsRepo.remove(qid);
      current = null;
    }
    render();
  }

  /** @param {'ok' | 'fix'} status */
  function choose(status) {
    return queue(async () => {
      saveComment.cancel();
      const prev = current ? { ...current } : null;
      const comment = textarea.value.trim().slice(0, MAX_COMMENT_LENGTH);
      const sameAsBefore = prev && prev.status === status && Number(prev.qversion) === qversion;
      /** @type {Review | null} */
      const next = sameAsBefore ? null : { qid, qversion, status, comment, ts: Date.now() };
      try {
        await write(next);
        commentDirty = false;
      } catch (err) {
        console.error('[review] save failed', err);
        toast(friendly(err, "Couldn't save your review. Please try again."), { kind: 'danger' });
        return;
      }
      if (status === 'fix' && next && !comment) {
        textarea.focus();
        savedNote.textContent = 'Add a short comment so the author knows what to fix.';
      } else {
        savedNote.textContent = '';
      }
      const message = !next ? 'Review cleared' : status === 'ok' ? 'Approved' : 'Marked as needing a fix';
      undoToast(message, () => {
        void queue(async () => {
          try {
            await write(prev);
            commentDirty = false;
            if (!textarea.matches(':focus')) textarea.value = prev?.comment ?? '';
          } catch (err) {
            toast(friendly(err, "Couldn't undo. Please try again."), { kind: 'danger' });
          }
        });
      });
    });
  }

  const saveComment = debounce(() => {
    void flushComment();
  }, COMMENT_SAVE_DELAY_MS);

  function flushComment() {
    return queue(async () => {
      if (!commentDirty || !current) return;
      const comment = textarea.value.trim().slice(0, MAX_COMMENT_LENGTH);
      if (comment === (current.comment ?? '')) {
        commentDirty = false;
        return;
      }
      try {
        current = await reviewsRepo.set(qid, { qversion: current.qversion, status: current.status, comment });
        commentDirty = false;
        savedNote.textContent = 'Saved';
        render();
      } catch (err) {
        console.error('[review] comment save failed', err);
        savedNote.textContent = '';
        toast(friendly(err, "Couldn't save your comment. Please try again."), { kind: 'danger' });
      }
    });
  }

  textarea.addEventListener('input', () => {
    commentDirty = true;
    if (current) {
      savedNote.textContent = '';
      saveComment();
    }
  });
  textarea.addEventListener('blur', () => {
    if (current && commentDirty) void flushComment();
  });

  // Follow outside changes (another tab, an import) until the panel is gone.
  let seenConnected = false;
  const off = bus.on('store:change', (payload) => {
    if (el.isConnected) seenConnected = true;
    else if (seenConnected) {
      off();
      if (commentDirty) void flushComment();
      return;
    }
    if (!payload || payload.store !== 'reviews' || (payload.key != null && payload.key !== qid)) return;
    void queue(load);
  });

  render();
  void queue(load);
  return el;
}

// ---------------------------------------------------------------------------
// Review file
// ---------------------------------------------------------------------------

/**
 * Builds the review file: every review and report on this device.
 * Format: `{ type: 'cardiac-mcq-review', formatVersion: 1, appVersion, exportedAt /* ISO */,
 * reviews: Review[] (by qid), reports: Report[] (oldest first) }`.
 * Rejects with the repo's `StorageError` when the data can't be read.
 *
 * @param {{ now?: number }} [opts] `now` is for tests.
 * @returns {Promise<{ blob: Blob, filename: string, counts: { reviews: number, reports: number } }>}
 */
export async function exportReviewFile({ now = Date.now() } = {}) {
  const [reviews, reports] = await Promise.all([reviewsRepo.all(), reportsRepo.all()]);
  const sortedReviews = [...reviews].sort((a, b) => String(a.qid).localeCompare(String(b.qid)));
  const sortedReports = [...reports].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const file = {
    type: REVIEW_FILE_TYPE,
    formatVersion: REVIEW_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date(now).toISOString(),
    reviews: sortedReviews,
    reports: sortedReports,
  };
  const blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
  return {
    blob,
    filename: `cardiac-mcq-review-${dayKey(now)}.json`,
    counts: { reviews: sortedReviews.length, reports: sortedReports.length },
  };
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

/**
 * A "Not yet reviewed" chip (warning) for a question with `reviewed: false`,
 * or `null` otherwise. The chip is a small button: its accessible name and
 * tooltip explain that the question is AI-generated and not yet checked by a
 * specialist; tapping it shows the same explanation as a toast (touch has no hover).
 *
 * @param {Question} question
 * @returns {HTMLElement | null}
 */
export function unreviewedBadge(question) {
  if (!question || /** @type {any} */ (question).reviewed !== false) return null;
  const el = h(
    'button',
    {
      type: 'button',
      class: 'chip chip-warning rv-badge',
      title: UNREVIEWED_HINT,
      onClick: () => toast(`${UNREVIEWED_HINT} If something looks wrong, use Report a problem.`),
    },
    icon('info', { size: 14 }),
    h('span', { class: 'chip-label' }, 'Not yet reviewed'),
    h('span', { class: 'visually-hidden' }, `: ${UNREVIEWED_HINT}`),
  );
  return el;
}
