/**
 * Explanation renderer (docs/ARCHITECTURE.md §7.6): turns the structured
 * explanation blocks of a question (§3.4) and its inline mini-markup (§3.5)
 * into accessible DOM, using DOM APIs only (never HTML parsing).
 *
 * Contract with annotations (§7.7 "[data-block] rule"):
 * - Every rendered block element carries `data-block="<block id>"` and the
 *   classes `xb xb-<type>`, and is `position: relative` (css/explanation.css)
 *   so annotate/ink.js can lay a canvas over it.
 * - A `[data-block]` element holds only content text. Decoration inside it
 *   (callout icons and kind labels, flow arrow SVGs, the zoom hint) carries
 *   `data-anchor-skip`, so highlight anchoring ignores it.
 * - All content stays real, selectable text (table cells, flow steps,
 *   mind-map nodes), so highlights and search work everywhere.
 *
 * Robustness: unknown or malformed blocks are skipped with `console.warn`;
 * malformed optional fields degrade gracefully. Nothing here throws on bad data.
 *
 * Importing this module does not touch `document`.
 *
 * @module features/explain/render
 */

import { h, svg } from '../../core/dom.js';
import { icon } from '../../ui/icons.js';
import { sheet, iconButton } from '../../ui/components.js';
import { parseInline, inlineToPlain } from './inline.js';

/** Tag names for inline container tokens. */
const INLINE_TAGS = Object.freeze({
  strong: 'strong',
  em: 'em',
  mark: 'mark',
  sup: 'sup',
  sub: 'sub',
  code: 'code',
});

/** Callout kinds → icon, visible label and colour class. */
const CALLOUTS = Object.freeze({
  key: { icon: 'target', label: 'Key point' },
  pearl: { icon: 'star', label: 'Pearl' },
  pitfall: { icon: 'alert', label: 'Pitfall' },
  mnemonic: { icon: 'sparkles', label: 'Mnemonic' },
});

/** Block id pattern (§3.4). */
const BLOCK_ID_RE = /^[a-z0-9-]+$/;

/** Number of accent colours the mind map cycles through (css: .xb-mm-c0 … c5). */
const MM_COLORS = 6;

/** Zoom steps for the image viewer. */
const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

let uid = 0;
/**
 * A document-unique id for aria references.
 * @param {string} prefix
 * @returns {string}
 */
function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Coerces a field to a markup string: strings as is, finite numbers to text,
 * anything else to `''`.
 * @param {unknown} v
 * @returns {string}
 */
function str(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/**
 * Whether a field holds visible text.
 * @param {unknown} v
 * @returns {boolean}
 */
function hasText(v) {
  return str(v).trim() !== '';
}

/**
 * @param {string} where
 * @param {string} message
 */
function warn(where, message) {
  // eslint-disable-next-line no-console
  console.warn(`[explain] ${where}: ${message}`);
}

/* ------------------------------------------------------------------ */
/* Inline                                                              */
/* ------------------------------------------------------------------ */

/**
 * Appends DOM for inline tokens to `parent`.
 * @param {ParentNode} parent
 * @param {import('./inline.js').Token[]} tokens
 */
function appendTokens(parent, tokens) {
  for (const tok of tokens) {
    if (tok.t === 'text') {
      parent.append(document.createTextNode(tok.v));
    } else if (tok.t === 'arrow') {
      parent.append(h('span', { class: 'arrow' }, tok.v));
    } else {
      const tag = INLINE_TAGS[/** @type {keyof typeof INLINE_TAGS} */ (tok.t)];
      if (!tag) continue;
      const el = h(tag, tok.t === 'mark' ? { class: 'key' } : undefined);
      appendTokens(el, tok.c || []);
      parent.append(el);
    }
  }
}

/**
 * Renders an inline mini-markup string (§3.5) as DOM: `strong`, `em`,
 * `mark.key`, `sup`, `sub`, `code` and `span.arrow`, with text nodes only.
 * Non-string input gives an empty fragment (finite numbers render as text).
 *
 * @param {unknown} text
 * @returns {DocumentFragment}
 * @example el.append(renderInline('CO~2~ -> **high**'))
 */
export function renderInline(text) {
  const f = document.createDocumentFragment();
  try {
    appendTokens(f, parseInline(str(text)));
  } catch (err) {
    // parseInline never throws by contract; this is a last line of defence.
    warn('inline', `could not parse, showing plain text (${err})`);
    f.append(document.createTextNode(str(text)));
  }
  return f;
}

/* ------------------------------------------------------------------ */
/* Block renderers                                                     */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} Ctx
 * @property {string} where  Prefix for warnings (question id + block id).
 */

/** @param {Record<string, any>} b @param {Ctx} ctx */
function renderHeading(b, ctx) {
  if (!hasText(b.text)) return warn(ctx.where, 'heading has no text; skipped');
  return h('h3', {}, renderInline(b.text));
}

/** @param {Record<string, any>} b @param {Ctx} ctx */
function renderParagraph(b, ctx) {
  if (!hasText(b.text)) return warn(ctx.where, 'paragraph has no text; skipped');
  return h('p', {}, renderInline(b.text));
}

/**
 * Renders list items (level 1 accepts `{text, items}`; level 2 strings only).
 * @param {unknown[]} items
 * @param {boolean} ordered
 * @param {number} level
 * @param {Ctx} ctx
 * @returns {HTMLElement | null}
 */
function buildList(items, ordered, level, ctx) {
  const lis = [];
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') {
      if (hasText(item)) lis.push(h('li', {}, renderInline(item)));
      continue;
    }
    if (isObj(item) && hasText(item.text)) {
      const li = h('li', {}, renderInline(item.text));
      if (Array.isArray(item.items) && item.items.length) {
        if (level >= 2) {
          warn(ctx.where, 'lists are at most 2 levels deep; deeper items skipped');
        } else {
          const sub = buildList(item.items, ordered, level + 1, ctx);
          if (sub) li.append(sub);
        }
      }
      lis.push(li);
      continue;
    }
    warn(ctx.where, 'list item is not text; skipped');
  }
  if (!lis.length) return null;
  return h(ordered ? 'ol' : 'ul', { class: 'xb-list-items' }, lis);
}

/** @param {Record<string, any>} b @param {Ctx} ctx */
function renderList(b, ctx) {
  if (!Array.isArray(b.items)) return warn(ctx.where, 'list has no "items" array; skipped');
  const list = buildList(b.items, b.ordered === true, 1, ctx);
  if (!list) return warn(ctx.where, 'list is empty; skipped');
  return h('div', {}, list);
}

/**
 * Keeps a table's scroll affordances in sync: edge shadows (`can-left`,
 * `can-right` on the frame) and a tab stop only while the table actually
 * scrolls (a focusable region is only useful when it can be scrolled with
 * the keyboard).
 * @param {HTMLElement} frame
 * @param {HTMLElement} scroller
 */
function watchTableScroll(frame, scroller) {
  let queued = false;
  const update = () => {
    queued = false;
    const max = scroller.scrollWidth - scroller.clientWidth;
    const scrollable = max > 1;
    frame.classList.toggle('can-left', scrollable && scroller.scrollLeft > 1);
    frame.classList.toggle('can-right', scrollable && scroller.scrollLeft < max - 1);
    if (scrollable) scroller.setAttribute('tabindex', '0');
    else scroller.removeAttribute('tabindex');
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(update);
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(scroller);
  else requestAnimationFrame(update);
}

/** @param {Record<string, any>} b @param {Ctx} ctx */
function renderTable(b, ctx) {
  const head = Array.isArray(b.head) ? b.head : [];
  const rows = Array.isArray(b.rows) ? b.rows.filter((r) => Array.isArray(r)) : [];
  if (!rows.length) return warn(ctx.where, 'table has no rows; skipped');
  if (rows.length !== b.rows.length) warn(ctx.where, 'some table rows are not arrays; skipped');
  const cols = Math.max(head.length, ...rows.map((r) => r.length));
  if (!cols) return warn(ctx.where, 'table has no cells; skipped');
  const em = isObj(b.emphasis) ? b.emphasis : {};
  const emCol = Number.isInteger(em.col) && em.col >= 0 && em.col < cols ? em.col : -1;
  const emRow = Number.isInteger(em.row) && em.row >= 0 && em.row < rows.length ? em.row : -1;
  if (isObj(b.emphasis) && ((em.col !== undefined && emCol < 0) || (em.row !== undefined && emRow < 0))) {
    warn(ctx.where, 'table emphasis is out of range; ignored');
  }
  const rowHeads = cols > 1;

  const hasCaption = hasText(b.caption);
  const capId = nextId('xb-cap');
  const caption = hasCaption ? h('p', { class: 'xb-table-caption', id: capId }, renderInline(b.caption)) : null;
  const label = hasCaption ? undefined : 'Table';

  /**
   * @param {'th'|'td'} tag
   * @param {unknown} value
   * @param {number} c
   * @param {string} [scope]
   */
  const cell = (tag, value, c, scope) =>
    h(tag, { scope, class: c === emCol ? 'is-em' : undefined }, renderInline(value));

  const thead = head.length
    ? h('thead', {}, h('tr', {}, Array.from({ length: cols }, (_, c) => cell('th', head[c], c, 'col'))))
    : null;
  const tbody = h(
    'tbody',
    {},
    rows.map((row, r) =>
      h(
        'tr',
        { class: r === emRow ? 'is-em' : undefined },
        Array.from({ length: cols }, (_, c) => (c === 0 && rowHeads ? cell('th', row[c], c, 'row') : cell('td', row[c], c))),
      ),
    ),
  );
  const table = h(
    'table',
    {
      class: ['xb-table-grid', rowHeads && 'has-row-heads', cols >= 4 && 'is-wide'],
      'aria-labelledby': hasCaption ? capId : undefined,
      'aria-label': label,
    },
    thead,
    tbody,
  );
  const scroller = h(
    'div',
    { class: 'xb-table-scroll', role: 'region', 'aria-labelledby': hasCaption ? capId : undefined, 'aria-label': label },
    table,
  );
  const frame = h('div', { class: 'xb-table-frame' }, scroller);
  watchTableScroll(frame, scroller);
  return h('div', { style: { '--cols': cols } }, caption, frame);
}

/**
 * A downward arrow drawn as inline SVG (decoration only).
 * @returns {SVGElement}
 */
function arrowSvg() {
  return svg(
    'svg',
    {
      class: 'xb-arrow',
      viewBox: '0 0 16 28',
      width: '16',
      height: '28',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      focusable: 'false',
      'aria-hidden': 'true',
      'data-anchor-skip': '',
    },
    svg('path', { d: 'M8 2v23' }),
    svg('path', { d: 'M3.5 20l4.5 5 4.5-5' }),
  );
}

/**
 * The connector above a step: arrow + optional label (content text).
 * @param {unknown} label
 * @returns {HTMLElement}
 */
function flowLink(label) {
  return h(
    'div',
    { class: ['xb-flow-link', hasText(label) && 'has-label'] },
    arrowSvg(),
    hasText(label) ? h('span', { class: 'xb-flow-label' }, renderInline(label)) : null,
  );
}

/**
 * Flow block: an ordered chain of step boxes joined by arrows. A step with
 * `branches` is a fan-out row: the branches sit side by side between a split
 * bar and a merge bar (CSS), and stack as a group on narrow screens.
 * @param {Record<string, any>} b
 * @param {Ctx} ctx
 */
function renderFlow(b, ctx) {
  if (!Array.isArray(b.steps)) return warn(ctx.where, 'flow has no "steps" array; skipped');
  /** @type {({ text: unknown, label?: unknown } | { branches: Record<string, any>[] })[]} */
  const steps = [];
  for (const step of b.steps) {
    if (!isObj(step)) {
      warn(ctx.where, 'flow step is not an object; skipped');
    } else if (Array.isArray(step.branches)) {
      const branches = step.branches.filter((br) => isObj(br) && hasText(br.text));
      if (branches.length !== step.branches.length) warn(ctx.where, 'some flow branches have no text; skipped');
      if (branches.length) steps.push({ branches });
    } else if (hasText(step.text)) {
      steps.push(step);
    } else {
      warn(ctx.where, 'flow step has no text; skipped');
    }
  }
  if (!steps.length) return warn(ctx.where, 'flow has no valid steps; skipped');

  const items = steps.map((step, i) => {
    const first = i === 0;
    if ('branches' in step) {
      const n = step.branches.length;
      return h(
        'li',
        {
          class: ['xb-flow-row', `is-n${Math.min(n, 4)}`, first && 'is-first', i < steps.length - 1 && 'has-next'],
          style: { '--n': n },
        },
        h(
          'ul',
          { class: 'xb-flow-branches', role: 'list' },
          step.branches.map((br) =>
            h('li', { class: 'xb-flow-branch' }, flowLink(br.label), h('div', { class: 'xb-flow-box' }, renderInline(br.text))),
          ),
        ),
      );
    }
    return h(
      'li',
      { class: 'xb-flow-step' },
      first ? null : flowLink(step.label),
      h('div', { class: 'xb-flow-box' }, renderInline(step.text)),
    );
  });
  return h(
    'div',
    {},
    hasText(b.title) ? h('p', { class: 'xb-flow-title' }, renderInline(b.title)) : null,
    h('ol', { class: 'xb-flow-steps', role: 'list' }, items),
  );
}

/**
 * Mind map block: a centre node with 2–6 branches, each with optional leaf
 * chips. Wide containers place the first half of the branches left of the
 * centre and the rest right of it (`is-left`/`is-right`, `--row`); narrow
 * ones stack them as an outline under the centre. Connectors are CSS only.
 * @param {Record<string, any>} b
 * @param {Ctx} ctx
 */
function renderMindmap(b, ctx) {
  if (!hasText(b.center)) return warn(ctx.where, 'mind map has no center; skipped');
  const branches = Array.isArray(b.branches) ? b.branches.filter((br) => isObj(br) && hasText(br.text)) : [];
  if (!branches.length) return warn(ctx.where, 'mind map has no valid branches; skipped');
  if (!Array.isArray(b.branches) || branches.length !== b.branches.length) warn(ctx.where, 'some mind map branches are malformed; skipped');
  if (branches.length < 2 || branches.length > 6) warn(ctx.where, `mind map should have 2–6 branches (has ${branches.length})`);
  const leftCount = Math.ceil(branches.length / 2);
  return h(
    'div',
    { class: ['xb-mm', branches.length === 1 && 'is-single'] },
    h('div', { class: 'xb-mm-center' }, h('span', { class: 'xb-mm-center-text' }, renderInline(b.center))),
    h(
      'ul',
      { class: 'xb-mm-branches', role: 'list', style: { '--rows': leftCount } },
      branches.map((br, i) => {
        const left = i < leftCount || branches.length === 1;
        const kids = Array.isArray(br.children) ? br.children.filter(hasText) : [];
        return h(
          'li',
          {
            class: ['xb-mm-branch', `xb-mm-c${i % MM_COLORS}`, left ? 'is-left' : 'is-right'],
            style: { '--row': (left ? i : i - leftCount) + 1 },
          },
          h('div', { class: 'xb-mm-node' }, renderInline(br.text)),
          kids.length
            ? h('ul', { class: 'xb-mm-leaves', role: 'list' }, kids.map((k) => h('li', { class: 'xb-mm-leaf' }, renderInline(k))))
            : null,
        );
      }),
    ),
  );
}

/** @param {Record<string, any>} b @param {Ctx} ctx */
function renderCallout(b, ctx) {
  let kind = b.kind;
  if (!Object.hasOwn(CALLOUTS, kind)) {
    warn(ctx.where, `unknown callout kind ${JSON.stringify(kind)}; shown as "key"`);
    kind = 'key';
  }
  const meta = CALLOUTS[/** @type {keyof typeof CALLOUTS} */ (kind)];
  const items = Array.isArray(b.items) ? b.items.filter(hasText) : [];
  const hasBody = hasText(b.text) || items.length > 0;
  if (!hasBody && !hasText(b.title)) return warn(ctx.where, 'callout has no text; skipped');
  const ic = icon(meta.icon, { size: 20 });
  ic.setAttribute('data-anchor-skip', '');
  ic.classList.add('xb-callout-icon');
  return h(
      'div',
      { role: 'note', class: `xb-callout-${kind}` },
      h(
        'div',
        { class: 'xb-callout-head' },
        ic,
        h(
          'div',
          { class: 'xb-callout-titles' },
          // The kind label is UI text, not content: anchoring skips it, screen readers read it.
          h('span', { class: 'xb-callout-kind', 'data-anchor-skip': '' }, meta.label),
          hasText(b.title) ? h('p', { class: 'xb-callout-title' }, renderInline(b.title)) : null,
        ),
      ),
      hasText(b.text) ? h('p', { class: 'xb-callout-text' }, renderInline(b.text)) : null,
      items.length ? h('ul', { class: 'xb-callout-items' }, items.map((t) => h('li', {}, renderInline(t)))) : null,
    );
}

/** @param {Record<string, any>} b @param {Ctx} ctx */
function renderQuote(b, ctx) {
  if (!hasText(b.text)) return warn(ctx.where, 'quote has no text; skipped');
  if (!hasText(b.ref)) warn(ctx.where, 'quote has no "ref" (source citation)');
  return h(
    'figure',
    {},
    h('blockquote', { class: 'xb-quote-text' }, h('p', {}, renderInline(b.text))),
    hasText(b.ref) ? h('figcaption', { class: 'xb-quote-ref' }, h('cite', {}, renderInline(b.ref))) : null,
  );
}

/**
 * @type {Record<string, (b: Record<string, any>, ctx: Ctx) => HTMLElement | void>}
 */
const RENDERERS = {
  heading: renderHeading,
  p: renderParagraph,
  list: renderList,
  table: renderTable,
  flow: renderFlow,
  mindmap: renderMindmap,
  callout: renderCallout,
  quote: renderQuote,
  // An unusable src still renders the plain-language placeholder (renderImage warns).
  image: (b) => renderImage(/** @type {any} */ (b)),
};

/**
 * Renders explanation blocks (§3.4).
 *
 * Returns `<div class="explain" data-qid>` whose children are the block
 * elements, each with `data-block="<id>"` and `class="xb xb-<type>"`
 * (callouts add `xb-callout-<kind>`, images are `figure.xb-figure`). Headings are `h3`. Unknown or malformed
 * blocks are skipped with a warning; a block without a valid, unique id still
 * renders but gets no `data-block` (so no annotations attach to it).
 *
 * @param {unknown} blocks The question's `explanation` array.
 * @param {{ qid?: string }} [opts] `qid` labels warnings and is set as `data-qid`.
 * @returns {HTMLElement}
 */
export function renderBlocks(blocks, { qid } = {}) {
  const root = h('div', { class: 'explain', dataset: { qid: qid || undefined } });
  if (!Array.isArray(blocks)) {
    if (blocks !== undefined && blocks !== null) warn(qid || '?', 'explanation is not an array; nothing rendered');
    return root;
  }
  const seen = new Set();
  blocks.forEach((b, i) => {
    const id = isObj(b) && typeof b.id === 'string' ? b.id : '';
    const where = `${qid || '?'} block ${id ? `"${id}"` : `#${i}`}`;
    if (!isObj(b)) return warn(where, 'is not an object; skipped');
    const fn = Object.hasOwn(RENDERERS, b.type) ? RENDERERS[b.type] : null;
    if (!fn) return warn(where, `unknown block type ${JSON.stringify(b.type)}; skipped`);
    /** @type {HTMLElement | void} */
    let el;
    try {
      el = fn(b, { where });
    } catch (err) {
      warn(where, `could not render (${err}); skipped`);
      return;
    }
    if (!el) return;
    el.classList.add('xb', `xb-${b.type}`);
    if (!id || !BLOCK_ID_RE.test(id)) {
      warn(where, 'has no valid id; rendered without annotations');
    } else if (seen.has(id)) {
      warn(where, 'duplicate id; rendered without annotations');
    } else {
      seen.add(id);
      el.dataset.block = id;
    }
    root.append(el);
  });
  return root;
}

/**
 * Renders a question stem as `<div class="q-stem" data-block="stem">`.
 * Line breaks in the stem are kept (CSS `white-space: pre-line`).
 *
 * @param {{ stem?: unknown, id?: string } | null | undefined} q
 * @returns {HTMLElement}
 */
export function renderStem(q) {
  const stem = isObj(q) ? q.stem : undefined;
  if (!hasText(stem)) warn(isObj(q) && q.id ? q.id : '?', 'question has no stem');
  return h('div', { class: 'q-stem', dataset: { block: 'stem' } }, renderInline(stem));
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether `src` is a safe relative path for an image: a non-empty string
 * without a scheme (`http:`, `data:`, `javascript:` …), without a leading `/`
 * or `\`, and without control characters. Pure.
 *
 * @param {unknown} src
 * @returns {boolean}
 * @example isSafeImageSrc('data/img/CH03-0001.webp') // true
 */
export function isSafeImageSrc(src) {
  if (typeof src !== 'string') return false;
  const s = src.trim();
  if (!s || s !== src) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(s)) return false;
  if (s.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  return true;
}

/**
 * The plain-language placeholder shown when an image can't be shown.
 * @param {string} alt
 * @returns {HTMLElement}
 */
function imageFallback(alt) {
  return h(
    'div',
    { class: 'xb-img-error', role: 'img', 'aria-label': alt ? `Image not available: ${alt}` : 'Image not available' },
    h('span', { 'data-anchor-skip': '', 'aria-hidden': 'true', class: 'xb-img-error-icon' }, icon('image', { size: 28 })),
    h(
      'span',
      { 'data-anchor-skip': '', 'aria-hidden': 'true' },
      'This image couldn’t load. Check your connection, then reopen the question.',
    ),
  );
}

/**
 * Renders an image as a `<figure class="xb-figure">` with a lazy-loaded
 * image (`loading="lazy"`, `decoding="async"`) inside a button; tap, click,
 * Enter or Space opens a full-screen viewer (zoom buttons, double-tap and
 * +/−/0 keys, Esc or the Close button to leave). The caption (inline markup)
 * is real text. A missing `alt` warns and falls back to the caption.
 *
 * @param {{ src?: unknown, alt?: unknown, caption?: unknown } | null | undefined} img
 * @returns {HTMLElement}
 */
export function renderImage(img) {
  const data = isObj(img) ? img : {};
  const capText = hasText(data.caption) ? str(data.caption) : '';
  let alt = typeof data.alt === 'string' ? data.alt.trim() : '';
  if (!alt) {
    warn(`image ${typeof data.src === 'string' ? data.src : '?'}`, 'has no alt text');
    alt = capText ? inlineToPlain(capText) : 'Image';
  }
  const caption = capText ? h('figcaption', { class: 'xb-figcaption' }, renderInline(capText)) : null;

  if (!isSafeImageSrc(data.src)) {
    warn(`image ${JSON.stringify(data.src)}`, 'src must be a relative path');
    return h('figure', { class: 'xb-figure' }, imageFallback(alt), caption);
  }
  const src = /** @type {string} */ (data.src);
  const image = /** @type {HTMLImageElement} */ (
    h('img', { class: 'xb-img', src, alt, loading: 'lazy', decoding: 'async', draggable: false })
  );
  const zoomHint = h('span', { class: 'xb-img-zoom', 'data-anchor-skip': '', 'aria-hidden': 'true' }, icon('zoom-in', { size: 18 }));
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'xb-img-btn',
      'aria-label': `Enlarge image: ${alt}`,
      'aria-haspopup': 'dialog',
      onClick: () => openImageViewer(src, alt, capText),
    },
    image,
    zoomHint,
  );
  const figure = h('figure', { class: 'xb-figure' }, btn, caption);
  image.addEventListener('load', () => figure.classList.add('is-loaded'), { once: true });
  image.addEventListener(
    'error',
    () => {
      warn(`image ${src}`, 'failed to load');
      btn.replaceWith(imageFallback(alt));
    },
    { once: true },
  );
  return figure;
}

/**
 * Opens the accessible full-screen image viewer (a full-size sheet: focus
 * trap, Esc / Close / Android Back close it, focus returns to the image).
 *
 * @param {string} src
 * @param {string} alt
 * @param {string} caption Inline markup or ''.
 */
function openImageViewer(src, alt, caption) {
  let step = 0;
  /** @type {{ w: number, h: number } | null} */
  let natural = null;

  const status = h('span', { class: 'xb-viewer-zoom', 'aria-live': 'polite' }, '100%');
  const big = /** @type {HTMLImageElement} */ (h('img', { class: 'xb-viewer-img', src, alt, decoding: 'async', draggable: false }));
  const stage = h(
    'div',
    {
      class: 'xb-viewer-stage',
      tabindex: '0',
      role: 'group',
      'aria-label': `${alt}. Use plus and minus to zoom, arrow keys to move.`,
    },
    big,
  );
  const zoomOut = iconButton({ icon: 'zoom-out', label: 'Zoom out', onClick: () => setStep(step - 1) });
  const zoomIn = iconButton({ icon: 'zoom-in', label: 'Zoom in', onClick: () => setStep(step + 1) });
  const fit = iconButton({ icon: 'image', label: 'Fit to screen', onClick: () => setStep(0) });
  const tools = h('div', { class: 'xb-viewer-tools' }, zoomOut, status, zoomIn, fit);
  const content = h(
    'div',
    { class: 'xb-viewer' },
    stage,
    h('div', { class: 'xb-viewer-bar' }, caption ? h('p', { class: 'xb-viewer-caption' }, renderInline(caption)) : null, tools),
  );

  /** Sizes the image for the current zoom, keeping the view centred. */
  function layout() {
    if (!natural) return;
    const box = stage.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const fitScale = Math.min(box.width / natural.w, box.height / natural.h, 1);
    const z = ZOOM_STEPS[step];
    const cx = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, stage.scrollWidth);
    const cy = (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, stage.scrollHeight);
    big.style.width = `${Math.round(natural.w * fitScale * z)}px`;
    big.style.height = `${Math.round(natural.h * fitScale * z)}px`;
    stage.classList.toggle('is-zoomed', z > 1);
    stage.scrollLeft = cx * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = cy * stage.scrollHeight - stage.clientHeight / 2;
  }

  /** @param {number} next */
  function setStep(next) {
    step = Math.max(0, Math.min(ZOOM_STEPS.length - 1, next));
    status.textContent = `${Math.round(ZOOM_STEPS[step] * 100)}%`;
    zoomOut.disabled = step === 0;
    zoomIn.disabled = step === ZOOM_STEPS.length - 1;
    fit.disabled = step === 0;
    layout();
  }

  big.addEventListener('load', () => {
    natural = { w: big.naturalWidth || 1, h: big.naturalHeight || 1 };
    layout();
  });
  big.addEventListener('error', () => {
    stage.replaceChildren(imageFallback(alt));
    tools.hidden = true;
  });
  big.addEventListener('dblclick', () => setStep(step === 0 ? 2 : 0));
  stage.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') setStep(step + 1);
    else if (e.key === '-' || e.key === '_') setStep(step - 1);
    else if (e.key === '0') setStep(0);
    else return;
    e.preventDefault();
  });

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(stage);
  sheet({
    title: 'Image',
    content,
    size: 'full',
    onClose: () => ro?.disconnect(),
  });
  setStep(0);
}

/** Exposed for the dev gallery and tests only. */
export const CALLOUT_KINDS = Object.freeze(Object.keys(CALLOUTS));
