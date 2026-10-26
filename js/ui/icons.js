/**
 * Icon set: crisp 24×24 stroke icons drawn with `currentColor`.
 *
 * Every icon is described as data (path strings and simple shapes) and turned
 * into real SVG elements with DOM APIs — no markup parsing at all. Each icon is
 * built once, cached as a template and cloned on later calls, so rendering
 * long lists stays cheap.
 *
 * Safe to import in Node: nothing touches `document` until `icon()` is called.
 *
 * @module ui/icons
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * A shape is either a path `d` string, or a `[tag, attributes]` tuple for
 * circles, rects and filled parts.
 * @typedef {string | [string, Record<string, string | number>]} Shape
 */

/** @type {(cx: number, cy: number, r: number, extra?: Record<string, string|number>) => Shape} */
const circle = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }];
/** @type {(x: number, y: number, width: number, height: number, rx?: number, extra?: Record<string, string|number>) => Shape} */
const rect = (x, y, width, height, rx = 0, extra = {}) => ['rect', { x, y, width, height, rx, ...extra }];
/** Solid fill, used for media controls and "filled" variants. */
const FILL = { fill: 'currentColor' };

const BOOKMARK = 'M6.5 3.5h11a1 1 0 0 1 1 1V21L12 16.8 5.5 21V4.5a1 1 0 0 1 1-1z';
const GEAR =
  'M10.58 5.15L10.91 2.76A9.3 9.3 0 0 1 13.09 2.76L13.42 5.15A7 7 0 0 1 15.84 6.15L17.76 4.7' +
  'A9.3 9.3 0 0 1 19.3 6.24L17.85 8.16A7 7 0 0 1 18.85 10.58L21.24 10.91A9.3 9.3 0 0 1 21.24 13.09' +
  'L18.85 13.42A7 7 0 0 1 17.85 15.84L19.3 17.76A9.3 9.3 0 0 1 17.76 19.3L15.84 17.85' +
  'A7 7 0 0 1 13.42 18.85L13.09 21.24A9.3 9.3 0 0 1 10.91 21.24L10.58 18.85A7 7 0 0 1 8.16 17.85' +
  'L6.24 19.3A9.3 9.3 0 0 1 4.7 17.76L6.15 15.84A7 7 0 0 1 5.15 13.42L2.76 13.09' +
  'A9.3 9.3 0 0 1 2.76 10.91L5.15 10.58A7 7 0 0 1 6.15 8.16L4.7 6.24A9.3 9.3 0 0 1 6.24 4.7' +
  'L8.16 6.15A7 7 0 0 1 10.58 5.15Z';
const HEART = 'M12 20.2 4.9 13.1a4.6 4.6 0 0 1 6.5-6.5l.6.6.6-.6a4.6 4.6 0 0 1 6.5 6.5z';
const MAGNIFIER = [circle(11, 11, 6.5), 'M20 20l-4.3-4.3'];

/**
 * Icon definitions. The names required by docs/ARCHITECTURE.md §6.2 are all
 * present; a few extras (heart, wifi-off, chevron-up, arrow-*, copy, external,
 * plus, minus) support the shell and tour.
 * @type {Readonly<Record<string, Shape[]>>}
 */
const ICONS = Object.freeze({
  home: [
    'M3.5 10.2 12 3.5l8.5 6.7',
    'M5.5 8.8V19a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V8.8',
    'M10 20.5V15a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5.5',
  ],
  library: [
    rect(3.5, 4, 4, 16.5, 1),
    rect(7.5, 4, 4, 16.5, 1),
    rect(14.2, 4.6, 4, 16, 1, { transform: 'rotate(-14 16.2 12.6)' }),
    'M3.5 8h4',
    'M7.5 16.5h4',
  ],
  stats: ['M3.5 20.5h17', 'M7 16.5v-5', 'M12 16.5v-10', 'M17 16.5v-7.5'],
  search: MAGNIFIER,
  settings: [GEAR, circle(12, 12, 3)],
  bookmark: [BOOKMARK],
  'bookmark-filled': [['path', { d: BOOKMARK, ...FILL }]],
  flag: [
    'M5 21.5V4',
    'M5 4.5c2.4-1.4 4.6-1.4 7 0s4.6 1.4 7 0v9c-2.4 1.4-4.6 1.4-7 0s-4.6-1.4-7 0',
  ],
  pen: ['M16.6 3.6a2.1 2.1 0 0 1 3 3L8 18.2l-4 1 1-4z', 'M14.5 5.7l3 3'],
  highlighter: [
    'M14.6 3.9a1.6 1.6 0 0 1 2.3 0l3.2 3.2a1.6 1.6 0 0 1 0 2.3L12 17.5 6.5 12z',
    'M6.5 12 5 16.5l2.5 2.5 4.5-1.5',
    'M5 16.5 3 18.5v2h3.5l1-1.5',
    'M14 21h7',
  ],
  eraser: [
    'M7.6 20.5 3.7 16.6a2 2 0 0 1 0-2.8L13.9 3.6a2 2 0 0 1 2.8 0l3.7 3.7a2 2 0 0 1 0 2.8L10.5 20.5z',
    'M20.5 20.5h-10',
    'M8.6 9 15 15.4',
  ],
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  mic: [rect(9, 2.5, 6, 11.5, 3), 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5v4'],
  stop: [rect(5.5, 5.5, 13, 13, 2.5, FILL)],
  play: [['path', { d: 'M7.5 5.1v13.8a1 1 0 0 0 1.5.9l10.6-6.9a1 1 0 0 0 0-1.7L9 4.2a1 1 0 0 0-1.5.9z', ...FILL }]],
  volume: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
  pause: [rect(6, 4.5, 4, 15, 1, FILL), rect(14, 4.5, 4, 15, 1, FILL)],
  trash: [
    'M4 6.5h16',
    'M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2',
    'M6 6.5l1 13a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4l1-13',
    'M10 11v5.5',
    'M14 11v5.5',
  ],
  'chevron-left': ['M15 18l-6-6 6-6'],
  'chevron-right': ['M9 18l6-6-6-6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-up': ['M18 15l-6-6-6 6'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  x: ['M17 7 7 17', 'M7 7l10 10'],
  check: ['M4.5 12.5l5 5L19.5 7'],
  clock: [circle(12, 12, 9), 'M12 7.5V12l3 2'],
  share: [
    'M12 3v11.5',
    'M8 7l4-4 4 4',
    'M8.5 10.5h-2A1.5 1.5 0 0 0 5 12v7.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-2',
  ],
  download: ['M12 3.5v12', 'M7 10.5l5 5 5-5', 'M4.5 20.5h15'],
  upload: ['M12 15.5v-12', 'M7 8.5l5-5 5 5', 'M4.5 20.5h15'],
  sparkles: [
    'M10 4c.7 4 2.3 5.6 6.3 6.3-4 .7-5.6 2.3-6.3 6.3-.7-4-2.3-5.6-6.3-6.3C7.7 9.6 9.3 8 10 4z',
    'M18 14.5c.3 1.6.9 2.2 2.5 2.5-1.6.3-2.2.9-2.5 2.5-.3-1.6-.9-2.2-2.5-2.5 1.6-.3 2.2-.9 2.5-2.5z',
    'M18 2.5v3',
    'M16.5 4h3',
  ],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01'],
  grid: [rect(3.5, 3.5, 7, 7, 1.5), rect(13.5, 3.5, 7, 7, 1.5), rect(3.5, 13.5, 7, 7, 1.5), rect(13.5, 13.5, 7, 7, 1.5)],
  info: [circle(12, 12, 9), 'M12 11v5.5', 'M12 7.6h.01'],
  alert: [
    'M10.3 4.2 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z',
    'M12 9.5v4',
    'M12 17h.01',
  ],
  refresh: [
    'M4.2 10.5A8 8 0 0 1 18.2 7.2',
    'M19 3.5v4h-4',
    'M19.8 13.5A8 8 0 0 1 5.8 16.8',
    'M5 20.5v-4h4',
  ],
  moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5z'],
  sun: [
    circle(12, 12, 4),
    'M12 2.5v2',
    'M12 19.5v2',
    'M2.5 12h2',
    'M19.5 12h2',
    'M5.3 5.3l1.4 1.4',
    'M17.3 17.3l1.4 1.4',
    'M5.3 18.7l1.4-1.4',
    'M17.3 6.7l1.4-1.4',
  ],
  'text-size': ['M3.5 7V5h10v2', 'M8.5 5v14', 'M6.5 19h4', 'M14 12v-1.5h7V12', 'M17.5 10.5V19', 'M16 19h3'],
  note: [
    'M14.5 3.5h-8A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8z',
    'M14.5 3.5V8H19',
    'M8.5 12.5h7',
    'M8.5 16.5h5',
  ],
  image: [rect(3.5, 4.5, 17, 15, 2), circle(9, 10, 1.6), 'M20.5 15.5l-4.2-4.2a1 1 0 0 0-1.4 0L5.5 19.5'],
  more: [circle(5.5, 12, 1.6, FILL), circle(12, 12, 1.6, FILL), circle(18.5, 12, 1.6, FILL)],
  target: [circle(12, 12, 9), circle(12, 12, 5.2), circle(12, 12, 1.6, FILL)],
  flame: [
    'M12 21a7 7 0 0 0 7-7c0-3.2-1.7-5.7-3.7-7.6-.3 1.9-1.2 3.3-2.7 4C12.6 7.4 11.3 4.8 9 3c.1 3.5-4 6-4 11a7 7 0 0 0 7 7z',
    'M12 21a3 3 0 0 1-3-3c0-1.6 1.1-2.6 1.9-3.8.9 1 4.1 2.1 4.1 3.8a3 3 0 0 1-3 3z',
  ],
  layers: ['M12 3.5 2.5 8.5l9.5 5 9.5-5z', 'M2.5 12.5l9.5 5 9.5-5', 'M2.5 16.5l9.5 5 9.5-5'],
  lasso: [
    ['path', { d: 'M4.6 14.9C3.6 13.9 3 12.7 3 11.5 3 7.9 7 5 12 5s9 2.9 9 6.5S17 18 12 18c-1.1 0-2.2-.1-3.2-.4', 'stroke-dasharray': '2.6 2.7' }],
    circle(6.8, 17.3, 1.8),
    'M6.2 19c-.3 1.1-.9 1.9-1.9 2.5',
  ],
  'zoom-in': [...MAGNIFIER, 'M11 8.5v5', 'M8.5 11h5'],
  'zoom-out': [...MAGNIFIER, 'M8.5 11h5'],
  hand: [
    'M8 12.5V6a1.5 1.5 0 0 1 3 0v5',
    'M11 10.5V4.5a1.5 1.5 0 0 1 3 0v6',
    'M14 10.5V6a1.5 1.5 0 0 1 3 0v5',
    'M17 11V8.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.7-2.3l-3.1-3.9a1.6 1.6 0 0 1 2.4-2.1L8 14.5',
  ],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', circle(12, 12, 3)],
  'eye-off': [
    'M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2',
    'M6.6 6.6C4 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5c2 0 3.8-.6 5.4-1.6',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
    'M3 3l18 18',
  ],
  filter: ['M3.5 5h17l-6.5 7.5V19l-4 2v-8.5z'],
  shuffle: [
    'M3 17.5h2.5c1.6 0 2.6-.7 3.5-2l5-7c.9-1.3 1.9-2 3.5-2H21',
    'M18 3.5l3 3-3 3',
    'M3 6.5h2.5c1.6 0 2.6.7 3.5 2l.4.6',
    'M14.6 14.9l.4.6c.9 1.3 1.9 2 3.5 2H21',
    'M18 14.5l3 3-3 3',
  ],
  timer: [circle(12, 13.5, 7.5), 'M9.5 2.5h5', 'M12 13.5V10', 'M18.2 7.3l1.3-1.3'],
  star: ['M12 3.2L14.41 9.28L20.94 9.7L15.9 13.87L17.53 20.2L12 16.7L6.47 20.2L8.1 13.87L3.06 9.7L9.59 9.28Z'],

  // Extras used by the shell and tour.
  heart: [HEART],
  'wifi-off': [
    'M12 19.5h.01',
    'M9.4 16.4a3.8 3.8 0 0 1 5.2 0',
    'M5.4 12.6a9.4 9.4 0 0 1 4.4-2.3',
    'M14.4 10.3a9.4 9.4 0 0 1 4.2 2.3',
    'M2.2 9a14 14 0 0 1 3.2-2.1',
    'M10.2 5.2A14 14 0 0 1 21.8 9',
    'M3.5 3.5l17 17',
  ],
  'arrow-left': ['M19.5 12h-15', 'M10.5 6l-6 6 6 6'],
  'arrow-right': ['M4.5 12h15', 'M13.5 6l6 6-6 6'],
  copy: [
    rect(8.5, 8.5, 12, 12, 2),
    'M15.5 8.5V5A1.5 1.5 0 0 0 14 3.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5',
  ],
  external: [
    'M14 3.5h6.5V10',
    'M20.5 3.5 11 13',
    'M18.5 14v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7A1.5 1.5 0 0 1 5 5.5h5',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
});

/** Every available icon name (contract names plus extras). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * Whether an icon with this name exists.
 * @param {string} name
 * @returns {boolean}
 */
export function hasIcon(name) {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/** @type {Map<string, SVGSVGElement>} */
const templates = new Map();
/** @type {Set<string>} */
const warned = new Set();

/**
 * Builds the cached template for `name`.
 * @param {string} name
 * @returns {SVGSVGElement}
 */
function buildTemplate(name) {
  const root = /** @type {SVGSVGElement} */ (document.createElementNS(SVG_NS, 'svg'));
  root.setAttribute('viewBox', '0 0 24 24');
  root.setAttribute('fill', 'none');
  root.setAttribute('stroke', 'currentColor');
  root.setAttribute('stroke-width', '2');
  root.setAttribute('stroke-linecap', 'round');
  root.setAttribute('stroke-linejoin', 'round');
  root.setAttribute('focusable', 'false');
  root.setAttribute('class', `icon icon-${name}`);
  for (const shape of ICONS[name]) {
    const [tag, attrs] = typeof shape === 'string' ? ['path', { d: shape }] : shape;
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    root.append(node);
  }
  return root;
}

/**
 * Creates an SVG icon.
 *
 * Icons inherit `currentColor` and are hidden from assistive technology unless
 * a `label` is given, in which case they get `role="img"` and an `aria-label`.
 * Unknown names fall back to a neutral circle (and warn once), so a typo never
 * breaks a screen.
 *
 * @param {string} name One of {@link ICON_NAMES}.
 * @param {{ size?: number | string, label?: string }} [options]
 *   `size` in px (number) or any CSS length (string). Default 20.
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 20, label } = {}) {
  let key = name;
  if (!hasIcon(key)) {
    if (!warned.has(String(name))) {
      warned.add(String(name));
      // eslint-disable-next-line no-console
      console.warn(`[icons] Unknown icon "${name}". Showing a placeholder.`);
    }
    key = 'info';
  }
  let tpl = templates.get(key);
  if (!tpl) {
    tpl = buildTemplate(key);
    templates.set(key, tpl);
  }
  const el = /** @type {SVGSVGElement} */ (tpl.cloneNode(true));
  const dim = typeof size === 'number' ? `${size}` : String(size);
  el.setAttribute('width', dim);
  el.setAttribute('height', dim);
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  return el;
}
