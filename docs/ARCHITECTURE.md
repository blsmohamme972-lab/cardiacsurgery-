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
  index.json               Chapter list.
  retired.json             Retired question IDs (never reuse).
  ch01-cpb.json ... ch13-trauma.json, demo.json

scripts/                   Dev-only (Node 20+, no dependencies). Never loaded by the app.
  validate.mjs             Validates data + precache list + version consistency. Exit 1 on error.
  bump-version.mjs         Sets a new version in sw.js and js/version.js.
tests/                     Dev-only.
  unit/*.test.mjs          Node unit tests for pure modules (node:test + node:assert). Run: node --test tests/unit/
  e2e.mjs                  Playwright end-to-end tests (uses the pre-installed playwright).
  serve.mjs                Tiny static file server used by e2e (serves repo under /cardiacsurgery-/).
docs/ARCHITECTURE.md       This file.
```

## 3. Data format

### 3.1 `data/index.json`

```json
{
  "schemaVersion": 1,
  "chapters": [
    { "id": "cpb", "prefix": "CPB", "title": "CPB & myocardial protection",
      "short": "CPB", "file": "data/ch01-cpb.json", "order": 1, "count": 0 }
  ]
}
```

Chapters, ids, prefixes and files (fixed):

| order | id | prefix | file | title |
|---|---|---|---|---|
| 1 | cpb | CPB | data/ch01-cpb.json | CPB & myocardial protection |
| 2 | cabg | CABG | data/ch02-cabg.json | CABG |
| 3 | valves | VALV | data/ch03-valves.json | Valves |
| 4 | aorta | AORT | data/ch04-aorta.json | Aorta |
| 5 | congenital | CONG | data/ch05-congenital.json | Congenital |
| 6 | hf | HFTX | data/ch06-hf-vad-tx.json | HF/VAD/transplant |
| 7 | arrhythmia | ARRH | data/ch07-arrhythmia.json | Arrhythmia surgery |
| 8 | pericardium | PERI | data/ch08-pericardium-tumors.json | Pericardium & tumors |
| 9 | thoracic | THOR | data/ch09-thoracic.json | Thoracic basics |
| 10 | icu | ICU | data/ch10-postop-icu.json | Postop ICU |
| 11 | anatomy | ANAT | data/ch11-anatomy-physiology.json | Anatomy & physiology |
| 12 | pharm | PHAR | data/ch12-pharmacology.json | Pharmacology |
| 13 | trauma | TRAU | data/ch13-trauma.json | Trauma |
| 99 | demo | DEMO | data/demo.json | App tour (demo) — has `"demo": true` |

`count` must equal the number of questions in the file (validated).

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
  "Build custom quiz", chapter list with progress rings and counts ("Coming soon" when 0), demo card when the real bank is empty.
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

- `node --test tests/unit/` — pure modules (one `*.test.mjs` file per module area): inline parser, anchor, srs, builder filterQids, engine reducers/summarize,
  search tokenize/index/query, util, askgpt buildPrompt.
- `node tests/e2e.mjs` — starts `tests/serve.mjs`, runs Chromium (phone and iPad viewports): boots offline-capable,
  home renders, demo practice flow (answer, explanation blocks render), bookmark persists across reload,
  highlight via selection persists, ink stroke via pointer events persists, note autosave, exam flow + results,
  search finds a demo question, backup export → reset → import round trip, offline reload works, update banner appears
  after a version bump. Exit code 1 on any failure.
- `node scripts/validate.mjs` — data + precache + version checks.
