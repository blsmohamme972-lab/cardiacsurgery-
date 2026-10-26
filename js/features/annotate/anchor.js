/**
 * Text anchoring for highlights (docs/ARCHITECTURE.md §7.7).
 *
 * An anchor describes a span of a block's text by its exact quote, up to
 * {@link CONTEXT_LENGTH} characters of text before (`prefix`) and after
 * (`suffix`) it, and its original offset (`start`). This survives screen size
 * changes (offsets are in text, not pixels) and small edits of the block
 * (the quote is found again by content and context).
 *
 * Offsets are UTF-16 code units, the same units as DOM `Range` offsets, and
 * always refer to the **block text**: the concatenation of the block's text
 * nodes in document order, built by {@link blockText}.
 *
 * The `[data-block]` rule: a `[data-block]` element contains only content text.
 * Subtrees marked `data-anchor-skip`, `<canvas>`, `<svg>`, `<button>`, form
 * controls, `<script>`/`<style>`/`<template>` and nested `[data-block]`
 * elements are ignored by every function here.
 *
 * The pure functions ({@link makeAnchor}, {@link findAnchor}) work on strings
 * only. The DOM functions touch `document` only when called, so importing
 * this module in Node is safe.
 *
 * @module features/annotate/anchor
 */

/** Characters of context stored before and after a quote. */
export const CONTEXT_LENGTH = 32;

/** Upper bound on candidate occurrences scored by {@link findAnchor}. */
const MAX_CANDIDATES = 1000;

/** Tags whose subtree never contributes block text. */
const SKIP_TAGS = new Set([
  'CANVAS',
  'SVG',
  'BUTTON',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'SCRIPT',
  'STYLE',
  'TEMPLATE',
  'NOSCRIPT',
]);

/**
 * @typedef {object} Anchor
 * @property {string} quote  The exact highlighted text.
 * @property {string} prefix Up to 32 characters before the quote.
 * @property {string} suffix Up to 32 characters after the quote.
 * @property {number} start  Offset of the quote in the block text when it was made.
 */

/**
 * @typedef {object} TextSpan
 * @property {number} start Inclusive offset.
 * @property {number} end   Exclusive offset.
 */

// ---------------------------------------------------------------------------
// Pure part
// ---------------------------------------------------------------------------

/**
 * @param {string} s
 * @param {number} i
 * @returns {boolean} True when `i` falls between the two halves of a surrogate pair.
 */
function splitsPair(s, i) {
  if (i <= 0 || i >= s.length) return false;
  const hi = s.charCodeAt(i - 1);
  const lo = s.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/**
 * @param {unknown} n
 * @param {number} fallback
 * @returns {number} An integer, or `fallback` for non-finite input.
 */
function toInt(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
}

/**
 * Builds an anchor for `blockText.slice(start, end)`.
 *
 * Offsets are clamped to the text and swapped when reversed; an offset that
 * falls inside a surrogate pair (emoji, rare symbols) is widened so the quote
 * never contains half a character, and the context never starts or ends with
 * half a character either. An empty span gives an empty quote (callers should
 * not store it).
 *
 * @param {string} blockText The block text (see {@link blockText}).
 * @param {number} start
 * @param {number} end
 * @returns {Anchor}
 * @example makeAnchor('one two three', 4, 7) // → {quote: 'two', prefix: 'one ', suffix: ' three', start: 4}
 */
export function makeAnchor(blockText, start, end) {
  const text = typeof blockText === 'string' ? blockText : String(blockText ?? '');
  let a = Math.min(Math.max(toInt(start, 0), 0), text.length);
  let b = Math.min(Math.max(toInt(end, a), 0), text.length);
  if (b < a) [a, b] = [b, a];
  if (splitsPair(text, a)) a -= 1;
  if (splitsPair(text, b)) b += 1;

  let prefixStart = Math.max(0, a - CONTEXT_LENGTH);
  if (splitsPair(text, prefixStart)) prefixStart += 1;
  let suffixEnd = Math.min(text.length, b + CONTEXT_LENGTH);
  if (splitsPair(text, suffixEnd)) suffixEnd -= 1;

  return {
    quote: text.slice(a, b),
    prefix: text.slice(prefixStart, a),
    suffix: text.slice(b, suffixEnd),
    start: a,
  };
}

/**
 * Length of the common suffix of two strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function commonSuffix(a, b) {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n += 1;
  return n;
}

/**
 * Length of the common prefix of two strings.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function commonPrefix(a, b) {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n += 1;
  return n;
}

/**
 * How well the text around an occurrence matches the stored context (0..1).
 * An empty stored prefix/suffix means the quote touched the block edge.
 * @param {string} text
 * @param {number} pos
 * @param {number} len
 * @param {string} prefix
 * @param {string} suffix
 * @returns {number}
 */
function contextScore(text, pos, len, prefix, suffix) {
  let p;
  if (prefix.length === 0) {
    p = pos === 0 ? 1 : 0.5;
  } else {
    const actual = text.slice(Math.max(0, pos - prefix.length), pos);
    p = commonSuffix(prefix, actual) / prefix.length;
  }
  let s;
  const end = pos + len;
  if (suffix.length === 0) {
    s = end === text.length ? 1 : 0.5;
  } else {
    const actual = text.slice(end, end + suffix.length);
    s = commonPrefix(suffix, actual) / suffix.length;
  }
  return (p + s) / 2;
}

/**
 * Finds the best occurrence of `quote` in `text`.
 * @param {string} text
 * @param {string} quote
 * @param {string} prefix
 * @param {string} suffix
 * @param {number} start Expected position.
 * @returns {number} Position, or -1 when the quote does not occur.
 */
function bestOccurrence(text, quote, prefix, suffix, start) {
  // Fast path: still exactly where it was, with the same context.
  if (start >= 0 && text.startsWith(quote, start) && contextScore(text, start, quote.length, prefix, suffix) === 1) {
    return start;
  }
  let best = -1;
  let bestScore = -Infinity;
  const span = Math.max(1, text.length);
  let count = 0;
  for (let pos = text.indexOf(quote); pos !== -1 && count < MAX_CANDIDATES; pos = text.indexOf(quote, pos + 1)) {
    count += 1;
    const ctx = contextScore(text, pos, quote.length, prefix, suffix);
    const proximity = 1 - Math.min(1, Math.abs(pos - start) / span);
    // Context dominates; proximity breaks ties; the original spot gets a small bonus
    // so a near-equal context elsewhere never steals the highlight.
    const score = ctx * 10 + proximity + (pos === start ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return best;
}

/**
 * Collapses every run of whitespace (including no-break spaces) to one space.
 * @param {string} s
 * @returns {{ text: string, map: number[] }} `map[i]` = index in `s` of normalized char `i`;
 *   `map[text.length]` = `s.length`.
 */
function normalizeSpace(s) {
  let out = '';
  /** @type {number[]} */
  const map = [];
  let inSpace = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (inSpace) continue;
      inSpace = true;
      out += ' ';
      map.push(i);
    } else {
      inSpace = false;
      out += ch;
      map.push(i);
    }
  }
  map.push(s.length);
  return { text: out, map };
}

/**
 * Index in normalized text closest to original index `orig`.
 * @param {number[]} map
 * @param {number} orig
 * @returns {number}
 */
function toNormalized(map, orig) {
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] < orig) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Finds an anchor in (possibly edited) block text.
 *
 * 1. The quote is still at `start` with the same context → that spot.
 * 2. Otherwise every exact occurrence of the quote is scored by how well its
 *    surrounding text matches `prefix`/`suffix` (then by distance from
 *    `start`) and the best one wins.
 * 3. Otherwise the same search runs with whitespace runs collapsed, so a
 *    re-wrapped or re-spaced block still matches.
 * 4. Otherwise `null` (the highlight is an orphan).
 *
 * @param {string} blockText
 * @param {Partial<Anchor> | null | undefined} anchor
 * @returns {TextSpan | null}
 * @example findAnchor('new: one two three', {quote: 'two', prefix: 'one ', suffix: ' three', start: 4}) // → {start: 9, end: 12}
 */
export function findAnchor(blockText, anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const quote = typeof anchor.quote === 'string' ? anchor.quote : '';
  if (quote === '') return null;
  const text = typeof blockText === 'string' ? blockText : String(blockText ?? '');
  const prefix = typeof anchor.prefix === 'string' ? anchor.prefix : '';
  const suffix = typeof anchor.suffix === 'string' ? anchor.suffix : '';
  const start = toInt(anchor.start, 0);

  const exact = bestOccurrence(text, quote, prefix, suffix, start);
  if (exact !== -1) return { start: exact, end: exact + quote.length };

  const nt = normalizeSpace(text);
  const nq = normalizeSpace(quote).text;
  if (nq.trim() === '') return null;
  const np = normalizeSpace(prefix).text;
  const ns = normalizeSpace(suffix).text;
  const pos = bestOccurrence(nt.text, nq, np, ns, toNormalized(nt.map, start));
  if (pos === -1) return null;
  const s = nt.map[pos];
  const e = nt.map[pos + nq.length - 1] + 1;
  return { start: s, end: e };
}

// ---------------------------------------------------------------------------
// DOM part
// ---------------------------------------------------------------------------

/**
 * True when `el` (an element) and its subtree never contribute block text.
 * @param {Element} el
 * @param {Element} block The block being walked (never skipped itself).
 * @returns {boolean}
 */
function isSkipped(el, block) {
  if (el === block) return false;
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.hasAttribute('data-anchor-skip')) return true;
  if (el.hasAttribute('data-block')) return true; // nested block: its own anchor space
  return false;
}

/**
 * The text nodes that make up a block's text, in document order, each with
 * its start offset in the block text.
 * @param {Element} el A `[data-block]` element.
 * @returns {{ node: Text, start: number }[]}
 */
export function blockTextNodes(el) {
  /** @type {{ node: Text, start: number }[]} */
  const out = [];
  if (!el) return out;
  const doc = el.ownerDocument || document;
  const walker = doc.createTreeWalker(el, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode(node) {
      if (node.nodeType === 3) return 1; // FILTER_ACCEPT
      return isSkipped(/** @type {Element} */ (node), el) ? 2 /* FILTER_REJECT */ : 3; /* FILTER_SKIP */
    },
  });
  let pos = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType !== 3) continue;
    const t = /** @type {Text} */ (n);
    out.push({ node: t, start: pos });
    pos += t.data.length;
  }
  return out;
}

/**
 * The block text of a `[data-block]` element: its content text nodes joined
 * in document order, ignoring the subtrees listed in the module notes. Every
 * offset used by this module refers to this string.
 * @param {Element} el
 * @returns {string}
 */
export function blockText(el) {
  let s = '';
  for (const { node } of blockTextNodes(el)) s += node.data;
  return s;
}

/**
 * True when `node` is content text a user can highlight: inside a
 * `[data-block]` element and not inside a skipped subtree (UI chrome).
 * @param {Node | null} node
 * @returns {boolean}
 */
export function highlightAllowed(node) {
  let el = node && node.nodeType === 1 ? /** @type {Element} */ (node) : node?.parentElement ?? null;
  while (el) {
    if (el.hasAttribute('data-block')) return true;
    if (SKIP_TAGS.has(el.tagName.toUpperCase()) || el.hasAttribute('data-anchor-skip')) return false;
    el = el.parentElement;
  }
  return false;
}

/**
 * Block-text offset of a DOM boundary point, clamped to the block.
 * @param {{ node: Text, start: number }[]} nodes From {@link blockTextNodes}.
 * @param {number} total Block text length.
 * @param {Node} container
 * @param {number} offset
 * @returns {number}
 */
function pointOffset(nodes, total, container, offset) {
  if (nodes.length === 0) return 0;
  const doc = container.ownerDocument || document;
  const probe = doc.createRange();
  try {
    probe.setStart(container, offset);
  } catch {
    return 0;
  }
  probe.collapse(true);
  let result = 0;
  for (const { node, start } of nodes) {
    let endCmp;
    let startCmp;
    try {
      endCmp = probe.comparePoint(node, node.data.length);
      startCmp = probe.comparePoint(node, 0);
    } catch {
      return 0; // different documents/trees
    }
    if (endCmp <= 0) {
      result = start + node.data.length; // node ends at or before the point
      continue;
    }
    if (startCmp >= 0) break; // node starts at or after the point
    // The point is inside this text node.
    return start + (container === node ? Math.min(Math.max(offset, 0), node.data.length) : 0);
  }
  return Math.min(result, total);
}

/**
 * Block-text offsets of the part of `range` that lies inside `el`. A range
 * that starts before the block starts at 0; one that ends after it ends at the
 * block text length. A range that does not touch the block gives an empty span.
 * @param {Element} el A `[data-block]` element.
 * @param {Range | StaticRange | AbstractRange} range
 * @returns {TextSpan}
 */
export function textOffsetsInElement(el, range) {
  const nodes = blockTextNodes(el);
  const last = nodes[nodes.length - 1];
  const total = last ? last.start + last.node.data.length : 0;
  const start = pointOffset(nodes, total, range.startContainer, range.startOffset);
  const end = pointOffset(nodes, total, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * Builds a DOM `Range` over block-text offsets `[start, end)` of `el`
 * (clamped). A start on a node boundary goes to the beginning of the next
 * text node, an end on a boundary to the end of the previous one, so the
 * range never includes neighbouring markup.
 * @param {Element} el A `[data-block]` element.
 * @param {number} start
 * @param {number} end
 * @returns {Range}
 */
export function rangeFromOffsets(el, start, end) {
  const doc = el.ownerDocument || document;
  const range = doc.createRange();
  const nodes = blockTextNodes(el);
  if (nodes.length === 0) {
    range.setStart(el, 0);
    range.collapse(true);
    return range;
  }
  const last = nodes[nodes.length - 1];
  const total = last.start + last.node.data.length;
  let a = Math.min(Math.max(toInt(start, 0), 0), total);
  let b = Math.min(Math.max(toInt(end, a), 0), total);
  if (b < a) [a, b] = [b, a];

  const startNode = nodes.find((n) => a < n.start + n.node.data.length) || last;
  range.setStart(startNode.node, Math.min(a - startNode.start, startNode.node.data.length));
  if (a === b) {
    range.collapse(true);
    return range;
  }
  const endNode = nodes.find((n) => b <= n.start + n.node.data.length && n.start < b) || last;
  range.setEnd(endNode.node, b - endNode.start);
  return range;
}
