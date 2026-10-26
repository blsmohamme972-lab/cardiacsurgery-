/**
 * Offline full-text search over the study bank (docs/ARCHITECTURE.md §7.5).
 *
 * Two layers:
 *
 * 1. **Pure helpers** ({@link tokenize}, {@link buildIndex},
 *    {@link queryIndex}, {@link makeSnippet}). No I/O and no DOM, so they run
 *    in Node unit tests.
 * 2. **{@link search}**: loads the study bank (`core/data.js`, imported lazily
 *    on first use), builds the index once (memoized, in small time slices so
 *    the page stays responsive) and returns ranked results with a title and
 *    a highlighted snippet. The index is rebuilt when the study bank changes
 *    (another set of chapters or counts) or after {@link clearSearchIndex}.
 *
 * Matching rules:
 * - Text is folded before tokenizing: lowercase, accents removed ("é" → "e"),
 *   compatibility forms unified ("²" → "2"), Greek letters spelled out
 *   ("β" → "beta"), so "beta-blocker" finds "β-blocker".
 * - Tokens are runs of Unicode letters/digits; punctuation and inline markup
 *   characters (`* _ = ^ ~ \``) separate tokens. One-character tokens are
 *   dropped, except digits. A hyphenated word ("beta-blocker") gives its
 *   parts and the joined form ("beta", "blocker", "betablocker").
 * - A query matches a question only when **every** term matches (AND). The
 *   last term also matches as a prefix ("valv" → "valve", "valvular"), so
 *   results appear while the user types (a trailing space does not stop it:
 *   phone keyboards add one after a suggested word). A hyphenated query word
 *   matches its joined form or all of its parts, and both score alike.
 *
 * Ranking: score = Σ over terms of Σ over fields (field weight × matches in
 * that field, counting at most {@link MAX_COUNTED_REPEATS} repeats). Stem,
 * topic and tags weigh most, choices medium, explanation and choice notes
 * least ({@link FIELD_WEIGHTS}), so a stem hit always outranks a hit found
 * only in the explanation. A multi-word query found as an exact phrase in the
 * stem earns {@link PHRASE_BONUS}. Ties keep bank order.
 *
 * Index layout (built once, compact for 5000+ rich questions): a sorted
 * vocabulary, and postings in one `Int32Array` (CSR: `offsets[t]` …
 * `offsets[t + 1]` are the postings of token `t`), each posting packing the
 * question position and its score. Exact terms use a binary search; the
 * prefix term reads one contiguous slice. Plain text for titles and snippets
 * is derived on demand for the returned hits only, so the index does not
 * keep a second copy of the bank's text.
 *
 * @module features/search
 */

import { escapeRegExp } from '../core/util.js';
import { inlineToPlain } from './explain/inline.js';

/**
 * @typedef {import('../core/data.js').Question} Question
 */

/**
 * @typedef {object} IndexedDoc
 * @property {string} qid
 * @property {string | null} chapterId
 * @property {string} stemKey        Folded stem words joined by single spaces, padded with
 *                                   a space on both ends (for the exact-phrase bonus).
 * @property {Question} question     The question itself (shared, read-only), for titles and snippets.
 */

/**
 * @typedef {object} SearchIndex
 * @property {number} size                 Number of indexed questions.
 * @property {ReadonlyArray<IndexedDoc>} docs   In bank order (position = bank order).
 * @property {ReadonlyArray<string>} vocab      Every token, sorted (UTF-16 code unit order).
 * @property {Int32Array} offsets          `vocab.length + 1` entries into `postings`.
 * @property {Int32Array} postings         `position << SCORE_BITS | score`, by token, then position.
 */

/**
 * @typedef {object} SearchHit
 * @property {string} qid
 * @property {string | null} chapterId
 * @property {number} score
 * @property {number} pos            Position of the question in the index (bank order).
 */

/**
 * @typedef {{ text: string, match: boolean }} SnippetSegment
 */

/**
 * @typedef {object} SearchResult
 * @property {string} qid
 * @property {string | null} chapterId
 * @property {string} title                 Start of the plain stem (about 90 characters).
 * @property {SnippetSegment[]} snippet     Text around the first match; `match: true` marks hits.
 * @property {number} score
 */

/**
 * @typedef {object} SearchBackend  Test seam (see {@link setTestBackend}).
 * @property {Pick<typeof import('../core/data.js'), 'studyChapters' | 'loadStudyBank'>} data
 */

/** Weight of one match in each field of a question. */
export const FIELD_WEIGHTS = Object.freeze({
  stem: 8,
  topic: 8,
  tags: 8,
  choices: 4,
  notes: 1,
  explanation: 1,
});

/** Repeats of a token in one field that still add to the score. */
export const MAX_COUNTED_REPEATS = 3;

/** Score bonus when a multi-word query appears as an exact phrase in the stem. */
export const PHRASE_BONUS = 12;

/** Default number of results. */
export const DEFAULT_LIMIT = 50;

/** Longest query, in terms (extra words are ignored). */
export const MAX_QUERY_TERMS = 16;

/** Default snippet length (characters, without the ellipses). */
export const SNIPPET_LENGTH = 160;

/** Longest result title (characters, without the ellipsis). */
export const TITLE_LENGTH = 90;

/** Bits of a posting that hold the score; the rest is the question position. */
const SCORE_BITS = 7;
const SCORE_MASK = (1 << SCORE_BITS) - 1;

/** Field order used to build the plain text of a question (titles, snippets). */
const TEXT_ORDER = Object.freeze(['stem', 'choices', 'notes', 'explanation', 'topic', 'tags']);

/** Separator between the parts of a question's plain text in snippets. */
const PART_SEPARATOR = ' · ';

/** Work slice of the background index build before yielding to the page (ms). */
const BUILD_SLICE_MS = 12;

/** Block fields that never hold readable text. */
const NON_TEXT_KEYS = new Set(['id', 'type', 'kind', 'src', 'ordered', 'emphasis']);

/** Greek letters → names, so "β-blocker" and "beta-blocker" find each other. */
const GREEK = Object.freeze({
  α: 'alpha',
  β: 'beta',
  γ: 'gamma',
  δ: 'delta',
  ε: 'epsilon',
  ζ: 'zeta',
  η: 'eta',
  θ: 'theta',
  ι: 'iota',
  κ: 'kappa',
  λ: 'lambda',
  μ: 'mu',
  ν: 'nu',
  ξ: 'xi',
  ο: 'omicron',
  π: 'pi',
  ρ: 'rho',
  σ: 'sigma',
  ς: 'sigma',
  τ: 'tau',
  υ: 'upsilon',
  φ: 'phi',
  χ: 'chi',
  ψ: 'psi',
  ω: 'omega',
});

// eslint-disable-next-line no-control-regex
const ASCII_RE = /^[\x00-\x7f]*$/;
// eslint-disable-next-line no-control-regex
const NON_ASCII_RE = /[^\x00-\x7f]/gu;
const MARK_RE = /^\p{M}+$/u;
const LETTER_OR_DIGIT_RE = /^[\p{L}\p{N}]+$/u;
/** Unicode hyphens (U+2010, U+2011); folding turns them into "-". */
const UNICODE_HYPHEN_RE = /^[\u2010\u2011]$/u;
/** A word of folded text: letters/digits, optionally joined by hyphens. */
const WORD_RE = /[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu;
/** Any inline markup character (a cheap test before {@link TOKEN_MARKUP_RE}). */
const MARKUP_CHAR_RE = /[\\^~*_=`]/;
/**
 * Inline markup that can change tokens: sup/sub join characters (`CO~2~` → "CO2"), escapes,
 * and a `*`, `=`, `_` or backtick run squeezed between word characters or hyphens, where
 * removing it joins text (`**ACE**I`, `**beta**-blocker`). In every other string the markers
 * and the ASCII arrows are just punctuation to the tokenizer, so the string is tokenized as
 * it is and the inline parser is skipped (it is the costliest step of the build).
 */
const TOKEN_MARKUP_RE = /[\\^~]|[\p{L}\p{N}\u2010\u2011-][*=_`]+[\p{L}\p{N}\u2010\u2011-]/u;
/** A run of letters/digits (used for the exact-phrase key). */
const RUN_RE = /[\p{L}\p{N}]+/gu;
const DIGIT_RE = /^\p{N}$/u;
const SPACE_RE = /\s+/g;
const TRAILING_PUNCT_RE = /[\s,;:.\-\u2013\u2014]+$/u;

// ---------------------------------------------------------------------------
// Text folding and tokens
// ---------------------------------------------------------------------------

/** Folded form of each non-ASCII character seen so far (content uses few distinct ones). */
const foldedChars = new Map();
const FOLDED_CHARS_MAX = 4096;

/**
 * Folds one non-ASCII character of NFKD, lowercased text: a Greek letter is
 * spelled out, a combining mark is dropped, any other letter or digit is
 * kept, a Unicode hyphen becomes "-", everything else (arrows, dashes,
 * quotes, symbols) becomes a space.
 * @param {string} c
 * @returns {string}
 */
function foldChar(c) {
  let out = foldedChars.get(c);
  if (out !== undefined) return out;
  const greek = /** @type {Record<string, string>} */ (GREEK)[c];
  if (greek !== undefined) out = greek;
  else if (MARK_RE.test(c)) out = '';
  else if (LETTER_OR_DIGIT_RE.test(c)) out = c;
  else out = UNICODE_HYPHEN_RE.test(c) ? '-' : ' ';
  if (foldedChars.size < FOLDED_CHARS_MAX) foldedChars.set(c, out);
  return out;
}

/**
 * Folds a string for matching: NFKD, lowercase, then {@link foldChar} on
 * every non-ASCII character. Letters and digits keep their positions
 * relative to separators, so tokens are the same as in the original text.
 * @param {string} s
 * @returns {string}
 */
function fold(s) {
  if (ASCII_RE.test(s)) return s.toLowerCase();
  return s.normalize('NFKD').toLowerCase().replace(NON_ASCII_RE, foldChar);
}

/**
 * True when a token is worth indexing: two or more characters, or a digit.
 * @param {string} t
 * @returns {boolean}
 */
function keepToken(t) {
  return t.length > 1 || DIGIT_RE.test(t);
}

/** @type {TextEncoder | null} */
let encoder = null;
/** @type {TextDecoder | null} */
let latin1 = null;

/**
 * The folded text the tokenizer reads. Folding turns non-ASCII separators
 * (typed arrows, dashes, curly quotes, symbols) into spaces, so text with the
 * odd "→" or "≥" usually folds to pure ASCII, but still in a two-byte string;
 * tokens cut from it stay two-byte and are about twice as slow as Map keys.
 * Such text is re-encoded as a one-byte string, which keeps the build fast.
 * @param {string} text
 * @returns {string}
 */
function tokenSource(text) {
  if (ASCII_RE.test(text)) return text.toLowerCase();
  const folded = fold(text);
  if (!ASCII_RE.test(folded)) return folded;
  try {
    encoder ??= new TextEncoder();
    latin1 ??= new TextDecoder('latin1');
    return latin1.decode(encoder.encode(folded));
  } catch {
    return folded;
  }
}

/**
 * A copy of a token that does not share memory with the (possibly large)
 * text it was cut from (engines may keep long substrings as views into
 * their source), so vocabulary keys never keep whole field texts alive.
 * Called once per distinct token.
 * @param {string} token
 * @returns {string}
 */
function ownString(token) {
  return ` ${token}`.slice(1);
}

/**
 * Calls `fn` for every token of `text` (see {@link tokenize}), without
 * building an array.
 * @param {string} text
 * @param {(token: string) => void} fn
 */
function eachToken(text, fn) {
  if (!text) return;
  const words = tokenSource(text).match(WORD_RE);
  if (!words) return;
  for (const word of words) {
    if (word.indexOf('-') === -1) {
      if (keepToken(word)) fn(word);
      continue;
    }
    const parts = word.split('-');
    for (const p of parts) if (keepToken(p)) fn(p);
    fn(parts.join(''));
  }
}

/**
 * Splits text into search tokens: lowercase, accents removed, Greek letters
 * spelled out, Unicode letters/digits only (punctuation and inline markup
 * characters split tokens), one-character tokens dropped except digits.
 * A hyphenated word gives its parts, then the joined form.
 *
 * @param {unknown} text
 * @returns {string[]} Tokens in reading order (repeats kept).
 * @example tokenize('**Beta-blocker** dose: 2 mg') // ['beta', 'blocker', 'betablocker', 'dose', '2', 'mg']
 */
export function tokenize(text) {
  /** @type {string[]} */
  const out = [];
  if (typeof text === 'string') eachToken(text, (t) => out.push(t));
  return out;
}

/**
 * Folded letter/digit runs of a string, joined by single spaces (no tokens dropped).
 * @param {string} text
 * @returns {string}
 */
function phraseOf(text) {
  return text ? (fold(text).match(RUN_RE) ?? []).join(' ') : '';
}

// ---------------------------------------------------------------------------
// Question text
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Visible text of an inline mini-markup string (never throws).
 * @param {unknown} s
 * @returns {string}
 */
function plain(s) {
  if (typeof s !== 'string' || s === '') return '';
  try {
    return String(inlineToPlain(s) ?? '');
  } catch {
    return s;
  }
}

/**
 * Text of an inline mini-markup string as the tokenizer needs it: the string
 * itself when its markup cannot change tokens (see TOKEN_MARKUP_RE), else
 * its visible text. Skips the parser for most strings during the build.
 * @param {unknown} s
 * @returns {string}
 */
function tokenText(s) {
  if (typeof s !== 'string') return '';
  return MARKUP_CHAR_RE.test(s) && TOKEN_MARKUP_RE.test(s) ? plain(s) : s;
}

/**
 * Collapses whitespace runs to single spaces and trims.
 * @param {unknown} s
 * @returns {string}
 */
function collapse(s) {
  return typeof s === 'string' ? s.replace(SPACE_RE, ' ').trim() : '';
}

/**
 * Collects the strings of explanation blocks, in authoring order.
 * @param {unknown} value
 * @param {(s: unknown) => string} toText
 * @param {string[]} out
 * @param {number} [depth]
 */
function collectStrings(value, toText, out, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const t = toText(value);
    if (t) out.push(t);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, toText, out, depth + 1);
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) if (!NON_TEXT_KEYS.has(k)) collectStrings(v, toText, out, depth + 1);
  }
}

/**
 * The strings of a question, per field (empty strings left out).
 * @param {Record<string, any>} q
 * @param {(s: unknown) => string} toText {@link plain} (visible text) or {@link tokenText} (index build).
 * @returns {Record<keyof typeof FIELD_WEIGHTS, string[]>}
 */
function fieldParts(q, toText) {
  const choices = Array.isArray(q.choices) ? q.choices.filter(isObj) : [];
  /** @type {string[]} */
  const notes = [];
  if (isObj(q.choiceNotes)) {
    const done = new Set();
    for (const c of choices) {
      if (typeof c.id === 'string' && Object.hasOwn(q.choiceNotes, c.id)) {
        notes.push(toText(q.choiceNotes[c.id]));
        done.add(c.id);
      }
    }
    for (const [k, v] of Object.entries(q.choiceNotes)) if (!done.has(k)) notes.push(toText(v));
  }
  /** @type {string[]} */
  const explanation = [];
  if (Array.isArray(q.explanation)) collectStrings(q.explanation, toText, explanation);
  const keep = (/** @type {string[]} */ list) => list.filter((s) => s !== '');
  return {
    stem: keep([toText(q.stem)]),
    topic: keep([typeof q.topic === 'string' ? q.topic : '']),
    tags: keep(Array.isArray(q.tags) ? q.tags.filter((t) => typeof t === 'string') : []),
    choices: keep(choices.map((c) => toText(c.text))),
    notes: keep(notes),
    explanation,
  };
}

/**
 * Plain text of a question for snippets: stem, choices, choice notes,
 * explanation, topic, tags (each part separated by " · ").
 * @param {Record<string, any>} q
 * @returns {string}
 */
function questionText(q) {
  const parts = fieldParts(q, plain);
  return TEXT_ORDER.flatMap((f) => parts[/** @type {keyof typeof FIELD_WEIGHTS} */ (f)].map(collapse))
    .filter(Boolean)
    .join(PART_SEPARATOR);
}

/**
 * Result title: the start of the plain stem, cut at a word boundary.
 * @param {string} stem Plain stem.
 * @param {number} [max]
 * @returns {string}
 */
function makeTitle(stem, max = TITLE_LENGTH) {
  const s = collapse(stem);
  if (s.length <= max) return s;
  let cut = s.lastIndexOf(' ', max);
  if (cut < max * 0.6) cut = max;
  return `${s.slice(0, cut).replace(TRAILING_PUNCT_RE, '')}…`;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/** Field names with their weights, in build order. */
const WEIGHTED_FIELDS = Object.freeze(
  /** @type {[keyof typeof FIELD_WEIGHTS, number][]} */ (Object.entries(FIELD_WEIGHTS)),
);

/**
 * Incremental index builder (lets {@link search} build in time slices).
 *
 * Every distinct token gets a numeric id on first sight (one Map lookup per
 * token occurrence); per-question counting then uses typed arrays indexed by
 * token id, reset lazily with "stamps". Postings are appended to two growing
 * typed arrays (token id, packed posting) and laid out by token at the end
 * with a counting sort, so the build allocates almost nothing per question.
 *
 * @returns {{ add(q: unknown): boolean, finish(): SearchIndex }}
 */
function createBuilder() {
  /** @type {IndexedDoc[]} */
  const docs = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Map<string, number>} token → id */
  const ids = new Map();
  /** @type {number[]} token ids touched by the current question */
  const touched = [];
  let capacity = 4096;
  let docScore = new Int32Array(capacity);
  let docStamp = new Int32Array(capacity);
  let fieldCount = new Int32Array(capacity);
  let fieldStamp = new Int32Array(capacity);
  let postingCount = new Int32Array(capacity);
  /** Appended postings: token id and packed value, in question order. */
  let pairToken = new Int32Array(1 << 16);
  let pairValue = new Int32Array(1 << 16);
  let pairs = 0;
  let docMark = 0;
  let fieldMark = 0;
  let weight = 0;
  const maxPos = 2 ** (31 - SCORE_BITS) - 1;

  /** Doubles the per-token arrays. */
  const grow = () => {
    capacity *= 2;
    const bigger = (/** @type {Int32Array} */ a) => {
      const b = new Int32Array(capacity);
      b.set(a);
      return b;
    };
    docScore = bigger(docScore);
    docStamp = bigger(docStamp);
    fieldCount = bigger(fieldCount);
    fieldStamp = bigger(fieldStamp);
    postingCount = bigger(postingCount);
  };

  /** Makes room for `n` more postings. */
  const reserve = (/** @type {number} */ n) => {
    if (pairs + n <= pairToken.length) return;
    let size = pairToken.length * 2;
    while (size < pairs + n) size *= 2;
    const t = new Int32Array(size);
    const v = new Int32Array(size);
    t.set(pairToken.subarray(0, pairs));
    v.set(pairValue.subarray(0, pairs));
    pairToken = t;
    pairValue = v;
  };

  /** @param {string} token */
  const count = (token) => {
    let id = ids.get(token);
    if (id === undefined) {
      id = ids.size;
      ids.set(ownString(token), id);
      if (id >= capacity) grow();
    }
    if (fieldStamp[id] !== fieldMark) {
      fieldStamp[id] = fieldMark;
      fieldCount[id] = 0;
    }
    if (fieldCount[id] >= MAX_COUNTED_REPEATS) return;
    fieldCount[id]++;
    if (docStamp[id] !== docMark) {
      docStamp[id] = docMark;
      docScore[id] = 0;
      touched.push(id);
    }
    docScore[id] += weight;
  };

  return {
    add(q) {
      if (!isObj(q) || typeof q.id !== 'string' || q.id === '' || seen.has(q.id)) return false;
      if (docs.length >= maxPos) return false;
      seen.add(q.id);
      const pos = docs.length;
      const parts = fieldParts(q, tokenText);
      docMark++;
      touched.length = 0;
      for (const [field, w] of WEIGHTED_FIELDS) {
        const list = parts[field];
        if (list.length === 0) continue;
        fieldMark++;
        weight = w;
        eachToken(list.length === 1 ? list[0] : list.join('\n'), count);
      }
      const base = pos << SCORE_BITS;
      reserve(touched.length);
      for (const id of touched) {
        pairToken[pairs] = id;
        pairValue[pairs] = base | Math.min(docScore[id], SCORE_MASK);
        pairs++;
        postingCount[id]++;
      }
      docs.push({
        qid: q.id,
        chapterId: typeof q.chapterId === 'string' ? q.chapterId : null,
        stemKey: ` ${phraseOf(parts.stem.join(' '))} `,
        question: /** @type {Question} */ (q),
      });
      return true;
    },

    finish() {
      const vocab = [...ids.keys()].sort();
      const offsets = new Int32Array(vocab.length + 1);
      /** Next free slot of each token id in `postings`. */
      const cursor = new Int32Array(vocab.length);
      let at = 0;
      for (let i = 0; i < vocab.length; i++) {
        const id = /** @type {number} */ (ids.get(vocab[i]));
        offsets[i] = at;
        cursor[id] = at;
        at += postingCount[id];
      }
      offsets[vocab.length] = at;
      // Pairs are in question order, so each token's postings stay sorted by position.
      const postings = new Int32Array(pairs);
      for (let k = 0; k < pairs; k++) postings[cursor[pairToken[k]]++] = pairValue[k];
      ids.clear();
      pairToken = new Int32Array(0);
      pairValue = new Int32Array(0);
      return Object.freeze({ size: docs.length, docs: Object.freeze(docs), vocab: Object.freeze(vocab), offsets, postings });
    },
  };
}

/**
 * Builds the inverted index of a list of questions (bank order is kept;
 * malformed entries and repeated ids are skipped).
 *
 * @param {Iterable<Question> | null | undefined} questions
 * @returns {SearchIndex} A frozen index for {@link queryIndex}.
 */
export function buildIndex(questions) {
  const builder = createBuilder();
  if (questions && typeof (/** @type {any} */ (questions)[Symbol.iterator]) === 'function') {
    for (const q of questions) builder.add(q);
  }
  return builder.finish();
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * @typedef {object} QueryTerm
 * @property {string} text               Token to match (the joined form for a hyphenated word).
 * @property {string[] | null} parts     Kept parts of a hyphenated word (null otherwise).
 * @property {boolean} lastPartIsLast    The last kept part is the word's real last part.
 * @property {boolean} prefix            Last term: matches as a prefix.
 */

/**
 * @typedef {object} ParsedQuery
 * @property {QueryTerm[]} terms
 * @property {string} phrase             ' word word…' (≥ 2 words) for the stem phrase bonus, else ''.
 * @property {string[]} marks            Tokens to highlight in snippets.
 */

/**
 * @param {unknown} query
 * @returns {ParsedQuery}
 */
function parseQuery(query) {
  const folded = typeof query === 'string' ? fold(query) : '';
  /** @type {Map<string, QueryTerm>} by word (insertion order = query order) */
  const byWord = new Map();
  for (const m of folded.matchAll(WORD_RE)) {
    const word = m[0];
    if (byWord.has(word)) {
      // A repeated word moves to the end: it is the word being typed.
      const term = /** @type {QueryTerm} */ (byWord.get(word));
      byWord.delete(word);
      byWord.set(word, term);
      continue;
    }
    if (byWord.size >= MAX_QUERY_TERMS) break;
    if (word.indexOf('-') === -1) {
      if (keepToken(word)) byWord.set(word, { text: word, parts: null, lastPartIsLast: false, prefix: false });
      continue;
    }
    const raw = word.split('-');
    const kept = raw.filter(keepToken);
    byWord.set(word, {
      text: raw.join(''),
      parts: kept.length > 0 ? kept : null,
      lastPartIsLast: keepToken(raw[raw.length - 1]),
      prefix: false,
    });
  }
  const terms = [...byWord.values()];
  if (terms.length > 0) terms[terms.length - 1].prefix = true;
  const marks = new Set(terms.flatMap((t) => [t.text, ...(t.parts ?? [])]));
  const runs = folded.match(RUN_RE) ?? [];
  return { terms, phrase: runs.length >= 2 ? ` ${runs.join(' ')}` : '', marks: [...marks] };
}

/**
 * First index of `vocab` whose token is ≥ `s`.
 * @param {ReadonlyArray<string>} vocab
 * @param {string} s
 * @returns {number}
 */
function lowerBound(vocab, s) {
  let lo = 0;
  let hi = vocab.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (vocab[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Best score per question of one token (or of every token with that prefix).
 * @param {SearchIndex} index
 * @param {string} token
 * @param {boolean} prefix
 * @returns {Int32Array | null} Null when no question matches.
 */
function tokenScores(index, token, prefix) {
  const { vocab, offsets, postings } = index;
  const lo = lowerBound(vocab, token);
  let hi = lo;
  if (prefix) hi = lowerBound(vocab, `${token}\uffff`);
  else if (vocab[lo] === token) hi = lo + 1;
  if (hi <= lo) return null;
  const out = new Int32Array(index.size);
  for (let k = offsets[lo], end = offsets[hi]; k < end; k++) {
    const v = postings[k];
    const pos = v >>> SCORE_BITS;
    const score = v & SCORE_MASK;
    if (score > out[pos]) out[pos] = score;
  }
  return out;
}

/**
 * AND: keeps the questions matched by both, adding their scores (in place).
 * @param {Int32Array} total
 * @param {Int32Array} scores
 * @returns {boolean} True while at least one question is left.
 */
function andInto(total, scores) {
  let any = false;
  for (let i = 0; i < total.length; i++) {
    if (total[i] > 0 && scores[i] > 0) {
      total[i] += scores[i];
      any = true;
    } else total[i] = 0;
  }
  return any;
}

/**
 * Scores of one query term. A hyphenated word matches its joined form
 * ("kilolima") or all of its parts ("kilo" and "lima"); a joined-form match
 * counts once per part, so both ways of writing the word score alike.
 * @param {SearchIndex} index
 * @param {QueryTerm} term
 * @returns {Int32Array | null}
 */
function termScores(index, term) {
  const direct = tokenScores(index, term.text, term.prefix);
  if (!term.parts) return direct;
  /** @type {Int32Array | null} */
  let both = null;
  const last = term.parts.length - 1;
  for (let i = 0; i <= last; i++) {
    const s = tokenScores(index, term.parts[i], term.prefix && i === last && term.lastPartIsLast);
    if (!s) {
      both = null;
      break;
    }
    if (!both) both = s;
    else if (!andInto(both, s)) {
      both = null;
      break;
    }
  }
  if (!direct) return both;
  const perPart = term.parts.length;
  for (let i = 0; i < direct.length; i++) {
    const viaJoined = direct[i] * perPart;
    direct[i] = both && both[i] > viaJoined ? both[i] : viaJoined;
  }
  return direct;
}

/**
 * @param {unknown} limit
 * @returns {number}
 */
function normalizeLimit(limit) {
  if (limit === Infinity) return Infinity;
  return typeof limit === 'number' && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_LIMIT;
}

/**
 * Runs a parsed query.
 * @param {SearchIndex} index
 * @param {ParsedQuery} parsed
 * @param {number} limit
 * @returns {SearchHit[]}
 */
function runQuery(index, parsed, limit) {
  if (!index || !(index.size > 0) || parsed.terms.length === 0) return [];
  /** @type {Int32Array | null} */
  let total = null;
  for (const term of parsed.terms) {
    const scores = termScores(index, term);
    if (!scores) return [];
    if (!total) total = scores;
    else if (!andInto(total, scores)) return [];
  }
  if (!total) return [];
  /** @type {{ pos: number, score: number }[]} */
  const hits = [];
  for (let pos = 0; pos < total.length; pos++) {
    let score = total[pos];
    if (score <= 0) continue;
    if (parsed.phrase && index.docs[pos].stemKey.includes(parsed.phrase)) score += PHRASE_BONUS;
    hits.push({ pos, score });
  }
  hits.sort((a, b) => b.score - a.score || a.pos - b.pos);
  const kept = limit < hits.length ? hits.slice(0, limit) : hits;
  return kept.map(({ pos, score }) => ({ qid: index.docs[pos].qid, chapterId: index.docs[pos].chapterId, score, pos }));
}

/**
 * Finds the questions matching every term of `query` (AND; the last term
 * also matches as a prefix), best first; ties keep bank order.
 *
 * @param {SearchIndex} index From {@link buildIndex}.
 * @param {string} query What the user typed.
 * @param {{ limit?: number }} [options] `limit`: a positive integer (default
 *   {@link DEFAULT_LIMIT}); `Infinity` returns every hit.
 * @returns {SearchHit[]} Empty for an empty query or no match.
 */
export function queryIndex(index, query, { limit = DEFAULT_LIMIT } = {}) {
  return runQuery(index, parseQuery(query), normalizeLimit(limit));
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

/**
 * Folds a string for matching and keeps a way back to the original offsets.
 * Only characters whose folded length differs are recorded, so ASCII text
 * and most accented text cost nothing extra.
 * @param {string} text
 * @returns {{ folded: string, toStart(k: number): number, toEnd(k: number): number }}
 */
function foldWithOffsets(text) {
  if (ASCII_RE.test(text)) {
    const same = (/** @type {number} */ k) => k;
    return { folded: text.toLowerCase(), toStart: same, toEnd: same };
  }
  /** @type {string[]} */
  const pieces = [];
  /** @type {{ fs: number, fe: number, os: number, oe: number }[]} */
  const changed = [];
  let last = 0;
  let fpos = 0;
  for (const m of text.matchAll(NON_ASCII_RE)) {
    const i = /** @type {number} */ (m.index);
    const ch = m[0];
    const run = text.slice(last, i).toLowerCase();
    pieces.push(run);
    fpos += run.length;
    const f = fold(ch);
    pieces.push(f);
    if (f.length !== ch.length) changed.push({ fs: fpos, fe: fpos + f.length, os: i, oe: i + ch.length });
    fpos += f.length;
    last = i + ch.length;
  }
  pieces.push(text.slice(last).toLowerCase());

  /**
   * @param {number} k Folded offset.
   * @param {boolean} isEnd
   * @returns {number} Original offset.
   */
  const map = (k, isEnd) => {
    let delta = 0;
    for (const c of changed) {
      if (c.fe <= k) {
        delta += c.oe - c.os - (c.fe - c.fs);
        continue;
      }
      if (c.fs < k) return isEnd ? c.oe : c.os; // inside an expanded character: take all of it
      break;
    }
    return k + delta;
  };
  return { folded: pieces.join(''), toStart: (k) => map(k, false), toEnd: (k) => map(k, true) };
}

/**
 * Word-start matches of any of `terms` in `text`, as original offsets.
 * @param {string} text Whitespace-collapsed text.
 * @param {string[]} terms Folded tokens.
 * @returns {[number, number][]} Sorted, non-overlapping.
 */
function findMatches(text, terms) {
  if (terms.length === 0) return [];
  const alts = [...terms].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})`, 'gu');
  const { folded, toStart, toEnd } = foldWithOffsets(text);
  /** @type {[number, number][]} */
  const out = [];
  for (const m of folded.matchAll(re)) {
    const s = toStart(/** @type {number} */ (m.index));
    const e = toEnd(/** @type {number} */ (m.index) + m[0].length);
    if (e > s && (out.length === 0 || s >= out[out.length - 1][1])) out.push([s, e]);
  }
  return out;
}

/**
 * Appends a segment, merging it with the previous one of the same kind.
 * @param {SnippetSegment[]} segs
 * @param {string} text
 * @param {boolean} match
 */
function pushSegment(segs, text, match) {
  if (!text) return;
  const prev = segs[segs.length - 1];
  if (prev && prev.match === match) prev.text += text;
  else segs.push({ text, match });
}

/**
 * Cuts text around the first match of any term and marks every match inside
 * the cut. The cut starts and ends at word boundaries when possible and gets
 * an ellipsis ("…") on each side where text was left out. Matching is folded
 * like {@link tokenize} (case, accents, Greek letters) and anchored at word
 * starts, so the term "valv" marks the start of "Valves".
 *
 * @param {unknown} text Plain text (whitespace is collapsed).
 * @param {Iterable<string>} terms Words to mark (folded like {@link tokenize}).
 * @param {number} [maxLen] Longest cut, in characters (default {@link SNIPPET_LENGTH}, at least 20).
 * @returns {SnippetSegment[]} Segments in order; empty for empty text. Without
 *   a match: the start of the text, unmarked.
 */
export function makeSnippet(text, terms, maxLen = SNIPPET_LENGTH) {
  const src = collapse(typeof text === 'string' ? text : '');
  if (!src) return [];
  const max = Math.max(20, Math.floor(Number(maxLen)) || SNIPPET_LENGTH);
  /** @type {Set<string>} */
  const wanted = new Set();
  for (const t of terms ?? []) {
    if (typeof t !== 'string') continue;
    const f = (fold(t).match(RUN_RE) ?? []).join('');
    if (f) wanted.add(f);
  }
  const matches = findMatches(src, [...wanted]);

  let start = 0;
  let end = Math.min(src.length, max);
  if (matches.length > 0) {
    const [s, e] = matches[0];
    const matchLen = Math.min(e - s, max);
    start = Math.max(0, s - Math.floor((max - matchLen) / 3));
    end = Math.min(src.length, start + max);
    if (end - start < max) start = Math.max(0, end - max);
    // Start at a word start, never after the match.
    if (start > 0 && src[start - 1] !== ' ') {
      const sp = src.indexOf(' ', start);
      if (sp !== -1 && sp < s) start = sp + 1;
    }
    // End at a word end, never before the match ends.
    if (end < src.length && src[end] !== ' ') {
      const sp = src.lastIndexOf(' ', end - 1);
      if (sp >= Math.min(e, end)) end = sp;
    }
  } else if (end < src.length && src[end] !== ' ') {
    const sp = src.lastIndexOf(' ', end - 1);
    if (sp > max * 0.6) end = sp;
  }
  while (start < end && src[start] === ' ') start++;
  while (end > start && src[end - 1] === ' ') end--;

  /** @type {SnippetSegment[]} */
  const segs = [];
  if (start > 0) pushSegment(segs, '…', false);
  let pos = start;
  for (const [a, b] of matches) {
    if (b <= pos) continue;
    if (a >= end) break;
    const ca = Math.max(a, pos);
    const cb = Math.min(b, end);
    pushSegment(segs, src.slice(pos, ca), false);
    pushSegment(segs, src.slice(ca, cb), true);
    pos = cb;
  }
  pushSegment(segs, src.slice(pos, end), false);
  if (end < src.length) pushSegment(segs, '…', false);
  return segs;
}

// ---------------------------------------------------------------------------
// Search over the study bank (lazy data, memoized index)
// ---------------------------------------------------------------------------

/** @type {SearchBackend | null} */
let testBackend = null;
/** @type {Promise<typeof import('../core/data.js')> | null} */
let dataModule = null;
/** @type {{ key: string, promise: Promise<SearchIndex> } | null} */
let memo = null;

/** @returns {Promise<SearchBackend['data']>} */
function dataApi() {
  if (testBackend) return Promise.resolve(testBackend.data);
  if (!dataModule) {
    dataModule = import('../core/data.js');
    dataModule.catch(() => {
      dataModule = null;
    });
  }
  return dataModule;
}

/** @returns {number} */
function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Lets the page handle input and paint between build slices.
 * @returns {Promise<void>}
 */
function yieldToPage() {
  const sched = /** @type {any} */ (globalThis).scheduler;
  if (sched && typeof sched.yield === 'function') return sched.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * {@link buildIndex} in time slices of {@link BUILD_SLICE_MS}.
 * @param {Question[]} questions
 * @returns {Promise<SearchIndex>}
 */
async function buildIndexInSlices(questions) {
  const builder = createBuilder();
  let sliceStart = clock();
  for (const q of questions) {
    builder.add(q);
    if (clock() - sliceStart > BUILD_SLICE_MS) {
      await yieldToPage();
      sliceStart = clock();
    }
  }
  return builder.finish();
}

/**
 * The index of the current study bank (memoized; rebuilt when the study
 * chapters or their counts change). A failed build is forgotten, so the
 * next call retries.
 * @returns {Promise<SearchIndex>}
 */
async function ensureIndex() {
  const data = await dataApi();
  const chapters = await data.studyChapters();
  const key = (chapters ?? []).map((c) => `${c.id}:${c.count}`).join('|');
  if (memo && memo.key === key) return memo.promise;
  const entry = {
    key,
    promise: Promise.resolve()
      .then(() => data.loadStudyBank())
      .then((bank) => buildIndexInSlices(Array.isArray(bank) ? bank : [])),
  };
  memo = entry;
  entry.promise.catch(() => {
    if (memo === entry) memo = null;
  });
  return entry.promise;
}

/**
 * Searches the study bank (published chapters, or the demo in demo mode).
 * The first call loads the bank and builds the index; later calls reuse it.
 *
 * @param {string} query What the user typed. Empty or whitespace → `[]`
 *   (nothing is loaded).
 * @param {{ limit?: number }} [options] `limit`: a positive integer (default
 *   {@link DEFAULT_LIMIT}); `Infinity` returns every hit.
 * @returns {Promise<SearchResult[]>} Best first; ties keep bank order.
 * @throws {import('../core/data.js').DataError} When the question bank can't be loaded
 *   (plain-language `message`).
 * @example
 * const results = await search('valve rep');
 * results[0].snippet; // [{ text: '…the ', match: false }, { text: 'valve', match: true }, …]
 */
export async function search(query, { limit = DEFAULT_LIMIT } = {}) {
  if (typeof query !== 'string' || query.trim() === '') return [];
  const parsed = parseQuery(query);
  if (parsed.terms.length === 0) return [];
  const index = await ensureIndex();
  return runQuery(index, parsed, normalizeLimit(limit)).map((hit) => {
    const q = index.docs[hit.pos].question;
    return {
      qid: hit.qid,
      chapterId: hit.chapterId,
      title: makeTitle(plain(q.stem)),
      snippet: makeSnippet(questionText(q), parsed.marks),
      score: hit.score,
    };
  });
}

/**
 * Builds the search index ahead of time (for example when the Search screen
 * opens), so the first keystroke answers instantly. Safe to call often.
 *
 * @returns {Promise<void>}
 * @throws {import('../core/data.js').DataError} When the question bank can't be loaded.
 */
export async function prepareSearchIndex() {
  await ensureIndex();
}

/**
 * Forgets the memoized index; the next {@link search} rebuilds it (for
 * example after the question data was reloaded).
 * @returns {void}
 */
export function clearSearchIndex() {
  memo = null;
}

/**
 * Unit-test seam: replaces the data module (`{ data }`), or restores the real
 * one with `null`. Also forgets the memoized index.
 * @param {SearchBackend | null} backend
 * @returns {void}
 */
export function setTestBackend(backend) {
  testBackend = isObj(backend) && isObj(backend.data) ? /** @type {SearchBackend} */ (backend) : null;
  memo = null;
}
