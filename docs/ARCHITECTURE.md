# Architecture

The contract for every module in the app. Code must match these names, shapes
and behaviours exactly. If a contract has to change, change this file in the
same commit.

Read `CLAUDE.md` first for the product rules (free, offline, English only,
source-only content, very advanced code, extreme user-friendliness).

---

## 1. Ground rules

- Static files only. Vanilla JS **ES modules** (`<script type="module">`),
  no framework, no bundler, no transpiler, no npm runtime dependencies.
- Target browsers: Safari iOS/iPadOS 16.4+, Chrome Android 110+, desktop Chrome/Safari/Firefox (latest 2).
- **All paths relative** (the site lives under `/cardiacsurgery-/` on GitHub Pages
  and may later be wrapped by Capacitor). Never write a leading `/` in a URL.
- No `innerHTML` with dynamic data. Build DOM with `h()` (see `dom.js`). Static
  SVG icon markup inside `icons.js` is the only exception.
- No global variables. Each module exports what it owns. Modules that hold logic
  only (srs, builder filters, engine reducers, inline markup parser, search
  tokenizer, util) must not touch `document`/`window` at import time, so they
  can be unit-tested in Node.
- Every async action handles failure and tells the user in plain language.
- English only in the UI.
- JSDoc on every exported function (types in JSDoc, not TypeScript).

## 2. File map

```
index.html                 App shell (header, main, tab bar, slots). Loads js/app.js.
manifest.webmanifest       PWA manifest.
sw.js                      Service worker (precache + update flow).
package.json               {"type":"module","private":true} so Node can run dev scripts/tests.
.nojekyll                  Disables Jekyll on GitHub Pages. Keep.
icons/                     App icons (icon-180.png, icon-192.png, icon-512.png).

css/
  tokens.css               Design tokens (colors, spacing, type scale, radii, shadows), light + dark.
  base.css                 Reset, typography, layout primitives, utilities, focus styles.
  components.css           Buttons, cards, chips, lists, sheets, toasts, banners, tabs, toggles, progress.
  shell.css                Header, tab bar / side rail, page layout, responsive breakpoints.
  explanation.css          Explanation block renderer (tables, flows, mind maps, callouts, quotes).
  annotate.css             Highlights, ink layer, ink toolbar, scratchpad.
  screen-player.css        Question player + results.
  screen-home.css          Home, chapter, quiz builder, library.
  screen-misc.css          Stats, search, settings, reviewer dashboard, tour.

js/
  app.js                   Bootstrap: settings → db → shell → routes → SW → resume/tour.
  version.js               export const APP_VERSION = 'YYYY.MM.DD-N' (must equal sw.js VERSION).
  core/
    dom.js                 h(), svg(), $, $$, clear(), text helpers.
    events.js              bus (pub/sub).
    util.js                Pure helpers (ids, random, shuffle, time, debounce...).
    router.js              Hash router with lazy screen modules.
    settings.js            Settings with defaults, persistence, application to <html>.
    data.js                Question bank loader (index + chapters, lazy, memoized).
    sw-client.js           SW registration, update check, update banner, offline banner.
    store/db.js            IndexedDB connection, schema, migrations, promise helpers.
    store/repo.js          Repositories (one per store) — the only code that talks to db.js.
  features/
    srs.js                 Spaced repetition scheduling (pure).
    quiz/builder.js        Select question IDs for a quiz from filters.
    quiz/engine.js         Quiz session model: pure reducers + async persistence wrappers.
    stats.js               Aggregated statistics.
    search.js              Offline full-text search.
    explain/inline.js      Inline mini-markup parser (pure) → tokens.
    explain/render.js      Explanation blocks → DOM.
    annotate/anchor.js     Text anchoring (pure-ish: works on strings + DOM text nodes).
    annotate/highlight.js  Highlights on stem, choices and explanation.
    annotate/ink.js        Ink engine (strokes, rendering, input) + per-block ink layers.
    annotate/ink-toolbar.js Ink tool palette.
    annotate/scratchpad.js Full-screen per-question drawing canvas with zoom/pan.
    notes.js               Text note editor for a question (autosave).
    voice.js               Voice note recording/playback + UI.
    askgpt.js              "Ask GPT" button.
    review.js              Reports ("report a problem") + reviewer mode tools + review export.
    backup.js              Export / import backup.
  ui/
    icons.js               icon(name) → SVG element.
    components.js          Reusable UI components (button, toast, sheet, ...).
    shell.js               App shell controller (header, nav, banners, slots).
    tour.js                First-run tour.
  screens/                 One module per route (lazy-loaded).
    home.js chapter.js builder.js player.js results.js question.js
    library.js stats.js search.js settings.js reviewer.js

data/
  index.json               Parts + chapters (+ demo) with published flags.
  retired.json             Retired question IDs (never reuse).
  ch01.json ... ch55.json, demo.json

scripts/                   Dev-only (Node 20+, no dependencies). Never loaded by the app.
  validate.mjs             Validates data + precache list + version consistency. Exit 1 on error.
  bump-version.mjs         Sets a new version in sw.js and js/version.js.
tests/                     Dev-only.
  unit/*.test.mjs          Node unit tests for pure modules (node:test + node:assert). Run: node --test tests/unit/*.test.mjs
  e2e.mjs                  Playwright end-to-end tests (uses the pre-installed playwright).
  serve.mjs                Tiny static file server used by e2e (serves repo under /cardiacsurgery-/).
docs/ARCHITECTURE.md       This file.
```

## 3. Data format

### 3.1 `data/index.json`

The book structure (owner-provided table of contents, 2026-10-26): **7 parts, 55 chapters**.
It replaces the earlier 13-chapter plan. Every chapter starts **unpublished** and
is **completely hidden** in the app (home, chapter list, builder, stats, search,
library counts) until the owner approves it and `published` is set to `true`.
A part is hidden while it has no published chapter. The demo chapter is always
loadable, but only offered on Home when no real chapter is published (and from
Settings > Help at any time).

```json
{
  "schemaVersion": 1,
  "parts": [ { "id": "p1", "number": "I", "title": "General Considerations", "volume": 1 } ],
  "chapters": [
    { "id": "ch01", "number": 1, "part": "p1", "prefix": "CH01", "title": "Anatomy and Dimensions",
      "file": "data/ch01.json", "page": 1, "published": false, "count": 0 }
  ],
  "demo": { "id": "demo", "prefix": "DEMO", "title": "App tour (demo)", "file": "data/demo.json", "count": 10 }
}
```

- `page` = first page of the chapter in the owner's book (used in source references).
- `count` must equal the number of questions in the file (validated).
- `data.js`: `loadIndex()` exposes `parts`, `chapters` (published only, sorted by number)
  and `demo`; `loadIndex({ includeUnpublished: true })` is for dev tools only.
  `getQuestion()` of an unpublished chapter returns `null`. Builder, stats, search
  and home only ever see published chapters (+ demo where documented).
- The service worker precaches only published chapter files + demo.
- To publish a chapter: set `"published": true`, bump the version, validate, push.

Parts (fixed):

| id | number | volume | title |
|---|---|---|---|
| p1 | I | 1 | General Considerations |
| p2 | II | 1 | Ischemic Heart Disease |
| p3 | III | 1 | Acquired Valvar Heart Disease |
| p4 | IV | 1 | Other Cardiac Conditions |
| p5 | V | 1 | Advanced Heart Failure |
| p6 | VI | 1 | Diseases of the Thoracic Arteries and Veins |
| p7 | VII | 2 | Congenital Heart Disease |

Chapters (fixed; ids, prefixes and files never change):

| # | id | prefix | file | part | title | page |
|---|---|---|---|---|---|---|
| 1 | ch01 | CH01 | data/ch01.json | p1 | Anatomy and Dimensions | 1 |
| 2 | ch02 | CH02 | data/ch02.json | p1 | Hypothermia, Circulatory Arrest, and Cardiopulmonary Bypass | 28 |
| 3 | ch03 | CH03 | data/ch03.json | p1 | Myocardial Management During Cardiac Surgery with Cardiopulmonary Bypass | 84 |
| 4 | ch04 | CH04 | data/ch04.json | p1 | Anesthesia and Postoperative Care | 105 |
| 5 | ch05 | CH05 | data/ch05.json | p1 | Cardiac Reoperations: Considerations and Techniques | 186 |
| 6 | ch06 | CH06 | data/ch06.json | p1 | Cardiac Imaging | 200 |
| 7 | ch07 | CH07 | data/ch07.json | p1 | Generating Knowledge from Information, Data, and Analyses | 235 |
| 8 | ch08 | CH08 | data/ch08.json | p1 | Quality Assurance | 353 |
| 9 | ch09 | CH09 | data/ch09.json | p2 | Stenotic Arteriosclerotic Coronary Artery Disease | 384 |
| 10 | ch10 | CH10 | data/ch10.json | p2 | Acute and Chronic Complications of Myocardial Infarction | 464 |
| 11 | ch11 | CH11 | data/ch11.json | p3 | Mitral Valve Disease | 500 |
| 12 | ch12 | CH12 | data/ch12.json | p3 | Aortic Valve | 552 |
| 13 | ch13 | CH13 | data/ch13.json | p3 | Tricuspid Valve Disease | 637 |
| 14 | ch14 | CH14 | data/ch14.json | p3 | Infective Endocarditis | 649 |
| 15 | ch15 | CH15 | data/ch15.json | p4 | Cardiac Rhythm Disturbances | 685 |
| 16 | ch16 | CH16 | data/ch16.json | p4 | Cardiac Trauma | 724 |
| 17 | ch17 | CH17 | data/ch17.json | p4 | Cardiac Tumor | 732 |
| 18 | ch18 | CH18 | data/ch18.json | p4 | Pericardial Disease | 748 |
| 19 | ch19 | CH19 | data/ch19.json | p4 | Obstructive Hypertrophic Cardiomyopathy | 763 |
| 20 | ch20 | CH20 | data/ch20.json | p5 | Mechanical Circulatory Support | 787 |
| 21 | ch21 | CH21 | data/ch21.json | p5 | Cardiac Transplantation | 829 |
| 22 | ch22 | CH22 | data/ch22.json | p6 | Acute Aortic Dissection | 898 |
| 23 | ch23 | CH23 | data/ch23.json | p6 | Chronic Thoracic and Thoracoabdominal Aortic Disease | 927 |
| 24 | ch24 | CH24 | data/ch24.json | p6 | Acute Traumatic Aortic Disruption | 971 |
| 25 | ch25 | CH25 | data/ch25.json | p6 | Diseases of the Pulmonary Arteries and Systemic Veins | 986 |
| 26 | ch26 | CH26 | data/ch26.json | p7 | Anatomic Considerations in Congenital Heart Disease | 1013 |
| 27 | ch27 | CH27 | data/ch27.json | p7 | Nomenclature for Congenital Heart Disease | 1024 |
| 28 | ch28 | CH28 | data/ch28.json | p7 | Patent Ductus Arteriosus | 1030 |
| 29 | ch29 | CH29 | data/ch29.json | p7 | Atrial Septal Defect, Partial Anomalous Pulmonary Venous Connection, Unroofed Coronary Sinus | 1044 |
| 30 | ch30 | CH30 | data/ch30.json | p7 | Total Anomalous Pulmonary Venous Connection | 1079 |
| 31 | ch31 | CH31 | data/ch31.json | p7 | Cor Triatriatum | 1105 |
| 32 | ch32 | CH32 | data/ch32.json | p7 | Atrioventricular Septal Defect | 1114 |
| 33 | ch33 | CH33 | data/ch33.json | p7 | Ventricular Septal Defect | 1164 |
| 34 | ch34 | CH34 | data/ch34.json | p7 | Ventricular Septal Defect with Pulmonary Stenosis | 1212 |
| 35 | ch35 | CH35 | data/ch35.json | p7 | Ventricular Septal Defect with Pulmonary Atresia | 1288 |
| 36 | ch36 | CH36 | data/ch36.json | p7 | Pulmonary Stenosis or Atresia with Intact Ventricular Septum | 1318 |
| 37 | ch37 | CH37 | data/ch37.json | p7 | Congenital Sinus of Valsalva Aneurysm and Aortico Ventricular Tunnel | 1347 |
| 38 | ch38 | CH38 | data/ch38.json | p7 | Congenital Anomalies of the Coronary Arteries | 1363 |
| 39 | ch39 | CH39 | data/ch39.json | p7 | Vascular Rings and Pulmonary Artery Sling | 1397 |
| 40 | ch40 | CH40 | data/ch40.json | p7 | Coarctation of the Aorta and Interrupted Aortic Arch | 1415 |
| 41 | ch41 | CH41 | data/ch41.json | p7 | Aortopulmonary Window | 1468 |
| 42 | ch42 | CH42 | data/ch42.json | p7 | Origin of the Right or Left Pulmonary Artery from the Ascending Aorta | 1476 |
| 43 | ch43 | CH43 | data/ch43.json | p7 | Truncus Arteriosus | 1483 |
| 44 | ch44 | CH44 | data/ch44.json | p7 | Transposition of the Great Arteries | 1509 |
| 45 | ch45 | CH45 | data/ch45.json | p7 | Double Outlet Right Ventricle | 1562 |
| 46 | ch46 | CH46 | data/ch46.json | p7 | Double Outlet Left Ventricle | 1587 |
| 47 | ch47 | CH47 | data/ch47.json | p7 | Congenitally Corrected Transposition of the Great Arteries, Other Forms of Atrioventricular Discordant Connection, and Anatomically Corrected Malposition of the Great Arteries | 1596 |
| 48 | ch48 | CH48 | data/ch48.json | p7 | Ebstein Anomaly | 1635 |
| 49 | ch49 | CH49 | data/ch49.json | p7 | Congenital and Pediatric Mitral Valve Disease | 1666 |
| 50 | ch50 | CH50 | data/ch50.json | p7 | Congenital Aortic Stenosis | 1685 |
| 51 | ch51 | CH51 | data/ch51.json | p7 | Hypoplastic Left Heart Syndrome | 1723 |
| 52 | ch52 | CH52 | data/ch52.json | p7 | Functional Single Ventricle | 1756 |
| 53 | ch53 | CH53 | data/ch53.json | p7 | Heterotaxy | 1833 |
| 54 | ch54 | CH54 | data/ch54.json | p7 | Congenital Heart Disease in the Adult | 1846 |
| 55 | ch55 | CH55 | data/ch55.json | p7 | Congenital Heart Surgery in Low-Resource Settings | 1941 |
| — | demo | DEMO | data/demo.json | — | App tour (demo): questions about using the app, `"demo": true` | — |

### 3.2 Chapter file

```json
{
  "schemaVersion": 1,
  "chapter": "cpb",
  "questions": [ /* Question */ ]
}
```

### 3.3 Question

```json
{
  "id": "CPB-0001",
  "version": 1,
  "topic": "Cardioplegia",
  "tags": ["del Nido"],
  "difficulty": 2,
  "reviewed": false,
  "stem": "A 64-year-old man ... Which is the **best** next step?",
  "image": { "src": "data/img/CPB-0001.webp", "alt": "...", "caption": "..." },
  "choices": [
    { "id": "a", "text": "..." },
    { "id": "b", "text": "..." }
  ],
  "answer": "c",
  "explanation": [ /* Block */ ],
  "choiceNotes": { "a": "Why A is wrong (from the source).", "b": "..." },
  "source": [ { "ref": "Owner source name", "loc": "Ch 3, p. 45" } ]
}
```

- `id`: `PREFIX-NNNN` (4+ digits), permanent, unique across all chapters, never in `retired.json`.
- `version`: integer ≥ 1. Bump when the stem/choices/explanation text change
  meaningfully (annotations use it to detect drift).
- `choices`: 4 or 5 items (default 5), ids are lowercase letters `a`–`e`, unique.
  Display letters (A–E) are assigned **after** shuffling; never store display letters.
- `answer`: a choice id.
- `stem`, `choices[].text`, `choiceNotes.*`: inline mini-markup strings (§3.5).
- `image`, `choiceNotes`, `tags`: optional. `difficulty`: 1 (easy) – 3 (hard).
- `source`: required, ≥1 entry, except demo questions.
- `demo: true` only in the demo chapter.

### 3.4 Explanation blocks

Every block has a unique `id` within its question (`[a-z0-9-]+`). Block ids are
annotation anchors — **never change an existing block id**; add new ids.

| type | fields |
|---|---|
| `heading` | `text` |
| `p` | `text` |
| `list` | `ordered?: bool`, `items: (string \| {text, items})[]` (max 2 levels) |
| `table` | `caption?`, `head: string[]`, `rows: string[][]`, `emphasis?: {col?: n, row?: n}` |
| `flow` | `title?`, `steps: Step[]` where Step = `{text, label?}` (label = text on the arrow leading into this step) or `{branches: [{label?, text}]}` (fan-out row) |
| `mindmap` | `center: string`, `branches: [{text, children?: string[]}]` (2–6 branches) |
| `callout` | `kind: "key"\|"pearl"\|"pitfall"\|"mnemonic"`, `title?`, `text?`, `items?: string[]` |
| `quote` | `text`, `ref` (source citation shown under the quote) |
| `image` | `src`, `alt`, `caption?` |

All string fields use inline mini-markup.

### 3.5 Inline mini-markup (`features/explain/inline.js`)

Safe, tiny, no HTML ever. Parsed into tokens, then rendered with DOM APIs.

| syntax | result |
|---|---|
| `**text**` | `<strong>` |
| `_text_` | `<em>` (only when `_` is at a word boundary) |
| `==text==` | `<mark class="key">` (author emphasis, not a user highlight) |
| `^text^` | `<sup>` |
| `~text~` | `<sub>` |
| `` `text` `` | `<code>` |
| `->` `<-` `<->` `=>` `↑` `↓` | arrows `→ ← ↔ ⇒` (rendered as text with class `arrow`) |
| `\*` etc. | escaped literal |

Unclosed markers render literally. Nesting allowed for strong/em/mark.

API:
- `parseInline(text) → Token[]` (pure). Token = `{t:'text', v}` | `{t:'strong'|'em'|'mark'|'sup'|'sub'|'code', c: Token[]}` | `{t:'arrow', v}`.
- `inlineToPlain(text) → string` (pure; the visible text, used for search, anchoring, GPT prompt).

### 3.6 `data/retired.json`

`{ "retired": ["CPB-0007"] }`

## 4. Storage (IndexedDB)

Database `cardiac-mcq`, version `1`. Only `store/repo.js` uses `store/db.js`.

| store | keyPath | indexes | record |
|---|---|---|---|
| `settings` | `key` | — | `{key, value}` |
| `qstate` | `qid` | — | QState |
| `attempts` | `id` (autoIncrement) | `qid`, `ts`, `sessionId` | `{id, qid, choice, correct, ms, ts, mode, sessionId}` |
| `notes` | `qid` | `updated` | `{qid, text, updated}` |
| `highlights` | `id` | `qid` | Highlight |
| `ink` | `id` (`${qid}|${block}`) | `qid` | `{id, qid, block, qversion, strokes: Stroke[], updated}` |
| `voice` | `id` | `qid`, `ts` | `{id, qid, blob, mime, durationMs, ts}` |
| `reports` | `id` | `qid` | `{id, qid, qversion, reason, text, ts}` |
| `reviews` | `qid` | — | `{qid, qversion, status: 'ok'\|'fix', comment, ts}` |
| `sessions` | `id` | `updatedAt` | Session |

QState:
```js
{ qid, seen, correct, incorrect, totalMs, lastChoice, lastCorrect, lastTs,
  bookmarked: false, srs: null | { due, interval, ease, reps, lapses } }
```

Highlight:
```js
{ id, qid, qversion, block, quote, prefix, suffix, start, color, ts }
// block: "stem" | "choice-<choiceId>" | "note-<choiceId>" | <explanation block id>
// color: 'yellow' | 'green' | 'blue' | 'pink'
```

Stroke (all coordinates are fractions of the layer's width/height, rounded to 4 decimals):
```js
{ tool: 'pen' | 'hl', color: '#rrggbb', size: number /* fraction of width */,
  pts: number[] /* flat [x, y, pressure, x, y, pressure, ...] */ }
```

### 4.1 `store/db.js`

```js
export const DB_NAME = 'cardiac-mcq';
export const DB_VERSION = 1;
export function openDB(): Promise<IDBDatabase>            // singleton; runs migrations
export function tx(stores: string|string[], mode: 'readonly'|'readwrite',
                   fn: (stores: Record<string, IDBObjectStore>) => any): Promise<any>
  // resolves with fn's (awaited request) result after the transaction COMPLETES
export function reqP(request: IDBRequest): Promise<any>
export function get(store, key), getAll(store, {index, query}?), put(store, value),
                del(store, key), clear(store), count(store, {index, query}?)
export function getAllByIndex(store, index, query)
```
- `onversionchange` → close the connection and emit `db:versionchange` (shell shows "Please reload").
- Quota errors → emit `storage:error` with `{name, message}`.
- Migrations: an array indexed by version; each migration receives `(db, tx, oldVersion)`.

### 4.2 `store/repo.js`

```js
export const settingsRepo  = { get(key), set(key, value), all() }          // all() → {key: value}
export const qstateRepo    = { get(qid), all(), put(state), update(qid, (prev|null) => next) }
export const attemptsRepo  = { add(a), byQid(qid), all(), since(ts) }
export const notesRepo     = { get(qid), set(qid, text) /* deletes when empty */, all() }
export const highlightsRepo= { byQid(qid), add(h) /* assigns id */, update(h), remove(id), all() }
export const inkRepo       = { get(qid, block), byQid(qid), set(qid, block, {qversion, strokes}) /* deletes when no strokes */, all() }
export const voiceRepo     = { byQid(qid), add({qid, blob, mime, durationMs}) /* assigns id, ts */, remove(id), all() }
export const reportsRepo   = { add(r), byQid(qid), remove(id), all() }
export const reviewsRepo   = { get(qid), set(qid, {qversion, status, comment}), remove(qid), all() }
export const sessionsRepo  = { get(id), put(s), remove(id), all(), latestUnfinished() }
export const ALL_STORES    = ['settings','qstate','attempts','notes','highlights','ink','voice','reports','reviews','sessions']
export async function dumpStore(name) / replaceStore(name, records) / mergeStore(name, records)
```
Every write emits `bus.emit('store:change', {store, key})`.

## 5. Core modules

### 5.1 `core/dom.js`
```js
export function h(tag, props?, ...children): HTMLElement
// props: class (string|string[]), style (object|string), dataset (object), any attribute,
// on<Event>: function → addEventListener, boolean attr true/false → set/remove,
// null/undefined → skipped. Children: Node | string | number | array | null/false (skipped).
export function svg(tag, attrs?, ...children): SVGElement
export function $(sel, root = document), $$(sel, root = document) /* array */
export function clear(el)
export function frag(...children): DocumentFragment
```

### 5.2 `core/events.js`
```js
export const bus = { on(name, fn) /* returns off() */, once(name, fn), off(name, fn), emit(name, payload) }
```
Event names: `route:change`, `settings:change` ({key, value}), `store:change`, `sw:update-ready`,
`net:change` ({online}), `storage:error`, `db:versionchange`, `qstate:change` ({qid}).

### 5.3 `core/util.js` (pure)
`uid()`, `hashString(s) → uint32` (FNV-1a), `seededRandom(seed) → () => float` (mulberry32),
`shuffle(array, rand = Math.random) → new array`, `clamp(n, min, max)`, `debounce(fn, ms)`,
`throttle(fn, ms)`, `sleep(ms)`, `formatDuration(ms) → "1:05" / "1:02:03"`,
`formatRelative(ts, now)` ("just now", "5 min ago", "yesterday", "12 Mar"),
`dayKey(ts) → "YYYY-MM-DD"` (local), `plural(n, word, pluralWord?)`, `pct(a, b) → 0..100 int`.

### 5.4 `core/router.js`
```js
export function startRouter({ routes, mount, onRoute }): void
// routes: { '/': () => import('../screens/home.js'), '/chapter/:id': () => import(...), ... }
export function navigate(path, { replace = false } = {}): void   // path like '/quiz/abc?x=1'
export function back(fallback = '/'): void                       // history.back() or navigate(fallback)
export function currentRoute(): { path, params, query, pattern }
```
Screen module contract (default export):
```js
export default {
  // called on every navigation to the route
  async render(ctx /* {params, query, path} */) → HTMLElement | { el, destroy?() },
}
```
The screen sets the header itself through `shell.setHeader()`. The router clears
`#main`, calls the previous screen's `destroy()`, mounts the new element, scrolls
to top (unless the screen returns `{keepScroll:true}`), moves focus to the first
`h1` in `#main` (tabindex -1) for screen readers, saves `lastRoute` (except
`/settings`), and emits `route:change`. Unknown routes → home. A failed lazy
import shows an error state with "Reload".

Routes:

| path | screen | purpose |
|---|---|---|
| `/` | home | Start/continue, due reviews, quick actions, chapter list |
| `/chapter/:id` | chapter | Chapter progress + start practice in it |
| `/new` | builder | Build a custom quiz (query may preset `chapters`, `filter`, `mode`) |
| `/quiz/:id` | player | Answer questions of session `id` |
| `/results/:id` | results | Score + review list of a finished session |
| `/q/:qid` | question | Browse one question (answer revealed) from search/library |
| `/library` | library | Tabs: Bookmarks, Notes, Voice, Highlights, Flagged, Sessions |
| `/stats` | stats | Statistics |
| `/search` | search | Search (`?q=`) |
| `/settings` | settings | Appearance, study, data (backup), reviewer mode, about |
| `/reviewer` | reviewer | Reviewer dashboard (reviewer mode only) |

### 5.5 `core/settings.js`
Defaults:
```js
{ theme: 'system' /* 'light'|'dark' */, fontScale: 1 /* 0.85–1.5 */, reduceMotion: 'system',
  shuffleChoices: true, defaultCount: 20, examSecondsPerQuestion: 90,
  autoAdvance: false, showTimer: true, drawInput: 'auto' /* 'finger'|'pen' */,
  highlightColor: 'yellow', inkTool: 'pen', inkColor: '#1d4ed8', inkSize: 0.006,
  reviewerMode: false, tourDone: false, askGptNoticeSeen: false, lastRoute: null }
```
```js
export async function initSettings()     // loads from settingsRepo, applies
export function getSetting(key)          // sync, after init
export async function setSetting(key, value) // persists, applies, emits settings:change
export function applySettings()          // <html data-theme="light|dark" data-reduce-motion="true|false" style="--font-scale">
```

### 5.6 `core/data.js`
```js
export async function loadIndex() → { schemaVersion, chapters: Chapter[] }   // memoized, sorted by order
export async function loadChapter(id) → { chapter: Chapter, questions: Question[] }  // memoized
export async function loadAll({ includeDemo = true } = {}) → Question[]
export async function getQuestion(qid) → Question | null      // finds chapter by prefix
export async function getQuestions(qids) → Question[]          // keeps order, skips missing
export function chapterIdFromQid(qid) → string | null          // after loadIndex()
export function questionPlainText(q) → string                  // stem + choices + explanation (plain)
```
Each returned Question gets non-enumerable-safe extra field `chapterId`. Fetch
failures throw `DataError` (exported class) with a user-friendly message.

### 5.7 `core/sw-client.js`
```js
export function initServiceWorker(): void
```
- Registers `sw.js` (relative) with `{ scope: './' }`.
- On launch (and every time the app becomes visible, at most every 30 min), if
  online, calls `registration.update()`.
- When a new worker is `installed` while a controller exists → `bus.emit('sw:update-ready')`
  and the shell shows the banner **"Update available"** with **Update** and **Later**.
- **Update** → `postMessage({type:'SKIP_WAITING'})` to the waiting worker → on
  `controllerchange` reload once (guard against loops).
- Online/offline: emits `net:change`; the shell shows a small, calm "Offline — everything still works" banner (auto-hides when online).
- Never touches IndexedDB. User data survives every update.

### 5.8 `sw.js`
- `const VERSION = 'YYYY.MM.DD-N';` cache `cmcq-shell-${VERSION}` (app files) and
  `cmcq-data-${VERSION}` (question data + images).
- `APP_SHELL` = explicit list of every file the app needs (`./`, `index.html`,
  manifest, all css, all js, icons). `scripts/validate.mjs` checks the list is complete.
- `install`: precache APP_SHELL, then fetch `data/index.json`, `data/retired.json`
  and every chapter `file` in it, precache them. **No automatic skipWaiting.**
- `activate`: delete caches not matching current VERSION, `clients.claim()`.
- `fetch` (GET, same origin only): navigations → cached `index.html` (network
  fallback); everything else cache-first, then network (and put into the
  matching cache). Cross-origin requests are not intercepted.
- `message`: `{type:'SKIP_WAITING'}` → `self.skipWaiting()`; `{type:'GET_VERSION'}` → reply.

### 5.9 Release process
Every deploy that changes any app file or data **must** run
`node scripts/bump-version.mjs` (updates `sw.js` and `js/version.js`) and
`node scripts/validate.mjs`, so installed apps detect the update.

## 6. UI

### 6.1 Design tokens (`css/tokens.css`) — names are fixed
Colors: `--bg --surface --surface-2 --surface-3 --text --text-2 --text-3 --border --border-strong
--primary --primary-hover --primary-contrast --primary-soft --success --success-soft
--danger --danger-soft --warning --warning-soft --info --info-soft
--hl-yellow --hl-green --hl-blue --hl-pink --focus`
Spacing: `--sp-1`(4px) … `--sp-8`(48px). Radii: `--r-s`(8) `--r-m`(12) `--r-l`(18) `--r-full`.
Type: `--font-sans` (system UI stack), `--font-mono`, `--font-scale` (set by settings),
`--fs-xs --fs-s --fs-m --fs-l --fs-xl --fs-xxl` (all multiplied by `--font-scale`),
`--lh-tight --lh-body`. Elevation: `--shadow-1 --shadow-2 --shadow-3`.
Motion: `--ease --dur-fast --dur` (0ms when `[data-reduce-motion="true"]`).
Touch: `--tap` (44px). Layout: `--maxw` (reading width ~72ch), `--header-h`, `--tabbar-h`,
`--safe-top --safe-bottom` (from env(safe-area-inset-*)).
Primary color `#b01e2d` (light), lighter red in dark mode. Theme: `<html data-theme="light|dark">`.

Breakpoints: phone `< 700px` (bottom tab bar), tablet `≥ 700px` (side rail),
wide `≥ 1000px` (player shows question and explanation side by side).

### 6.2 `ui/icons.js`
`export function icon(name, { size = 20, label } = {}) → SVGElement` (stroke icons, `currentColor`,
`aria-hidden="true"` unless `label`). Names: `home library stats search settings bookmark
bookmark-filled flag pen highlighter eraser undo redo mic stop play pause trash chevron-left
chevron-right chevron-down close check x clock share download upload sparkles list grid info
alert refresh moon sun text-size note image more target flame layers lasso zoom-in zoom-out
hand eye eye-off filter shuffle timer star`.

### 6.3 `ui/components.js`
```js
button({ label, icon, variant = 'secondary' /* primary|secondary|ghost|danger */, size = 'm' /* s|m|l */,
         onClick, ariaLabel, disabled, type = 'button', block = false }) → HTMLButtonElement
iconButton({ icon, label /* required, used as aria-label + tooltip */, onClick, pressed /* bool|undefined */, variant = 'ghost' })
toast(message, { action /* {label, onClick} */, duration = 4000, kind = 'info' /* success|danger */ }) → { close }
undoToast(message, onUndo)                      // 6s, "Undo" action
sheet({ title, content /* Node */, actions /* Node[] */, onClose, size = 'm' /* full */ }) → { close, el }
  // bottom sheet on phone, centered dialog ≥700px; focus trap; Esc and backdrop close; returns focus
confirmSheet({ title, text, confirmLabel, danger }) → Promise<boolean>   // only for irreversible actions
emptyState({ icon, title, text, action /* Node */ }) → HTMLElement
progressBar(value /* 0..100 */, { label }) → HTMLElement
ring(value, { size = 48, label }) → SVG-based HTMLElement
chip(label, { kind /* neutral|success|danger|warning|info|primary */, icon }) → HTMLElement
segmented({ options: [{value, label}], value, onChange, ariaLabel }) → HTMLElement
toggle({ checked, onChange, label, description }) → HTMLElement
listItem({ title, subtitle, icon, trailing, onClick, href }) → HTMLElement
spinner({ label }) → HTMLElement
skeleton(lines = 3) → HTMLElement
```

### 6.4 `ui/shell.js`
```js
export function initShell(): void                 // wires header, tab bar, slots, banners from bus events
export function setHeader({ title, back /* path | true | null */, actions /* Node[] */, subtitle }): void
export function showBanner(id, { text, kind, actions, dismissible }): void
export function hideBanner(id): void
export function setTabBarVisible(visible): void   // player hides it for focus
```
`index.html` contains: `<header id="app-header">`, `<nav id="tabbar">` (Home, Library,
Stats, Search, Settings), `<div id="banner-slot">`, `<main id="main" tabindex="-1">`,
`<div id="toast-slot" aria-live="polite">`, `<div id="sheet-slot">`, a `<noscript>`
message, and a boot splash removed by `app.js` once the first screen renders.

### 6.5 `ui/tour.js`
`export async function maybeShowTour()` — first run only (setting `tourDone`),
4 short skippable slides: practice & exam, highlight & draw, notes & voice,
offline & backup. Also `showTour()` (from Settings).

## 7. Features

### 7.1 `features/srs.js` (pure)
SM-2 variant, automatic grading from correctness and time.
```js
export function nextSrs(prev /* srs|null */, { correct, ms }, now) → srs
// wrong: reps=0, lapses+1, interval=0, due=now+10min, ease=max(1.3, ease-0.2)
// right: reps+1; interval = reps==1 ? 1 : reps==2 ? 3 : round(interval*ease); due=now+interval days;
//        fast & right (ms < 20s) ease+0.05 (max 3.0); slow & right (ms > 90s) ease-0.05
export function isDue(srs, now) → boolean
export const DEFAULT_EASE = 2.5
```

### 7.2 `features/quiz/builder.js`
```js
export const FILTERS = ['all','new','incorrect','bookmarked','due','unreviewed','flagged','notes']
export async function buildQuestionSet({ chapters /* ids[] | 'all' */, filter = 'all',
  count /* number | 'all' */, order = 'random' /* | 'sequential' */, includeDemo = false, seed }) → qids[]
export async function countAvailable({ chapters, filter, includeDemo }) → number
export function filterQids(questions, states /* Map qid→QState */, extras /* {flagged:Set, notes:Set} */, filter, now) → qids[] // pure
```
`'all'` chapters excludes demo unless `includeDemo`. If the real bank is empty, the UI offers the demo.

### 7.3 `features/quiz/engine.js`
Session:
```js
{ id, title, mode: 'tutor' | 'exam', createdAt, updatedAt, finishedAt: null,
  qids: [], choiceOrder: { [qid]: choiceId[] }, index: 0,
  answers: { [qid]: { choice, correct, ms, at } },   // tutor: locked once answered; exam: changeable until finish
  struck: { [qid]: choiceId[] }, marked: { [qid]: true },
  timeLimitMs: null | number, elapsedMs: 0, perQuestionMs: { [qid]: number },
  options: { shuffleChoices, chapters, filter } }
```
Pure reducers (no I/O, return new objects): `createSessionObject(opts, questions, now, seed)`,
`applyAnswer(s, qid, choice, correct, ms, now)`, `toggleStrike(s, qid, choice)`, `toggleMark(s, qid)`,
`goTo(s, index)`, `addTime(s, qid, ms)`, `finishSession(s, now)`, `summarize(s, questions)` →
`{ total, answered, correct, incorrect, unanswered, pct, timeMs, avgMs, byChapter: [{chapterId, total, correct}], byTopic }`.

Async API (uses repos): `createSession(opts)` → session (persisted), `loadSession(id)`,
`saveSession(s)` (debounced 300ms internally + flush on `visibilitychange`),
`recordAnswer(s, question, choice, ms)` → `{ session, correct }` (tutor: updates qstate + srs + attempts
immediately; exam: only the session), `completeSession(s, questions)` (exam: grades and writes
qstate/srs/attempts for all answers), `deleteSession(id)`, `latestUnfinished()`.
Emits `qstate:change`.

### 7.4 `features/stats.js`
`export async function computeStats(now) → { totalQuestions, answeredUnique, attempts, correctPct,
avgMs, dueCount, bookmarks, notes, voice, highlights, byChapter: [{id, title, total, answered, correct, pct}],
weakTopics: [{topic, chapterId, n, pct}] (n ≥ 3, lowest pct first, max 8), daily: [{day, n, correct}] (last 30 days),
streak, bestStreak }` (demo excluded).

### 7.5 `features/search.js`
`export async function search(query, { limit = 50, includeDemo = true }) → [{ qid, chapterId, title /* stem start */, snippet: [{text, match}], score }]`.
Builds an inverted index lazily (memoized), tokenizes lowercase, strips punctuation,
prefix match on the last term, all terms must match (AND), ranks stem/topic hits above explanation hits.
Pure helpers exported for tests: `tokenize(text)`, `buildIndex(questions)`, `queryIndex(index, query)`.

### 7.6 `features/explain/render.js`
```js
export function renderInline(text) → DocumentFragment
export function renderBlocks(blocks, { qid }) → HTMLElement  // <div class="explain">, each block element has
                                                          //   data-block="<id>" and class "xb xb-<type>"
export function renderStem(q) → HTMLElement               // data-block="stem"
export function renderImage(img) → HTMLElement            // lazy, tap to zoom
```
- Tables: horizontally scrollable wrapper, sticky first column on phones, zebra rows, optional emphasis.
- Flow: vertical chain of rounded step boxes joined by arrows (HTML/CSS + inline SVG arrow),
  arrow labels, branch rows side by side (stack on narrow screens).
- Mind map: central node with branches and leaf chips, HTML/CSS (two columns on wide,
  stacked on phone) with connector lines drawn by CSS. Text stays real, selectable text.
- Callouts: icon + color per kind (key=primary, pearl=info, pitfall=danger, mnemonic=warning).
- Quote: left rule, citation line.
All text is real DOM text so highlights and search work.

### 7.7 Annotations
`annotate/anchor.js`:
```js
export function makeAnchor(blockText, start, end) → { quote, prefix, suffix, start }   // pure, 32-char context
export function findAnchor(blockText, anchor) → { start, end } | null                  // pure: exact at start → nearest exact quote (scored by context) → null
export function textOffsetsInElement(el, range) → { start, end }                       // DOM
export function rangeFromOffsets(el, start, end) → Range                               // DOM
```
`annotate/highlight.js`:
```js
export function initHighlights(root, question, { onOrphans }) → { destroy(), refresh() }
```
- Applies stored highlights to `[data-block]` elements in `root` by wrapping text
  in `<mark class="uhl uhl-<color>" data-hl="<id>">` (split across nodes safely).
- Selecting text inside one block shows a floating bar (colors + "Copy"); choosing a
  color saves immediately. Tapping a highlight shows a bar (change color, remove → undo toast).
- Selections spanning several blocks are clipped to the first block.
- Orphans (anchor not found or `qversion` changed and quote missing) → `onOrphans(list)`;
  the player shows "Some of your highlights no longer match this updated question" with a list.

`annotate/ink.js`:
```js
export function initInk(root, question) → InkController
// InkController: { enable(), disable(), isEnabled(), setTool('pen'|'hl'|'eraser'), setColor(hex), setSize(frac),
//                  undo(), redo(), canUndo(), canRedo(), clearAll() /* undoable */, destroy(), on(event, fn) }
export function renderStrokes(ctx, strokes, width, height, dpr)      // shared by layers + scratchpad
export function strokeToPath(stroke, width, height) → polygon points // variable-width outline (pressure + speed)
```
- One transparent `<canvas class="ink-layer">` per `[data-block]` element in `root`,
  sized to the element (ResizeObserver, devicePixelRatio aware). Coordinates stored as fractions.
- Disabled: layers ignore input (`pointer-events: none`) but still show ink.
- Enabled: Pointer Events with `setPointerCapture`; pen pressure (`pointerType==='pen'`),
  simulated pressure for touch/mouse from speed. Palm rejection: once a pen is seen,
  touch input scrolls instead of drawing (setting `drawInput`: auto|finger|pen).
  Two-finger touch = scroll the page (manual scroll), never draws.
- Highlighter tool: wide, 35% alpha, drawn under pen strokes, `multiply` blend in light mode.
- Eraser: removes whole strokes it touches.
- Undo/redo stack per controller (covers add, erase, clear). Saves to `inkRepo` debounced (400ms) and on disable/destroy.
- Smoothing: streamline input points, render with quadratic curves; 60fps with requestAnimationFrame.

`annotate/ink-toolbar.js`: `export function createInkToolbar(controller, { onDone, onScratchpad }) → HTMLElement`
(floating, draggable-free, docked at the bottom above the safe area: pen, highlighter, eraser, 6 colors,
3 sizes, undo, redo, clear, scratchpad, Done). Remembers last tool/color/size in settings.

`annotate/scratchpad.js`: `export function openScratchpad(question)` — full-screen sheet with an
infinite-feel canvas (logical size 2000×3000), two-finger pinch zoom (0.5–4×) and pan, same tools,
saved as ink block `"scratch"`.

### 7.8 `features/notes.js`
`export function createNoteEditor(qid) → HTMLElement` — auto-growing textarea, autosave (debounced 500ms,
"Saved" indicator), character count hidden until 1000+.

### 7.9 `features/voice.js`
```js
export function isVoiceSupported() → boolean
export function createRecorder() → { start(): Promise, stop(): Promise<{blob, mime, durationMs}>, cancel(), state, onLevel(fn) }
export function createVoiceNotes(qid) → HTMLElement
```
Mime preference: `audio/webm;codecs=opus`, `audio/mp4`, `audio/webm`, default. Max 5 min (auto-stop).
UI: big record button, live timer + level meter, stop; list with play/pause, scrubber, duration,
date, delete (undo toast). Permission denied → plain-language help text.

### 7.10 `features/askgpt.js`
```js
export function buildPrompt(question, { choiceOrder, userChoice }) → string   // pure
export function askGptUrl(prompt) → string   // 'https://chatgpt.com/?q=' + encodeURIComponent(prompt), prompt trimmed to 4000 chars
export function createAskGptButton(question, getContext /* () => {choiceOrder, userChoice} */) → HTMLElement
```
Prompt: role (cardiac surgery board resident), the question, lettered choices in the displayed order,
the user's answer, the app's correct answer, request: explain why the answer is correct and others are wrong,
concise, board-focused. First use shows a one-time notice ("ChatGPT is an outside source and may not match
your study sources") with Continue/Cancel. Opens with `window.open(url, '_blank', 'noopener')`; if that is
blocked, copies the prompt and shows a toast with an "Open ChatGPT" link. Disabled with a hint while offline.

### 7.11 `features/review.js`
```js
export const REPORT_REASONS = ['Wrong answer', 'Unclear question', 'Typo or formatting', 'Explanation problem', 'Other']
export function openReportSheet(question)               // reason + optional text → reportsRepo
export function createReviewerPanel(question) → HTMLElement   // reviewer mode: Approve / Needs fix + comment
export async function exportReviewFile() → { blob, filename }  // reviews + reports JSON
export function unreviewedBadge(question) → HTMLElement | null  // chip "Not yet reviewed" when reviewed === false
```
Review file: `{ type: 'cardiac-mcq-review', formatVersion: 1, appVersion, exportedAt, reviews: [...], reports: [...] }`.

### 7.12 `features/backup.js`
```js
export async function exportBackup({ includeMedia = true }) → { blob, filename }   // cardiac-mcq-backup-YYYY-MM-DD.json
export async function saveFile(blob, filename)    // navigator.share({files}) when available (iOS), else download link
export async function readBackupFile(file) → { data, summary: {counts per store, exportedAt, includesMedia} }  // validates, throws BackupError
export async function importBackup(data, { mode /* 'merge' | 'replace' */ }) → summary
export async function storageInfo() → { usage, quota, persisted }
export async function requestPersistence() → boolean
```
Backup: `{ type: 'cardiac-mcq-backup', formatVersion: 1, appVersion, exportedAt, includesMedia,
stores: { [storeName]: records[] } }` — voice blobs as `{..., blob: null, data: base64, mime}`; without media the
voice store is omitted. Merge: per store, newer `updated/ts` wins; attempts deduplicated by `(qid, ts)`.
Replace: clears every store first (after the user confirms). Import never touches settings `lastRoute`.

## 8. Screens (summary of required UX)

- **Home**: greeting line, "Continue" card for the latest unfinished session (progress, mode), "Due for review" card
  (count, one tap to start), quick actions (Practice 20, Exam, Mistakes, Bookmarks — each one tap, uses defaults),
  "Build custom quiz", **published** chapters grouped by part with progress rings and counts (unpublished chapters and empty parts
  are never shown), demo card when no chapter is published.
- **Chapter**: title, progress, accuracy, topics list, buttons: Practice (tutor), Exam, Mistakes in this chapter.
- **Builder**: chapters (multi-select chips, "All"), filter (segmented), count (10/20/40/All + custom), mode
  (Practice: explanation after each answer / Exam: timed, results at the end), shuffle; live "N questions available";
  Start. Disabled Start with a reason when 0.
- **Player** (most important screen): top bar: close (saves and goes back), progress "7 / 20", timer (exam), mark (exam),
  bookmark, more menu (report, note, voice, scratchpad, ask GPT). Question: unreviewed chip, stem, image, choices as large
  buttons with letter badges; long-press or swipe-left on a choice (and a visible small "strike" button) toggles strike-through.
  Tutor: tap choice → instant feedback (correct green / chosen wrong red, correct shown), explanation slides in below
  (side-by-side on wide screens), with "Your notes" section (text note + voice notes), Ask GPT, highlights and draw.
  Exam: tap selects (changeable), Next/Prev, question navigator grid sheet, Finish (confirms if unanswered remain);
  time up → auto-finish with notice. Bottom bar: Prev, Draw toggle, Highlight hint, Next. Keyboard: 1–5/A–E choose,
  ←/→ navigate, B bookmark, D draw. Always resumable.
- **Results**: score ring, correct/incorrect/unanswered, time, by chapter, list of questions with status → open
  in review (browse) mode, "Retry mistakes" button.
- **Question** (browse): same rendering as player in answered state, with prev/next when opened from a list.
- **Library**: tabs Bookmarks / Notes / Voice / Highlights / Flagged / Sessions; each list opens the question; empty states teach the feature.
- **Stats**: overview tiles, 30-day activity bars (SVG), accuracy by chapter bars, weak topics, streak.
- **Search**: big search field (autofocus), instant results as you type (debounced 150ms), match highlighting.
- **Settings**: Appearance (theme, text size with live preview), Study (shuffle, default count, exam seconds per
  question, auto-advance, draw input), Data (export with/without media, import with merge/replace, storage used,
  persistent storage status), Reviewer mode toggle (+ link to dashboard), Help (show tour), About (version, check for update).
- **Reviewer**: counts (reviewed true/false in data, your approvals/fix requests), list of unreviewed questions,
  export review file.

## 9. Testing

- `node --test tests/unit/*.test.mjs` — pure modules (one `*.test.mjs` file per module area): inline parser, anchor, srs, builder filterQids, engine reducers/summarize,
  search tokenize/index/query, util, askgpt buildPrompt.
- `node tests/e2e.mjs` — starts `tests/serve.mjs`, runs Chromium (phone and iPad viewports): boots offline-capable,
  home renders, demo practice flow (answer, explanation blocks render), bookmark persists across reload,
  highlight via selection persists, ink stroke via pointer events persists, note autosave, exam flow + results,
  search finds a demo question, backup export → reset → import round trip, offline reload works, update banner appears
  after a version bump. Exit code 1 on any failure.
- `node scripts/validate.mjs` — data + precache + version checks.
