/**
 * Inline mini-markup parser (docs/ARCHITECTURE.md §3.5).
 *
 * Every string field of a question (stem, choices, choice notes) and of its
 * explanation blocks may carry a tiny, safe markup. This module turns such a
 * string into a token tree; `features/explain/render.js` builds the DOM from
 * the tokens with DOM APIs, so no string is ever parsed as HTML.
 *
 * | markup                         | token                        |
 * |--------------------------------|------------------------------|
 * | `**bold**`                     | `strong`                     |
 * | `_italic_`                     | `em`                         |
 * | `==key==`                      | `mark`                       |
 * | `x^2^`                         | `sup`                        |
 * | `CO~2~`                        | `sub`                        |
 * | `` `code` ``                   | `code`                       |
 * | `->` `<-` `<->` `=>` `<=>`     | `arrow` (`→ ← ↔ ⇒ ⇔`)        |
 * | `→ ← ↔ ⇒ ⇔ ↑ ↓` typed directly | `arrow` (the same character) |
 * | `\*` `\_` `\=` … (escapes)     | literal text                 |
 *
 * Rules (examples in the architecture doc):
 * - A marker is a run of exactly the right length: `**` and `==`, or a single
 *   `_`, `^`, `~`, `` ` ``. Other runs (`*`, `***`, `__`, `____`, `~~`, `===`)
 *   are literal text.
 * - Flanking: an opening marker must be followed by a non-space and a closing
 *   marker preceded by a non-space; the string's start and end count as space.
 * - `_` also needs a word boundary: no letter, digit or `_` right before the
 *   opening `_` or right after the closing `_` (`snake_case_words` stay literal).
 * - `code`, `sup` and `sub` are atomic spans, taken left to right: an opening
 *   marker is closed by the next marker of the same kind. Code content is
 *   literal text. Sup/sub content must be non-empty with no whitespace, and
 *   holds only text and arrows (`~5 mm to ~10 mm` stays literal).
 * - `strong`, `em` and `mark` pair like CommonMark: a closing marker pairs
 *   with the nearest open marker of its kind, and markers opened in between
 *   that are still open become literal. They nest in each other, up to
 *   {@link MAX_NESTING} levels; deeper pairs stay literal.
 * - Arrows: longest match first. Literal: a `-` or `=` inside a longer run
 *   (`-->`, `<--`, `==>`), `<-` right before a digit (`<-5` means "less than
 *   −5"), and anything with an escaped character.
 * - A backslash before one of `\ * _ = ^ ~ \` - < >` makes that character
 *   literal (inside code too); before any other character it is kept.
 * - Unclosed markers render literally. Adjacent text tokens are merged and no
 *   token is empty.
 *
 * Algorithm: one pass resolves escapes; one left-to-right scan emits text,
 * arrows, the atomic code/sup/sub spans and strong/em/mark marker candidates;
 * a delimiter stack pairs the candidates; a last pass builds the tree. Each
 * step is linear in the input length (no regex backtracking), so long or
 * broken input never stalls the UI. Neither function throws.
 *
 * Pure: no DOM, no I/O, no state. Importing this module touches nothing.
 *
 * @module features/explain/inline
 */

/**
 * @typedef {'strong'|'em'|'mark'|'sup'|'sub'|'code'} ContainerType
 * @typedef {{ t: 'text', v: string }} TextToken
 * @typedef {{ t: 'arrow', v: string }} ArrowToken       `v` is the arrow character, e.g. `"→"`.
 * @typedef {{ t: ContainerType, c: Token[] }} ContainerToken
 *   `c` of `sup`/`sub` holds only text and arrow tokens; `c` of `code` holds one text token.
 * @typedef {TextToken | ArrowToken | ContainerToken} Token
 */

/**
 * A strong/em/mark marker candidate found by the scan (internal).
 * @typedef {object} Delim
 * @property {'delim'} t
 * @property {'strong'|'em'|'mark'} type
 * @property {string} raw            The marker as typed: `**`, `_` or `==`.
 * @property {boolean} canOpen
 * @property {boolean} canClose
 * @property {Delim | null} partner  The marker it pairs with, once paired.
 * @property {boolean} opens         True on the opening marker of a pair.
 * @property {boolean} built         True when the pair became a container (depth allowed it).
 */

/**
 * The input with escapes resolved (internal). Indexes are UTF-16 code units;
 * every markup character is a single unit.
 * @typedef {object} Source
 * @property {string} s        Text with each escaping backslash removed.
 * @property {Uint8Array} lit  1 at each escaped character: always literal, never part of a marker or arrow.
 * @property {number} n        `s.length`.
 */

/**
 * An arrow found at some position (internal).
 * @typedef {{ v: string, len: number }} ArrowHit
 */

/** Deepest allowed nesting of strong/em/mark tokens; deeper pairs render literally. */
export const MAX_NESTING = 8;

const BACKTICK = 0x60;
const SPACE = 0x20;

/** Characters a backslash can escape. */
const ESCAPABLE = new Set(['\\', '*', '_', '=', '^', '~', '`', '-', '<', '>']);

/** Arrow characters that become arrow tokens when typed directly. */
const ARROW_CHARS = Object.freeze(['→', '←', '↔', '⇒', '⇔', '↑', '↓']);

/** @type {Map<string, ArrowHit>} */
const TYPED_ARROWS = new Map(ARROW_CHARS.map((c) => [c, Object.freeze({ v: c, len: 1 })]));

/** ASCII arrows, longest first (so `<->` wins over `<-`). */
const ASCII_ARROWS = Object.freeze(
  [
    ['<->', '↔'],
    ['<=>', '⇔'],
    ['->', '→'],
    ['<-', '←'],
    ['=>', '⇒'],
  ].map(([seq, v]) => Object.freeze({ seq, v, len: seq.length })),
);

/** Arrow characters that must not touch a copy of themselves (`-->`, `<--`, `==>` stay literal). */
const RUN_CHARS = new Set(['-', '=']);

/**
 * Marker characters: the token they make and the exact run length that counts
 * as a marker. Keyed by char code.
 * @type {Map<number, Readonly<{ ch: string, type: ContainerType, len: number }>>}
 */
const MARKERS = new Map(
  /** @type {Array<[string, ContainerType, number]>} */ ([
    ['*', 'strong', 2],
    ['_', 'em', 1],
    ['=', 'mark', 2],
    ['^', 'sup', 1],
    ['~', 'sub', 1],
    ['`', 'code', 1],
  ]).map(([ch, type, len]) => [ch.charCodeAt(0), Object.freeze({ ch, type, len })]),
);

/** ASCII codes that may start a marker or an arrow (1 = special). */
const ASCII_SPECIAL = new Uint8Array(128);
for (const c of '*_=^~`<-') ASCII_SPECIAL[c.charCodeAt(0)] = 1;

/** Any character that can change parsing; strings without one are plain text. */
const PARSE_TRIGGER_RE = /[\\*_=^~`<→←↔⇒⇔↑↓-]/u;
/** Any character that can change the plain text (typed arrow characters render as themselves). */
const PLAIN_TRIGGER_RE = /[\\*_=^~`<-]/;
const SPACE_RE = /\s/u;
const WORD_RE = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Parses an inline mini-markup string into tokens.
 *
 * @param {unknown} text
 * @returns {Token[]} A fresh token tree; `[]` for a non-string or `''`.
 * @example parseInline('**Key** -> CO~2~')
 * // [{ t: 'strong', c: [{ t: 'text', v: 'Key' }] }, { t: 'text', v: ' ' },
 * //  { t: 'arrow', v: '→' }, { t: 'text', v: ' CO' }, { t: 'sub', c: [{ t: 'text', v: '2' }] }]
 */
export function parseInline(text) {
  if (typeof text !== 'string' || text === '') return [];
  if (!PARSE_TRIGGER_RE.test(text)) return [{ t: 'text', v: text }];
  const items = scan(lex(text));
  pairDelims(items);
  return build(items);
}

/**
 * The visible text of an inline mini-markup string, exactly as rendered:
 * markers removed, escapes resolved, arrows as their Unicode characters,
 * whitespace kept as is. Used for search, text anchoring and the GPT prompt.
 *
 * @param {unknown} text
 * @returns {string} `''` for a non-string.
 * @example inlineToPlain('_Settings_ -> **Data**') // 'Settings → Data'
 */
export function inlineToPlain(text) {
  if (typeof text !== 'string') return '';
  if (!PLAIN_TRIGGER_RE.test(text)) return text;
  /** @type {string[]} */
  const out = [];
  collectPlain(parseInline(text), out);
  return out.join('');
}

/**
 * @param {Token[]} tokens
 * @param {string[]} out
 */
function collectPlain(tokens, out) {
  for (const tok of tokens) {
    if ('c' in tok) collectPlain(tok.c, out);
    else out.push(tok.v);
  }
}

// ---------------------------------------------------------------------------
// Escapes and character tests
// ---------------------------------------------------------------------------

/**
 * Resolves backslash escapes: `\x` (x escapable) becomes a literal `x`.
 * @param {string} text
 * @returns {Source}
 */
function lex(text) {
  if (!text.includes('\\')) return { s: text, lit: new Uint8Array(text.length), n: text.length };
  /** @type {string[]} */
  const parts = [];
  /** @type {number[]} */
  const escaped = [];
  let from = 0;
  let outLen = 0;
  let i = text.indexOf('\\');
  while (i !== -1) {
    if (i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      parts.push(text.slice(from, i));
      outLen += i - from;
      escaped.push(outLen);
      from = i + 1; // drop the backslash, keep the escaped character
      i = text.indexOf('\\', i + 2);
    } else {
      i = text.indexOf('\\', i + 1);
    }
  }
  parts.push(text.slice(from));
  const s = parts.join('');
  const lit = new Uint8Array(s.length);
  for (const k of escaped) lit[k] = 1;
  return { s, lit, n: s.length };
}

/**
 * True when the code unit at `k` is whitespace (`\s`).
 * @param {string} s
 * @param {number} k
 * @returns {boolean}
 */
function isSpaceAt(s, k) {
  const code = s.charCodeAt(k);
  if (code === SPACE) return true;
  if (code > SPACE && code < 0x7f) return false;
  return SPACE_RE.test(s[k]);
}

/**
 * True when the code point ending right before `i` is a letter, digit, mark or `_`.
 * @param {string} s
 * @param {number} i
 * @returns {boolean}
 */
function isWordBefore(s, i) {
  if (i <= 0) return false;
  const low = s.charCodeAt(i - 1);
  const high = i >= 2 ? s.charCodeAt(i - 2) : 0;
  const isPair = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
  return WORD_RE.test(String.fromCodePoint(/** @type {number} */ (s.codePointAt(isPair ? i - 2 : i - 1))));
}

/**
 * True when the code point starting at `i` is a letter, digit, mark or `_`.
 * @param {string} s
 * @param {number} i
 * @returns {boolean}
 */
function isWordAt(s, i) {
  if (i >= s.length) return false;
  return WORD_RE.test(String.fromCodePoint(/** @type {number} */ (s.codePointAt(i))));
}

/**
 * True when position `i` holds the unescaped character `c` (one code unit).
 * @param {Source} src
 * @param {number} i
 * @param {string} c
 * @returns {boolean}
 */
function isMarkerChar(src, i, c) {
  return i >= 0 && i < src.n && src.s[i] === c && src.lit[i] === 0;
}

// ---------------------------------------------------------------------------
// Arrows, code and sup/sub spans
// ---------------------------------------------------------------------------

/**
 * The arrow that starts at `i` and ends before `end`, if any (longest match first).
 * @param {Source} src
 * @param {number} i
 * @param {number} end
 * @returns {ArrowHit | null}
 */
function arrowAt(src, i, end) {
  if (src.lit[i]) return null;
  const c = src.s[i];
  if (c !== '<' && c !== '-' && c !== '=') return TYPED_ARROWS.get(c) ?? null;
  for (const arrow of ASCII_ARROWS) {
    const { seq, len } = arrow;
    if (!startsWithAt(src, i, end, seq)) continue;
    // A `-` or `=` inside a longer run (`-->`, `<--`, `==>`) is not an arrow.
    if (RUN_CHARS.has(seq[0]) && isMarkerChar(src, i - 1, seq[0])) continue;
    if (RUN_CHARS.has(seq[len - 1]) && isMarkerChar(src, i + len, seq[len - 1])) continue;
    // `<-5` means "less than minus five", not an arrow.
    if (seq === '<-' && i + len < end && isDigitAt(src.s, i + len)) continue;
    return arrow;
  }
  return null;
}

/**
 * @param {string} s
 * @param {number} k
 * @returns {boolean}
 */
function isDigitAt(s, k) {
  const code = s.charCodeAt(k);
  return code >= 0x30 && code <= 0x39;
}

/**
 * True when the unescaped characters of `seq` start at `i` and end before `end`.
 * @param {Source} src
 * @param {number} i
 * @param {number} end
 * @param {string} seq
 * @returns {boolean}
 */
function startsWithAt(src, i, end, seq) {
  if (i + seq.length > end) return false;
  for (let k = 0; k < seq.length; k++) {
    if (!isMarkerChar(src, i + k, seq[k])) return false;
  }
  return true;
}

/**
 * Text and arrow tokens of `[from, to)` (the content of a sup/sub span).
 * @param {Source} src
 * @param {number} from
 * @param {number} to
 * @returns {Token[]}
 */
function textAndArrows(src, from, to) {
  /** @type {Token[]} */
  const out = [];
  let runStart = from;
  let k = from;
  while (k < to) {
    const arrow = arrowAt(src, k, to);
    if (arrow) {
      if (k > runStart) out.push({ t: 'text', v: src.s.slice(runStart, k) });
      out.push({ t: 'arrow', v: arrow.v });
      k += arrow.len;
      runStart = k;
    } else {
      k += 1;
    }
  }
  if (to > runStart) out.push({ t: 'text', v: src.s.slice(runStart, to) });
  return out;
}

/**
 * For every position, the first valid closing backtick at or after it (-1 = none).
 * A closing backtick is unescaped, single (no unescaped backtick beside it) and
 * preceded by a non-space.
 * @param {Source} src
 * @returns {Int32Array}
 */
function codeCloserTable(src) {
  const { s, n } = src;
  const next = new Int32Array(n + 1);
  next[n] = -1;
  for (let k = n - 1; k >= 0; k--) {
    const closes =
      s.charCodeAt(k) === BACKTICK &&
      isMarkerChar(src, k, '`') &&
      k > 0 &&
      !isSpaceAt(s, k - 1) &&
      !isMarkerChar(src, k - 1, '`') &&
      !isMarkerChar(src, k + 1, '`');
    next[k] = closes ? k : next[k + 1];
  }
  return next;
}

/**
 * Index of the marker that closes a sup/sub span whose content starts at
 * `from`, or -1 when the span is not closed before whitespace or the end.
 * Stops at the first unescaped `c`, so every character is visited by at most
 * one failed scan per marker kind (linear overall).
 * @param {Source} src
 * @param {number} from
 * @param {string} c `^` or `~`.
 * @returns {number}
 */
function scriptClose(src, from, c) {
  for (let k = from; k < src.n; k++) {
    if (isSpaceAt(src.s, k)) return -1;
    if (isMarkerChar(src, k, c)) return isMarkerChar(src, k + 1, c) ? -1 : k;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Scan, pair, build
// ---------------------------------------------------------------------------

/**
 * Flat left-to-right scan: text, arrow, code/sup/sub tokens and strong/em/mark
 * marker candidates, in source order.
 * @param {Source} src
 * @returns {Array<Token | Delim>}
 */
function scan(src) {
  const { s, lit, n } = src;
  /** @type {Array<Token | Delim>} */
  const items = [];
  /** @type {Int32Array | null} */
  let codeClosers = null;
  let runStart = 0;
  /** Ends the current text run at `end` and emits it. @param {number} end */
  const flush = (end) => {
    if (end > runStart) items.push({ t: 'text', v: s.slice(runStart, end) });
  };

  let i = 0;
  while (i < n) {
    const code = s.charCodeAt(i);
    if (lit[i] === 1 || (code < 128 && ASCII_SPECIAL[code] === 0)) {
      i += 1;
      continue;
    }

    const arrow = arrowAt(src, i, n);
    if (arrow) {
      flush(i);
      items.push({ t: 'arrow', v: arrow.v });
      i += arrow.len;
      runStart = i;
      continue;
    }
    const marker = MARKERS.get(code);
    if (!marker) {
      i += 1;
      continue;
    }

    let end = i + 1;
    while (isMarkerChar(src, end, marker.ch)) end += 1;
    if (end - i !== marker.len) {
      i = end; // a run of the wrong length is literal text
      continue;
    }

    let canOpen = end < n && !isSpaceAt(s, end);
    let canClose = i > 0 && !isSpaceAt(s, i - 1);

    if (marker.type === 'code') {
      if (canOpen) {
        codeClosers ??= codeCloserTable(src);
        const close = codeClosers[end];
        if (close >= 0) {
          flush(i);
          items.push({ t: 'code', c: [{ t: 'text', v: s.slice(end, close) }] });
          i = close + 1;
          runStart = i;
          continue;
        }
      }
    } else if (marker.type === 'sup' || marker.type === 'sub') {
      if (canOpen) {
        const close = scriptClose(src, end, marker.ch);
        if (close >= 0) {
          flush(i);
          items.push({ t: marker.type, c: textAndArrows(src, end, close) });
          i = close + 1;
          runStart = i;
          continue;
        }
      }
    } else {
      if (marker.type === 'em') {
        canOpen = canOpen && !isWordBefore(s, i);
        canClose = canClose && !isWordAt(s, end);
      }
      if (canOpen || canClose) {
        flush(i);
        items.push(
          /** @type {Delim} */ ({
            t: 'delim',
            type: marker.type,
            raw: s.slice(i, end),
            canOpen,
            canClose,
            partner: null,
            opens: false,
            built: false,
          }),
        );
        i = end;
        runStart = i;
        continue;
      }
    }
    i = end; // the marker can't open or close here: literal text
  }
  flush(n);
  return items;
}

/**
 * Pairs strong/em/mark markers with a delimiter stack (sets `partner`/`opens`).
 * Each opener is pushed and removed at most once, so this is linear.
 * @param {Array<Token | Delim>} items
 */
function pairDelims(items) {
  /** @type {Delim[]} */
  const openers = [];
  /** Unpaired openers on the stack, per type. */
  const openCount = { strong: 0, em: 0, mark: 0 };
  for (const it of items) {
    if (it.t !== 'delim') continue;
    const d = /** @type {Delim} */ (it);
    if (d.canClose && openCount[d.type] > 0) {
      let k = openers.length - 1;
      while (openers[k].type !== d.type) k -= 1;
      const opener = openers[k];
      // Markers opened after `opener` can no longer pair: they stay literal.
      for (let j = openers.length - 1; j >= k; j--) openCount[openers[j].type] -= 1;
      openers.length = k;
      opener.partner = d;
      opener.opens = true;
      d.partner = opener;
    } else if (d.canOpen) {
      openers.push(d);
      openCount[d.type] += 1;
    }
  }
}

/**
 * Appends text to a token list, merging with a trailing text token.
 * @param {Token[]} list
 * @param {string} v
 */
function appendText(list, v) {
  if (!v) return;
  const last = list[list.length - 1];
  if (last && last.t === 'text') last.v += v;
  else list.push({ t: 'text', v });
}

/**
 * Builds the token tree from the scanned and paired items.
 * @param {Array<Token | Delim>} items
 * @returns {Token[]}
 */
function build(items) {
  /** @type {Token[]} */
  const root = [];
  /** Children lists of the open containers; `lists[0]` is the root. @type {Token[][]} */
  const lists = [root];
  /** @type {ContainerToken[]} */
  const open = [];
  for (const it of items) {
    const list = lists[lists.length - 1];
    if (it.t === 'text') {
      appendText(list, /** @type {TextToken} */ (it).v);
    } else if (it.t === 'delim') {
      const d = /** @type {Delim} */ (it);
      if (d.partner && d.opens && open.length < MAX_NESTING) {
        const node = /** @type {ContainerToken} */ ({ t: d.type, c: [] });
        d.built = true;
        open.push(node);
        lists.push(node.c);
      } else if (d.partner && !d.opens && d.partner.built) {
        const node = /** @type {ContainerToken} */ (open.pop());
        lists.pop();
        lists[lists.length - 1].push(node);
      } else {
        appendText(list, d.raw);
      }
    } else {
      list.push(/** @type {Token} */ (it));
    }
  }
  return root;
}
