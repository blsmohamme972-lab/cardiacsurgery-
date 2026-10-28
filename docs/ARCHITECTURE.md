# Architecture

The contract for every module in the app. Code must match these names, shapes
and behaviours exactly. If a contract has to change, change this file in the
same commit.

App display name: **KirKlin** (CLAUDE.md); internal ids (`cardiac-mcq` DB, `cmcq-` caches,
`cardiac-mcq-backup` type) never change.

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
icons/                     App icons (icon-180.png, icon-192.png, icon-512.png, icon-maskable-512.png; icon.svg master).
fonts/                     Bundled fonts (SIL OFL 1.1, fonts/OFL.txt): Inter (latin + greek) and Manrope, variable woff2.

css/
  tokens.css               Design tokens (colors, spacing, type scale, radii, shadows), light + dark.
  base.css                 Reset, typography, layout primitives, utilities, focus styles.
  components.css           Buttons, cards, chips, lists, sheets, toasts, banners, tabs, toggles, progress.
  shell.css                Header, tab bar / side rail, page layout, responsive breakpoints.
  explanation.css          Explanation block renderer (tables, flows, mind maps, callouts, quotes).
  annotate.css             Highlights (anchor + highlight UI).
  ink.css                  Ink layers, ink toolbar, scratchpad.
  features.css             Notes, voice notes, Ask GPT, read aloud.
  review.css               Report sheet, reviewer panel, backup import dialog.
  screen-player.css        Question player + results.
  screen-home.css          Home, chapter, quiz builder, library.
  screen-misc.css          Stats, search, settings, reviewer dashboard (the tour is styled in components.css).

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
    tts.js                 Read aloud with the device's own voices (§7.15).
    lists.js               Shared question lists (library, browse prev/next) (§7.13).
    question-view.js       Shared question rendering for player/browse/results (§7.13).
    quiz/start.js          One place that starts a quiz (§7.13).
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
  lint.mjs                 Static checks (imports, CSS vars, no innerHTML/console.log, relative URLs, @module, APP_SHELL).
tests/                     Dev-only.
  unit/*.test.mjs          Node unit tests for pure modules (node:test + node:assert). Run: node --test tests/unit/*.test.mjs
  e2e.mjs                  Playwright end-to-end tests (uses the pre-installed playwright).
  serve.mjs                Tiny static file server used by e2e (serves repo under /cardiacsurgery-/).
  smoke.mjs                Playwright boot smoke test (stubs missing files in memory).
  visual/*.mjs             Playwright visual/behaviour checks per feature (screenshots phone + iPad, light + dark).
  fixtures/explain.html    Dev gallery of every explanation block type.
docs/ARCHITECTURE.md       This file.
```

## 3. Data format

### 3.1 `data/index.json`

The book structure (owner-provided table of contents, 2026-10-26): **7 parts, 55 chapters**.
It replaces the earlier 13-chapter plan. Every chapter starts **unpublished** and
is **completely hidden** in the app (home, chapter list, builder, stats, search,
library counts) until the owner approves it and `published` is set to `true`.
A part is hidden while it has no published chapter. The demo chapter is always
loadable.

**Demo mode.** While no chapter is published, the demo chapter stands in for the
whole bank everywhere (Home quick actions, chapter list, builder "All", stats,
search, library), so every feature can be tried. As soon as one chapter is
published, the demo disappears from all of those and is only reachable from
Settings > Help > "Try the demo". `data.js` exposes this as `demoMode` and
`studyChapters()` (§5.6); no other module decides it on its own.

```json
{
  "schemaVersion": 1,
  "parts": [ { "id": "p1", "number": "I", "title": "General Considerations", "volume": 1 } ],
  "chapters": [
    { "id": "ch01", "number": 1, "part": "p1", "prefix": "CH01", "title": "Anatomy and Dimensions",
      "short": "Anatomy", "file": "data/ch01.json", "page": 1, "published": false, "count": 0 }
  ],
  "demo": { "id": "demo", "prefix": "DEMO", "title": "App tour (demo)", "short": "Demo",
            "file": "data/demo.json", "count": 10 }
}
```

- `short` = short label for chips and tight spaces (≤ 16 characters, UI only; editable).

- `page` = first page of the chapter in the owner's book (used in source references).
- `count` must equal the number of questions in the file (validated).
- `scripts/validate.mjs` checks `parts` against the parts table (same order), every chapter
  against its row in the chapter table (id, number, part, prefix, file, title, page), and
  `demo` against the demo row; `published` must be `true`/`false`, and a published chapter
  with 0 questions is an **error**, as is an empty demo file. Every chapter file is validated,
  published or not. A `data/` path in `sw.js` `APP_SHELL` is an error (data is precached from
  the index only).
- `data.js` (§5.6): `loadIndex()` exposes `parts`, `chapters` (published only, sorted by number),
  `demo` and `demoMode`; `loadIndex({ includeUnpublished: true })` is for dev tools only.
  `getQuestion()` of an unpublished chapter returns `null`. Builder, stats, search
  and home only ever see `studyChapters()` (published chapters, or the demo in demo mode).
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
  "chapter": "ch22",
  "questions": [ /* Question */ ]
}
```

### 3.3 Question

```json
{
  "id": "CH03-0001",
  "version": 1,
  "topic": "Topic name from the source",
  "tags": ["tag"],
  "difficulty": 2,
  "reviewed": false,
  "stem": "A 64-year-old man ... Which is the **best** next step?",
  "image": { "src": "data/img/CH03-0001.webp", "alt": "...", "caption": "..." },
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

Safe, tiny, no HTML ever. Parsed into tokens (pure, linear time, never throws),
then rendered with DOM APIs by `render.js`. Every string field of a question and
of its explanation blocks uses it.

| syntax | result | rules and examples |
|---|---|---|
| `**text**` | `<strong>` | Exactly two `*`. `*a*`, `***a***`, `****` stay literal. Works inside words: `**B**ookmark`. |
| `_text_` | `<em>` | A single `_` at a word boundary: no letter, digit or `_` right before the opening `_` or right after the closing `_`. `snake_case_words`, `file_1_2`, `?a_b=c_d` in URLs, `____` (blanks) and `__init__` stay literal; `_snake_case_` → em "snake_case". |
| `==text==` | `<mark class="key">` | Exactly two `=` (author emphasis, not a user highlight). `a == b` and `===` stay literal. |
| `^text^` | `<sup>` | A single `^`. Content non-empty, **no whitespace**, text and arrows only (other markers inside are literal): `x^2^`, `1^st^`, `Na^+^`, `^99m^Tc`, `10^-3^`. `x^2 3^` stays literal. |
| `~text~` | `<sub>` | Same rules as sup: `CO~2~`, `P~a~O~2~`, `HCO~3~^-^`. `~5 mm to ~10 mm`, `5 ~ 10` and `~~a~~` stay literal. |
| `` `text` `` | `<code>` | A single backtick. Content is literal: no markup, no arrows (`` `->` `` shows `->`). Escapes still apply (`` \` `` is a backtick inside code). Double backticks stay literal. |
| `->` `<-` `<->` `=>` `<=>` | `→ ← ↔ ⇒ ⇔` | Arrow token, rendered as text with class `arrow`. Longest match first (`<->` is one ↔). |
| `→ ← ↔ ⇒ ⇔ ↑ ↓` typed directly | the same character | Arrow token too (class `arrow`). |
| `\*` `\_` `\=` `\^` `\~` `` \` `` `\\` `\-` `\<` `\>` | the character, literal | Works everywhere, inside code too. A backslash before any other character is kept (`C:\Data`, `\n`). |

Rules:
1. **Flanking.** An opening marker must be followed by a non-space and a closing marker
   preceded by a non-space (the start and end of the string count as space):
   `a ** b`, `x == y`, `5 ~ 10`, `` ` a` `` stay literal.
2. **Runs.** A marker is a run of exactly its length (`**`, `==`, or a single `_` `^` `~` or backtick);
   any other run of the same character is literal text.
3. **Precedence.** One left-to-right scan. Code, sup and sub spans are atomic: the first one to open
   is closed by the next valid marker of its kind, and nothing inside pairs with anything outside
   (`` **a `b** c` `` → `**a ` + code `b** c`). Then strong/em/mark pair like CommonMark: a closing
   marker pairs with the nearest open marker of its kind; markers opened in between that are still
   open become literal (`**a _b** c_` → strong `a _b` + ` c_`).
4. **Nesting.** strong, em and mark nest in each other in any order (same kind too), up to
   `MAX_NESTING` = 8 levels; deeper pairs render literally. sup/sub hold only text and arrows,
   code only text.
5. **No arrow** from a `-` or `=` inside a longer run (`-->`, `<--`, `<-->`, `==>` stay literal),
   from `<-` right before a digit (`<-5` means "less than −5"), or from an escaped character (`\->`).
6. Unclosed markers render literally. Adjacent text tokens are merged; no empty tokens or
   containers. Non-string input → `[]` / `''`.

Authoring tips: escape a marker character you mean literally when text nearby could pair with it
(`\_`, `\*`, `\~`). Two `~` inside one word make a subscript (`~5-~10` → sub "5-"), so write
`~5-\~10`. Write `->`, not `-->`.

API:
- `parseInline(text) → Token[]` (pure, fresh objects every call). Token = `{t:'text', v}` |
  `{t:'strong'|'em'|'mark'|'sup'|'sub'|'code', c: Token[]}` | `{t:'arrow', v}` (`v` = the arrow
  character). `code.c` is one text token; `sup.c`/`sub.c` hold only text and arrow tokens.
- `inlineToPlain(text) → string` (pure; the visible text exactly as rendered: markers removed,
  escapes resolved, arrows as their characters, whitespace kept; used for search, anchoring, GPT prompt).
- `MAX_NESTING` (8).

### 3.6 `data/retired.json`

`{ "retired": ["CH03-0007"] }`

## 4. Storage (IndexedDB)

Database `cardiac-mcq`, version `3` (v3 adds `books`, `bookfiles`, `pdfnotes`) (v2 adds `media`, owner request 2026-10-26: images in the scratchpad).
Only `store/repo.js` uses `store/db.js`.

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
| `media` | `id` | `qid`, `ts` | `{id, qid, blob, mime, width, height, bytes, ts}` — images the user adds (scratchpad), already downscaled |

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

Scratchpad record (ink store, `block: 'scratch'`, id `${qid}|scratch`) — v2 adds `scene`; a v1 record
(only `strokes`, fractions of 2000×3000) is converted to a scene on first open and saved back:
```js
{ id, qid, block: 'scratch', qversion, updated, strokes: [] /* legacy */,
  scene: { v: 2, page: { w: 2000, h: 3000, bg: 'plain'|'dots'|'grid'|'lines' }, items: Item[] /* z-order */ } }
// Item (page units, rounded to 1 decimal; ids from util.uid()):
//  { id, type: 'stroke', tool: 'pen'|'hl', color, size /* page units */, pts: [x, y, p, ...] }
//  { id, type: 'image', media /* media.id */, x, y, w, h, rot /* radians */ }
//  { id, type: 'text', x, y, w, text, color, size /* font px in page units */ }
//  { id, type: 'shape', shape: 'line'|'arrow'|'rect'|'ellipse', x1, y1, x2, y2, color, size, fill: false }
```

Stroke (all coordinates are fractions of the layer's width/height, rounded to 4 decimals):
```js
{ tool: 'pen' | 'hl', color: '#rrggbb', size: number /* fraction of width */,
  pts: number[] /* flat [x, y, pressure, x, y, pressure, ...] */ }
```

### 4.1 `store/db.js`

```js
export const DB_NAME = 'cardiac-mcq';
export const DB_VERSION = 4;  // v1 initial; v2 adds `media` (qid, ts); v3 adds `books`, `bookfiles`, `pdfnotes`; v4 adds `wholebook` (§7.17.1) — additive only
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
export const mediaRepo     = { get(id), byQid(qid), add({qid, blob, mime, width, height}) /* assigns id, ts, bytes */,
                               remove(id), prune(qid, keepIds /* Set|string[] */) /* removes the qid's media not kept */, all() }
export const ALL_STORES    = ['settings','qstate','attempts','notes','highlights','ink','voice','reports','reviews','sessions','media']
// inkRepo.set(qid, block, {qversion, strokes?, scene?}) keeps a record while it has strokes OR scene items
//   (deletes only when both are empty). mediaRepo.add throws TypeError (bad input) / RangeError (> MEDIA_MAX_BYTES,
//   25 MB); mediaRepo.prune → removed ids. Pure helpers: MEDIA_MAX_BYTES, checkMediaInput, inkHasContent, importable.
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
export const DISCONNECT_GRACE_MS = 500
export function onDisconnect(el, fn, { graceMs = DISCONNECT_GRACE_MS, onDetach } = {}) → off()
// fn runs once after el was attached and then stays detached for graceMs (quick moves don't count);
// onDetach runs at once on every detach; one shared MutationObserver; no-op without a DOM.
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
| `/book` | book | The book: parts → chapters → sections; import PDFs (§7.17) |
| `/book/:id` | reader | PDF reader/editor for one chapter (`?page=`) (§7.17) |

### 5.5 `core/settings.js`
Defaults:
```js
{ theme: 'system' /* 'light'|'dark' */, fontScale: 1 /* 0.85–1.5 */, reduceMotion: 'system',
  shuffleChoices: true, defaultCount: 20, examSecondsPerQuestion: 90,
  autoAdvance: false, showTimer: true, drawInput: 'auto' /* 'finger'|'pen' */,
  highlightColor: 'yellow', inkTool: 'pen', inkColor: '#1d4ed8', inkSize: 0.006,
  reviewerMode: false, tourDone: false, askGptNoticeSeen: false, lastRoute: null,
  ttsRate: 1 /* 0.8–1.4 */, ttsVoice: null /* voiceURI */,
  scratchView: 'over' /* 'over'|'split'|'full' */, scratchTool: 'pen', scratchColor: '#1d4ed8', scratchSize: 1 /* 0|1|2 */,
  scratchBg: 'dots', scratchOpacity: 0 /* paper opacity in 'over' view, 0–0.9 */,
  bookLast: null /* 'chNN' */, bookTool: 'pen', bookColor: '#1d4ed8', bookSize: 1 /* 0–2 */, bookHlColor: 'yellow' }
// settings.js exports SCRATCH_TOOLS = ['select','lasso','pen','hl','eraser','shape','line','arrow','rect','ellipse','text','hand']
```
```js
export async function initSettings()     // loads from settingsRepo, applies
export function getSetting(key)          // sync, after init
export async function setSetting(key, value) // persists, applies, emits settings:change
export function applySettings()          // <html data-theme="light|dark" data-reduce-motion="true|false" style="--font-scale">
```

### 5.6 `core/data.js`
```js
// Part    = { id, number /* "I" */, title, volume, chapters: string[] /* visible chapter ids, in order */ }
// Chapter = { id, number, part, prefix, title, short, file, page, published, count, order /* = number */, demo: false }
// Demo    = { id: 'demo', number: null, part: null, prefix: 'DEMO', title, short, file, page: null,
//             published: true, count, order /* after every chapter */, demo: true }
export const DEMO_ID = 'demo'
export async function loadIndex({ includeUnpublished = false } = {})
  → { schemaVersion, parts: Part[], chapters: Chapter[], demo: Demo | null, demoMode: boolean }
  // chapters: published only, sorted by number (all 55 with includeUnpublished — dev tools only)
  // parts: only parts with ≥1 listed chapter, in order; demoMode: no chapter is published
  // demo: null only when the index's "demo" entry is missing or invalid (warning, index still loads)
  // fresh wrapper, arrays and part objects on every call; chapter/demo objects are shared (read-only)
  // the dev option counts only when it is exactly `true`
export async function studyChapters() → (Chapter | Demo)[] // published chapters, or [demo] in demo mode
                                                    // ([] when nothing is published and the demo is missing)
export async function getChapter(id) → Chapter | Demo | null   // null for unknown or unpublished
export async function loadChapter(id, { includeUnpublished = false } = {}) → { chapter, questions: Question[] }
                                                    // memoized; demo allowed; unknown or unpublished
                                                    // (without the dev option) → DataError 'unknown-chapter'
export async function loadAll({ includeDemo = true } = {}) → Question[]   // published chapters (+ demo)
export async function loadStudyBank() → Question[]  // questions of studyChapters()
export async function getQuestion(qid) → Question | null      // finds chapter by prefix; null when unpublished
export async function getQuestions(qids) → Question[]          // keeps order, skips missing/unpublished
export function chapterIdFromQid(qid) → string | null          // after loadIndex(); published + demo only
export function questionPlainText(q) → string                  // stem + choices + notes + explanation (plain)
export function blockPlainText(block) → string
export function clearDataCache()
export class DataError extends Error                          // .code, .userMessage (plain language)
```
Each returned Question gets the extra field `chapterId`. Fetch failures throw
`DataError` with a user-friendly message. Unpublished chapter files are never
fetched by the app (they are not precached either). Malformed part, chapter
and demo entries and malformed questions are skipped with a console warning;
only an unusable index shape (no `parts`/`chapters` arrays, bad `schemaVersion`,
nothing to study at all) throws `DataError` `'schema'`/`'version'`.

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
- `export function checkForUpdate({ timeoutMs = 8000 } = {}) → Promise<'update-ready'|'downloading'|'up-to-date'|'offline'|'unsupported'|'error'>`
  (Settings > About; never throws; bypasses the 30-min throttle; waits up to `timeoutMs` for an installing
  worker; `'downloading'` = still installing after the timeout, the banner follows by itself;
  `'update-ready'` re-emits `sw:update-ready`).

### 5.8 `sw.js`
- `const VERSION = 'YYYY.MM.DD-N';` cache `cmcq-shell-${VERSION}` (app files) and
  `cmcq-data-${VERSION}` (question data + images).
- `APP_SHELL` = explicit list of every file the app needs (`./`, `index.html`,
  manifest, all css, all js, icons). `scripts/validate.mjs` checks the list is complete.
- `install`: precache APP_SHELL, then fetch `data/index.json`, `data/retired.json`,
  the `file` of every chapter with `"published": true` and `demo.file` (all must be
  valid JSON), then the images those files use (best effort); the index is stored last.
  Unpublished chapter files are never fetched. A malformed index (non-object entry,
  missing or unsafe `file`, missing `demo`) fails the install. **No automatic skipWaiting.**
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
Brand ("Cardiac OR" identity, session 5): arterial crimson `--primary` `#a6192e` (light) / `#ff5a70` (dark);
venous navy hero surfaces `--venous --venous-2 --hero-grad` with `--on-venous --on-venous-2` text; ECG trace `--ecg`
(crimson-pink light, monitor green dark); scrub teal accent `--teal --teal-soft --teal-contrast`; `--brand-grad`;
chart colours `--chart-1 --chart-2 --chart-track` (single-series charts use `--chart-1`; retune the pair
with the dataviz validator before any two-series chart — teal chroma is low in light mode). Steel-cool neutrals. Fonts: `--font-sans` = Inter (body/UI),
`--font-display` = Manrope (headings, `.num-display` numbers). `base.css` provides `.num-display` and the decorative
`.ecg-line` (+ `.ecg-line--sweep`, still with reduced motion). Brand classes in `shell.css`: `.brand-badge`,
`.brand-mark` (`--full`), `.wordmark-accent` (the crimson "Klin" of the KirKlin wordmark). All text pairs ≥ 4.5:1 in both themes.
Theme: `<html data-theme="light|dark">`.

Breakpoints: phone `< 700px` (bottom tab bar), tablet `≥ 700px` (side rail),
wide `≥ 1000px` (player shows question and explanation side by side).

### 6.2 `ui/icons.js`
`export function icon(name, { size = 20, label } = {}) → SVGElement` (stroke icons, `currentColor`,
`aria-hidden="true"` unless `label`). Names: `home library stats search settings bookmark
bookmark-filled flag pen highlighter eraser undo redo mic stop play pause trash chevron-left
chevron-right chevron-down close check x clock share download upload sparkles list grid info
alert refresh moon sun text-size note image more target flame layers lasso zoom-in zoom-out
hand eye eye-off filter shuffle timer star volume`.

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
emptyState({ icon, title, text, action /* Node */ }) → HTMLElement   // badge with a decorative ECG trace
progressBar(value /* 0..100 */, { label }) → HTMLElement
ring(value, { size = 48, label }) → SVG-based HTMLElement
chip(label, { kind /* neutral|success|danger|warning|info|primary|teal */, icon }) → HTMLElement
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
`index.html` contains: `<header id="app-header">`, `<nav id="tabbar">` (Home, Library, Book,
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
`'all'` chapters = `studyChapters()` (published chapters, or the demo in demo mode). `includeDemo`
adds the demo outside demo mode (dev/tests only; it never widens an explicit list). Explicit ids are
limited to published chapters + demo; unknown and unpublished ids are ignored (their files are never
fetched). Questions come in bank order (published chapters by number, then the demo) before `order`/`count` apply.

### 7.3 `features/quiz/engine.js`
Session:
```js
{ id, title, mode: 'tutor' | 'exam', createdAt, updatedAt, finishedAt: null,
  graded: false,                                       // answers are in qstate/attempts (tutor: at finish; exam: after grading)
  qids: [], choiceOrder: { [qid]: choiceId[] }, index: 0,
  answers: { [qid]: { choice, correct, ms, at } },   // tutor: locked once answered; exam: changeable until finish
  struck: { [qid]: choiceId[] }, marked: { [qid]: true },
  timeLimitMs: null | number, elapsedMs: 0, perQuestionMs: { [qid]: number },
  options: { shuffleChoices, chapters, filter, secondsPerQuestion } }
```
Constants: `MODES`, `DEFAULT_SECONDS_PER_QUESTION` (90), `SAVE_DELAY_MS` (300), `DEFAULT_TITLES`
(`Practice` / `Exam`), `class SessionError` (`.code` `'empty'|'invalid'`, `.userMessage`).

Pure reducers (no I/O, never mutate; return `s` itself when nothing changes):
- `createSessionObject(opts, questions, now, seed)` — opts `{ title, mode = 'tutor', shuffleChoices = true,
  secondsPerQuestion = 90, chapters = 'all', filter = 'all' }`. `qids` = question ids in the given order
  (duplicates/malformed skipped). `choiceOrder[qid]` = choice ids shuffled with
  `seededRandom(hashString(seed + '|' + qid))` (seed defaults to the new session id), or file order without
  shuffle. `timeLimitMs` = exam ? `secondsPerQuestion × 1000 × qids.length` : null. Unknown mode → RangeError.
- `applyAnswer(s, qid, choice, correct, ms, now)` — ignored when locked (see `isAnswerLocked`), for an unknown
  question or choice, or when an exam answer is re-tapped unchanged. Choosing a struck choice removes its strike.
- `toggleStrike(s, qid, choice)` (ignored when locked), `toggleMark(s, qid)` (ignored after finish),
  `goTo(s, index)` (truncated + clamped; NaN ignored; allowed after finish),
  `addTime(s, qid, ms)` (adds to `perQuestionMs[qid]` and `elapsedMs`; ignores ≤0/NaN/∞, unknown qid, finished),
  `finishSession(s, now)` (idempotent).
- `summarize(s, questions)` → `{ total, answered, correct, incorrect, unanswered, pct, timeMs, avgMs,
  byChapter: [{chapterId, total, answered, correct, pct}] /* by id, unknown (null) last */,
  byTopic: [{topic, total, answered, correct, pct}] /* by name */,
  items: [{qid, status: 'correct'|'incorrect'|'unanswered', choice, ms, marked}] /* session order */ }`.
  Tutor uses the recorded correctness; exam re-checks `choice === question.answer` (recorded value when the
  question is missing). `pct = util.pct(correct, total)`; `timeMs = elapsedMs` (sum of answer times when no time
  was tracked); `avgMs = timeMs / answered`. Missing question → chapter from the id prefix (`CH03-…` → `ch03`).

Pure helpers: `isAnswerLocked(s, qid)` (tutor: answered → locked; exam: only after finish; unknown qid → locked),
`remainingMs(s)` (null without a limit, never negative), `isTimeUp(s)`, `answeredCount(s)`, `unansweredCount(s)`,
`firstUnansweredIndex(s, from = 0)` (wraps; −1 when none), `currentQid(s)`, `answerOf(s, qid)`, `isFinished(s)`,
`isCorrectChoice(question, choice)`, `choiceOrderFor(s, question)` (stored order, robust to edited choices — the
player renders choices with this), `nextQState(prev, {qid, choice, correct, ms, ts})` (seen/correct/incorrect/
totalMs/last*/srs), `mergeForWrite(stored, incoming, now)`, `repairSession(raw)` (→ clean session or null).

Async API (repo.js / data.js imported lazily):
- `createSession({ qids, title, mode, shuffleChoices, secondsPerQuestion, chapters, filter, seed? })` → loads
  `data.getQuestions(qids)` (order kept, missing dropped), stores immediately; none left → `SessionError('empty')`.
- `loadSession(id)` → repaired session | null (writes a pending save of it first).
- `saveSession(s)` → debounced 300 ms per id (latest snapshot wins); the promise resolves when stored (null if
  deleted meanwhile) and rejects with `StorageError` (also logged). `flushSessions()` writes all pending saves now;
  it runs automatically on `visibilitychange` → hidden and `pagehide` (log only there).
- `recordAnswer(s, question, choice, ms)` → `{ session, correct, applied }`. The session is written **immediately**
  (answers are never debounced). Tutor: also qstate (+srs via `nextSrs`) and one attempt
  `{qid, choice, correct, ms, ts, mode, sessionId}`, then `qstate:change` `{qid}`. Exam: session only.
  `applied: false` (session unchanged) when the answer was ignored.
  Tutor: if the stored session already holds an answer for the question, or is finished, nothing is written
  (`applied: false` + the stored session). Exam: an answer on a stored finished session is not kept (`applied: false`).
- `completeSession(s, questions?)` → finished session, stored immediately. Exam: stores "finished" first, then
  grades every answered question (against `questions`, else the recorded correctness): one attempt + qstate/srs each,
  `qstate:change` per graded qid, then `graded: true`. Idempotent: concurrent calls share one run, a finished+graded
  session returns as is, and a question already having an attempt with this `sessionId` is skipped (safe retry after
  a failure). Unanswered questions create no attempt. Tutor: just finishes (`graded: true`).
- `deleteSession(id)` (drops a pending save; later saves of that id are ignored), `restoreSession(s)` (Undo),
  `latestUnfinished()` (after flushing), `toggleBookmark(qid)` → new state, emits `qstate:change`.
- Write safety: writes per session are serialized; a stored finished session is never replaced by an unfinished
  snapshot, its first `finishedAt` is kept and `graded` never goes back to false. A stored tutor answer is never
  dropped or changed by a stale snapshot (`mergeForWrite` keeps stored tutor answers).
- Storage failures propagate as the repo's `StorageError`. `setTestBackend({repo, data} | null)` is a unit-test seam.

### 7.4 `features/stats.js`
```js
export async function computeStats(now = Date.now()) → Stats   // loads data + repo lazily, then aggregateStats()
export function aggregateStats({ chapters, questions, states, attempts, notes, voice, highlights, now, demoMode }) → Stats // pure
export const DAILY_DAYS = 30, WEAK_TOPIC_MIN_ATTEMPTS = 3, WEAK_TOPIC_LIMIT = 8
export function setTestBackend({ data, repo } | null)        // unit-test seam
// Stats = { totalQuestions, answeredUnique, attempts, correctPct, avgMs, dueCount, bookmarks, notes, voice,
//   highlights, byChapter: [{id, title, short, total, answered, correct, pct}],
//   weakTopics: [{topic, chapterId, n, correct, pct}], daily: [{day, n, correct}], streak, bestStreak, demoMode }
```
- Over `studyChapters()` + `loadStudyBank()` (so the demo counts only in demo mode); `demoMode` comes from
  `loadIndex()`. Only records whose `qid` is in the study bank count (qstate, attempts, notes, voice, highlights).
  Voice records are reduced to their `qid` at once (no audio kept in memory). Failures reject with the
  data module's `DataError` or the repo's `StorageError`.
- `totalQuestions` = study questions; `answeredUnique` = questions with `seen > 0`; `attempts` = attempt count;
  `correctPct = pct(right attempts, attempts)`; `avgMs` = mean `ms` of attempts with a valid time (rounded, 0 when
  none); `dueCount` = study questions with `isDue(srs, now)`; `notes` = questions with a non-blank note.
- `byChapter`: one row per study chapter in order; `total` = its loaded questions, `answered` = `seen > 0`,
  `correct` = answered with `lastCorrect === true`, `pct = pct(correct, answered)`; `short` falls back to the title.
- `weakTopics`: per (chapterId, topic) over attempts (questions without a topic skipped), `n ≥ 3`; sorted by exact
  ratio `correct / n` ascending, then larger `n`, then chapter order, then topic name; max 8. Topics at 100% can
  appear (the screen decides how to label them).
- `daily`: the last 30 **local** days (`util.dayKey`), oldest first, today last, zero days included (DST-safe).
- `streak`: consecutive local days with ≥ 1 attempt ending today, or yesterday when nothing was answered yet today;
  else 0. `bestStreak`: the longest run ever (≥ `streak`).

### 7.5 `features/search.js`
```js
export async function search(query, { limit = 50 } = {}) → [{ qid, chapterId, title /* plain stem start, ≤ 90 chars + "…" */,
                                                           snippet: [{text, match}], score }]
export async function prepareSearchIndex()   // builds the index ahead (Search screen on open); rejects like search()
export function clearSearchIndex()           // forget the memoized index; the next search rebuilds it
export function tokenize(text) → string[]                                   // pure
export function buildIndex(questions) → SearchIndex                         // pure
export function queryIndex(index, query, { limit = 50 } = {}) → [{ qid, chapterId, score, pos }]   // pure
export function makeSnippet(text, terms, maxLen = 160) → [{ text, match }]  // pure
export const FIELD_WEIGHTS, MAX_COUNTED_REPEATS, PHRASE_BONUS, DEFAULT_LIMIT, MAX_QUERY_TERMS, SNIPPET_LENGTH, TITLE_LENGTH
export function setTestBackend({ data } | null)                              // unit-test seam
```
- Over `loadStudyBank()` (= `studyChapters()`: the demo is searchable only in demo mode). Empty/blank query → `[]`
  without loading anything. The index is memoized and rebuilt when the study chapters or their counts change
  (key = study chapter ids + counts) or after `clearSearchIndex()`. The build runs in ~12 ms slices that yield
  to the page. Load failures reject with `DataError`; a failed build is forgotten (next call retries).
- Tokens: text folded (lowercase, accents removed, NFKD forms, Greek letters spelled out: "β" → "beta"); runs of
  Unicode letters/digits; punctuation, arrows and inline markup characters separate tokens; 1-character tokens
  dropped except digits; a hyphenated word gives its parts + the joined form ("kilo-lima" → kilo, lima, kilolima).
- Query: AND of all terms; the **last** term also matches as a prefix (also with a trailing space); a hyphenated
  query word matches its joined form or all its parts (scored alike); at most 16 terms.
- Score = Σ terms Σ fields (weight × min(repeats, 3)) with weights stem 8, topic 8, tags 8, choices 4, choice notes 1,
  explanation 1 (a stem hit always outranks explanation-only hits); +12 when a multi-word query is an exact phrase
  in the stem (last word as prefix). Ties keep bank order.
- Snippet: around the first match in the question's plain text (stem · choices · notes · explanation · topic · tags),
  cut at word boundaries with "…" where text was left out; every word-start match in the cut is a `match: true`
  segment (folded matching, original characters shown).
- Performance (5000 rich questions, ~15 MB): build < 1.5 s, query < 30 ms (asserted in `tests/unit/search.test.mjs`).

### 7.6 `features/explain/render.js`
```js
export function renderInline(text) → DocumentFragment
export function renderBlocks(blocks, { qid }) → HTMLElement  // <div class="explain">, each block element has
                                                          //   data-block="<id>" and class "xb xb-<type>"
export function renderStem(q) → HTMLElement               // data-block="stem"
export function renderImage(img) → HTMLElement            // lazy, tap to zoom
export function isSafeImageSrc(src) → boolean             // pure: relative data/ image paths only
export const CALLOUT_KINDS                                // ['key','pearl','pitfall','mnemonic']
```
- Tables: horizontally scrollable wrapper, sticky first column on phones, zebra rows, optional emphasis.
- Flow: vertical chain of rounded step boxes joined by arrows (HTML/CSS + inline SVG arrow),
  arrow labels, branch rows side by side (stack on narrow screens).
- Mind map: central node with branches and leaf chips, HTML/CSS (two columns on wide,
  stacked on phone) with connector lines drawn by CSS. Text stays real, selectable text.
- Callouts: icon + color per kind (key=primary, pearl=teal, pitfall=danger, mnemonic=warning).
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
**`[data-block]` rule (renderers ↔ annotations):** a `[data-block]` element contains only content
text. UI chrome that must sit inside it (letter badges, strike buttons, ink canvases) carries
`data-anchor-skip` (canvases are skipped by tag too), and anchoring/highlighting ignores those subtrees.
Choices use `data-block="choice-<id>"` on the choice *text* element; choice notes `data-block="note-<id>"`.
Choice text inside a `<button>` needs `user-select: text` so long-press can select it.

`annotate/highlight.js`:
```js
export function initHighlights(root, question, { onOrphans }) → { destroy(), refresh() }
export async function highlightSelection(color?) → Promise<boolean> // highlight the current selection (bottom-bar button); false = no selection
export const HIGHLIGHT_COLORS                                        // ['yellow','green','blue','pink']
export function blockExists(question, block), trimSpan(text, start, end)   // pure helpers (anchor.js)
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
// InkController also: getState() → {tool,color,size,enabled}, isEmpty(), staleBlocks(), flush() → Promise,
//   refresh(), ready (Promise); clearAll() → undo token | null; undo(token?); disable()/destroy() → save Promise.
// Events (on() returns off): change {canUndo,canRedo,empty}, tool, enable, strokestart {block},
//   stale {blocks} (replayed to late subscribers), ready, saved {blocks}, error {error}, destroy.
// renderStrokes(ctx, strokes, w, h, dpr, opts?) opts = {clear, dark, zoom, panX, panY, hlBlend, live}.
// Extra exports: createInkEngine, INK_COLORS (6), INK_SIZES [0.003,0.006,0.012], INK_TOOLS, SCRATCH_BLOCK, SAVE_DELAY_MS, …
```
- Stale ink (stroke saved for another `qversion`) is still shown; the player shows a calm notice on `stale`.
  Editing a stale block saves it with the current version. `inkSize` is a fraction of the question root's
  width; each stroke stores it relative to its own layer. Dark mode draws palette colours with a lighter twin.
- `openScratchpad(question)` returns `{close, controller}`. The toolbar hides Scratchpad when `onScratchpad` is absent.
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
"Saved" indicator), character count hidden until 1000+. The element also has `flush()` and `destroy()`.

### 7.9 `features/voice.js`
```js
export function isVoiceSupported() → boolean
export function createRecorder() → { start(): Promise, stop(): Promise<{blob, mime, durationMs}>, cancel(), state, onLevel(fn) }
export function createVoiceNotes(qid) → HTMLElement   // + destroy()
export class VoiceError extends Error                 // .code: denied|no-mic|busy|unsupported|insecure|empty|aborted
// createRecorder({ maxMs, onAutoStop }?) also exposes elapsedMs. Undo of a delete restores via mergeStore (same id/ts).
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
blocked, copies the prompt and shows a toast with an "Open ChatGPT" link. Because `noopener` cannot report a blocked
pop-up, every open copies the prompt first and shows that toast. Disabled with a hint while offline.

### 7.11 `features/review.js`
```js
export const REPORT_REASONS = ['Wrong answer', 'Unclear question', 'Typo or formatting', 'Explanation problem', 'Other']
export function openReportSheet(question)               // reason + optional text → reportsRepo
export function createReviewerPanel(question) → HTMLElement   // reviewer mode: Approve / Needs fix + comment
export async function exportReviewFile() → { blob, filename }  // reviews + reports JSON
export function unreviewedBadge(question) → HTMLElement | null  // chip "Not yet reviewed" when reviewed === false AND
                                                                // reviewerMode is on (owner: learners never see it); the
                                                                // builder shows the 'unreviewed' filter only in reviewer mode
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
stores: { [storeName]: records[] } }` — voice and media blobs as `{..., blob: null, data: base64, mime}`; without
media the `voice` and `media` stores are omitted (scratchpad images then show a calm "image not in this backup" placeholder). Merge: per store, newer `updated/ts` wins; attempts deduplicated by `(qid, ts)`.
Replace: clears every store first (after the user confirms), except a media store (`voice`, `media`, each on its own)
that the backup lacks. `includesMedia` = either media store present. `importBackup` result adds `keptMedia`.
Extra exports: `MEDIA_STORES`, `decodeMediaRecord`, `mediaKeptText(hasVoice, hasImages)`. Import never touches settings `lastRoute`.
Replace with a backup that has no media keeps the device's voice notes (recordings can't be recovered).
Everything is validated and decoded before any write; Replace snapshots each store and restores it if a write fails.
Extra API: `openImportDialog(file) → Promise<result|null>` (summary sheet, Merge (default) / Replace everything);
`exportBackup` also returns `counts`, `skipped`; `saveFile → 'shared'|'downloaded'|'cancelled'`; `readBackupFile`
summary also has `total, exportedAtMs, formatVersion, ignoredStores`; `importBackup → {mode, stores, added, updated,
skipped, keptVoice}`; `BackupError` (`.code`, `.userMessage`). `openReportSheet → {close}`; `exportReviewFile` also returns `counts`.

### 7.13 Shared modules for screens (wave 2)

`features/quiz/start.js` — one place that starts a quiz (home quick actions, chapter, builder, results
"Retry mistakes", settings "Try the demo").
```js
export class NoQuestionsError extends Error   // .userMessage: plain language ("No questions match. Try another filter.")
export async function startQuiz({ chapters = 'all', filter = 'all', count /* default: setting defaultCount */,
  mode = 'tutor', order = 'random', title /* default built from mode + chapters + filter */, qids /* optional explicit list */ })
  → Promise<string>   // new session id; reads shuffleChoices / defaultCount / examSecondsPerQuestion from settings
export function sessionTitle({ mode, chapters, filter, chapterTitles }) → string   // e.g. "Practice · Mitral valve · Mistakes"
```
The caller navigates to `/quiz/<id>`; `NoQuestionsError` → toast with the message (never a dead end).

`features/lists.js` — the question lists shared by Library, the Question browse screen (prev/next) and Results.
```js
export const LIST_KINDS = ['bookmarks', 'notes', 'voice', 'highlights', 'flagged', 'session', 'chapter', 'search', 'mistakes']
export async function getList(key) → { key, title, qids: string[] }
// key: 'bookmarks' | 'notes' | 'voice' | 'highlights' | 'flagged' | 'mistakes' | 'session:<id>' |
//      'chapter:<id>' | 'search:<encodeURIComponent(q)>'; only questions of studyChapters() (plus the session's own qids)
export function listHref(qid, key) → string   // '#/q/<qid>?list=<encoded key>' (relative hash link)
```

`features/question-view.js` — renders one question in every state; used by the Player, the Question
browse screen and the Results review. Owns choices, feedback, explanation section, "Your notes" section
(text note + voice notes), Ask GPT, report, reviewer panel, highlights and ink layers.
```js
export function createQuestionView(question, {
  mode,          // 'tutor' | 'exam' | 'browse'
  choiceOrder,   // choice ids in display order (letters A–E assigned in this order)
  selected,      // chosen choice id | null
  struck,        // choice ids struck through
  revealed,      // true → show correct/incorrect state + explanation
  onChoose,      // (choiceId) => void
  onStrike,      // (choiceId) => void
}) → { el, update(partialState), setDrawing(on), isDrawing(), focusFirstChoice(), destroy() }
```
- Heavy tools are loaded with dynamic `import()` the first time they are needed (ink, toolbar,
  scratchpad, voice, Ask GPT, reviewer panel) so the first load stays small; if one fails to load,
  only that tool shows a plain-language toast ("This tool couldn't load. Reload the app.").
- Highlights load right after the question renders (saved highlights must appear without a tap).
- Extra exports: `LETTERS`, `TOOL_LOAD_ERROR`, `letterFor(order, id)`, `loadTool(name, loader)`,
  `createBookmarkButton(qid)` (→ button with `toggle()`, `destroy()`), `openNotesSheet(question, {focus})`,
  `openQuestionMenu(view, question, {extra})`. Extra option `onDrawingChange(on)`. Extra view methods:
  `getState`, `openNotes`, `openScratchpad`, `canAskGpt`, `askGpt`, `listen`, `stopAudio`, `report`;
  `setDrawing` returns a Promise of the new state. `review.js` is imported statically (small; needed for the chip).
- Keys: 1–5 / A–E choose; while unanswered B/D choose, after answering B bookmarks and D draws
  (Shift+B / Shift+D always); M mark, G navigator, H highlight, ? shortcuts sheet.
- A tap that ends a text selection never answers; a plain tap on a highlight inside a choice still
  chooses it (so heavily highlighted choices stay easy to tap). Long-press strikes until answered,
  then selects text.

### 7.14 CSS ownership
| file | owner module(s) |
|---|---|
| `css/explanation.css` | explain/render.js |
| `css/annotate.css` | annotate/anchor.js, annotate/highlight.js |
| `css/ink.css` | annotate/ink.js, annotate/ink-toolbar.js, annotate/scratchpad.js |
| `css/features.css` | notes.js, voice.js, askgpt.js, tts.js |
| `css/review.css` | review.js, backup.js (report sheet, reviewer panel, import dialog) |
| `css/screen-player.css` | question-view.js, screens player/results/question |
| `css/screen-home.css` | screens home/chapter/builder/library |
| `css/screen-misc.css` | screens stats/search/settings/reviewer |

### 7.15 `features/tts.js` — Read aloud (owner approved 2026-10-26)
Device voices only (Web Speech API `speechSynthesis`): free, offline, no key, no server.
```js
export function isTtsSupported() → boolean
export function pickBestVoice(voices /* SpeechSynthesisVoice[] */, { preferredURI } = {}) → voice | null  // pure
  // English only; ranking: user's saved voice → name/URI contains Premium > Enhanced > Neural/Natural >
  // Google/Siri/Samantha-class quality voices > localService en-US/en-GB > any en-*; never non-English
export function questionSpeechText(question, { choiceOrder, includeExplanation = false }) → string[]  // pure
  // ordered utterance chunks: stem, then "A. …", "B. …" in display order, then (optional) the correct
  // answer line and the explanation blocks as plain text (arrows read as words: "→" → "leads to")
export function createReader() → { speak(chunks), pause(), resume(), stop(), state /* idle|speaking|paused */,
  on(event /* 'state'|'chunk' */, fn) }   // chunked to avoid the iOS/Chrome long-utterance cut-off
export function createListenButton(question, getContext /* () => {choiceOrder, revealed} */) → HTMLElement // + stop(), destroy()
export async function listEnglishVoices() → voice[]   // English device voices, best first (waits ≤ 2 s for late voices)
export async function previewVoice(voice | null, rate?) // speaks a short sample, stops anything else speaking
// createReader().speak(chunks, { voice?, rate? }?) defaults to ttsVoice/ttsRate; on('error', {message}) too.
```
- Settings: `ttsRate` (0.8–1.4, default 1), `ttsVoice` (voiceURI | null). Settings > Read aloud shows the
  voice picker (English voices only, best first, "Preview"), speed, and the tip: iPhone/iPad: Settings >
  Accessibility > Spoken Content > Voices > English > pick one marked "Premium" or "Enhanced" and download it;
  Android: Settings > Accessibility > Text-to-speech > Google > install voice data (English, high quality).
- Stops when the question changes, the screen changes, or the app goes to the background.
- Hidden when `speechSynthesis` is missing. Never sends text anywhere.

### 7.16 Scratchpad v2 (owner request 2026-10-26)
A professional, note-taking-grade workspace per question that opens **over the question with one tap**
(a visible "Scratchpad" button in the player and browse bottom bars, plus the More menu and the ink toolbar).
```js
// features/annotate/scratchpad.js (entry, unchanged name)
export function openScratchpad(question, { view } = {}) → Promise<void>   // resolves when closed (saved)
// features/scratch/scene.js (pure)   — model, commands, undo/redo, serialize, migrateV1(strokes)
// features/scratch/geometry.js (pure) — bounds, hit tests, transforms, snapping
// features/scratch/render.js         — canvas renderer (cached scene layer + live layer; reuses ink strokeToPath)
// features/scratch/tools.js          — pointer tools: select (move/resize/rotate), lasso, pen, highlighter,
//                                      eraser (whole stroke), shapes, text, hand/pan
// features/scratch/media.js          — image import (file/camera/paste/drop), EXIF-aware decode, downscale to
//                                      ≤ 2048 px long side (JPEG/WebP ~0.85; PNG kept when transparent), mediaRepo
```
- **Views** (setting `scratchView`, remembered): `over` (default — transparent layer on top of the question, the
  question stays visible beneath; a paper-opacity control), `split` (read-only question copy on top, pad below,
  draggable divider; side by side on wide screens), `full` (opaque paper with template `page.bg`).
- **Tools**: select (tap → handles: move, 8-point resize (images keep aspect unless a free-resize toggle), rotate,
  Delete, Duplicate, Front/Back), lasso (strokes/items → move/delete/recolor), pen (pressure), highlighter, eraser,
  shapes (line, arrow, rectangle, ellipse), text box, image (Photos/Camera/Files, paste, drop), hand. Draw on
  top of images (z-order). 8 colours, 3 sizes; last tool/colour/size remembered (`scratchTool`, `scratchColor`,
  `scratchSize`). Undo/redo (every command), Clear page (undoable), Export as PNG (share/download).
- **Canvas**: page 2000×3000 units; default zoom **fit width**; pinch zoom 0.25–5×, two-finger pan, wheel/ctrl-zoom,
  buttons (−, %, +, Fit). Palm rejection + `drawInput` as in §7.7. 60 fps via rAF; DPR-aware; bitmap cache for images.
- Autosave (debounced 400 ms + on close/pagehide/hidden) to `inkRepo` (`scene`) and `mediaRepo`; on close,
  `mediaRepo.prune(qid, referenced ids)` (after undo history is gone). Missing media → placeholder box.
- Keyboard: V select, P pen, H highlighter, E eraser, S shapes, T text, I image, Space/hand, Ctrl/Cmd+Z / Shift+Z / Y,
  Delete/Backspace, Esc (deselect → close). Every gesture has a visible button.
- As built (session 5): `openScratchpad(question, {view, choiceOrder})` → Promise (resolves on close, has `.close()`);
  100% zoom = fit width (range 25–500% of fit). "Over question" = transparent sheet over the real screen (the
  question is visible, not interactive). Select doubles as lasso (drag on empty paper); double-tap text to edit;
  pan = two fingers / wheel / Space+drag (one finger when pen-only). Eraser removes strokes and shapes, never
  images or text. Pinch starting on a selected image scales/rotates it. Images re-encoded WebP (JPEG fallback)
  0.85, PNG kept when transparent. Failed save keeps the scene in memory + Retry toast; unused media pruned only
  after a successful save on close. Bottom-bar button class `pbar-scratch`. Module exports are listed in each file's
  JSDoc. Gaps: text boxes don't rotate; no fill button for shapes.

### 7.17 Book tab + PDF reader/editor (owner request 2026-10-28)
A sixth tab **Book** (route `/book`) lists the owner's book: parts → chapters (from `data/index.json`, **all 55**,
whether their questions are published or not) → sub-chapters (sections, from `data/book.json` and the PDF outline).
Tapping a chapter opens **the original PDF** in a high-performance reader/editor (route `/book/:chapterId?page=N`).

**Where the PDFs come from.** The repo is public, so the owner's PDFs are **not** committed unless the owner
explicitly says so (CLAUDE.md "Sources"). The user imports PDFs **on the device** (file picker, several at once):
files are matched to chapters by name (`Chapter-01-…`, `Chapter 1`, `ch01`, `01 …`), unmatched files ask which
chapter; stored in IndexedDB (`books`), so they open offline. Optional bundled PDFs: `data/book.json` may list a
`file` per chapter (relative path) — used only if present; none are bundled now.

`data/book.json` (dev-maintained, validated): `{ schemaVersion: 1, chapters: { ch01: { firstPage: 1, sections:
[{ title, page /* book page */, level: 1|2 }], file?: "books/ch01.pdf" } } }` — PDF page index = book page − firstPage + 1.

Storage (DB version 3, additive migration; v4 adds `wholebook`, §7.17.1):
| store | keyPath | indexes | record |
|---|---|---|---|
| `books` | `id` (= chapter id, e.g. `ch01`) | `updated` | `{id, title, fileName, blob, bytes, pages, added, updated, lastPage, lastScale}` |
| `pdfnotes` | `id` (`${bookId}|${page}`) | `bookId` | `{id, bookId, page /* 1-based */, scene, highlights: TextHl[], updated}` |
| `bookfiles` | `id` | — | `{id, blob}` — the PDF bytes, kept apart so position/metadata saves never rewrite a large blob (internal; not in `ALL_STORES`; `bookRepo.get()` joins it) |
Images use `mediaRepo` with `qid: 'book:<bookId>'`; voice clips use `voiceRepo` with `qid: 'book:<bookId>|<page>'`.
`TextHl = { id, color, rects: [x, y, w, h][] /* fractions of the page */, quote }`.
```js
export const bookRepo     = { get(id), all() /* without loading blobs into memory where possible */, put(rec), remove(id),
                              setPosition(id, { lastPage, lastScale }) }
export const pdfNotesRepo = { get(bookId, page), byBook(bookId), set(bookId, page, { scene, highlights }) /* deletes when empty */,
                              removeBook(bookId) }
```
Backup: `pdfnotes` always; `books` (PDF blobs) only with the new option `includeBooks` (default **false**: the files
are large and the user still has the originals; Settings > Data has an "Include book PDFs" toggle); images/voice of the book
follow `includeMedia`. Header gains `includesBooks`; import result gains `keptBooks`; exports `BOOK_STORES`, `decodeBookRecord`;
`mediaKeptText(hasVoice, hasImages, keepBooks = false)`.

`features/book/library.js`: `matchChapter(fileName, {chapters?})`, `importPdfFiles(files, {chapterFor?, chapters?, onProgress?})`
→ `[{file, name, chapterId, status /* added|replaced|unchanged|unmatched|duplicate|invalid|too-large|no-space|error */,
record?, previous?, error?, message?}]` (never throws), `undoImport(results)`, `storageEstimate()`, `loadBookData()`,
`normalizeBookData`, `pdfPageFor(bookPage, firstPage)`, `bookPageFor`, `formatBytes`. `bookRepo.put` validates `%PDF-`
and ≤ 300 MB (`BOOK_MAX_BYTES`); `data/book.json` is precached with the data and validated by `scripts/validate.mjs`
(sections inside the chapter's page range). The Book tab lists all 55 chapters via `loadIndex({ includeUnpublished: true })`
(the one non-dev use of that option: chapter *titles* only, never unpublished questions).

Modules:
```js
// features/book/pdf.js     — loads the vendored PDF.js (vendor/pdfjs/, legacy build, lazy import, module worker)
export async function openPdf(source /* Blob | ArrayBuffer | url */) → PDFDocumentProxy
export async function pdfInfo(blob) → { pages, title, outline: [{title, page, level}] }
// features/book/viewer.js  — virtualized continuous-scroll viewer
export function createPdfViewer(container, doc, { initialPage = 1, initialScale = 'fit-width',
  onPageChange, overlay /* (pageNumber, pageEl, size {w,h}) => { destroy() } | null */ })
  → { goTo(page), page(), pageCount(), setScale(s | 'fit-width' | 'fit-page'), scale(), zoomIn(), zoomOut(),
      search(query) → AsyncIterable<{page, rects}>, textOf(page), outline(), thumbnail(page, width) → canvas,
      on(event /* 'page'|'scale'|'textselect' */, fn), destroy() }
// As built (pdf-viewer): openPdf copies typed arrays and downloads URLs whole; one shared module worker
//   (closePdfEngine() after the last doc is destroyed); PdfError {.code password|invalid|empty|read|network|engine|
//   cancelled|unknown, .userMessage}. Viewer extras: `ready` (Promise), `el` (scroller), showMatch(match|index),
//   clearSearch(), `label` option, overlay hook 4th arg `overlayEl` (.pdfv-overlay, pointer-events none until the editor
//   enables its own elements), event 'render' {page, scale}; 'scale' → {scale, mode, fitWidth, fitPage};
//   'textselect' → {page, text, rects [x,y,w,h] fractions, bounds} | null; search() yields {page, rects, index, excerpt};
//   thumbnail() is async. Scale = CSS px per PDF point, 0.25–6 (MAX_SCALE). Page layers bottom→top: canvas.pdfv-canvas,
//   canvas.pdfv-detail, .pdfv-hits, .textLayer, .pdfv-overlay. Pages are role="group" aria-label "Page N of M"
//   (canvas aria-hidden, text layer readable). Off-screen work waits for scroll pauses; destroy() leaves `doc` to the caller.
// features/book/annotate.js — per-page annotation layer (reuses the scratch engine: scene, geometry, render, tools)
export function createBookAnnotator(bookId) → session { overlay /* pass to the viewer's overlay option */, attachViewer,
  setEditing, setTool/setColor/setSize, undo, redo, addImages, clearPage, pagesWithNotes, handleKey, flush, destroy, on }
export function createPageAnnotator(bookId, pageNumber, pageEl, size)   // thin wrapper kept for the contract
export function createBookToolbar(session, { onDone }) → HTMLElement
// Scene additions (scratch/scene.js): point items { type:'note', x, y, text, color } and { type:'audio', x, y, voice, durationMs };
//   scenes keep their own page size; deserialize(raw, {size}) rescales; renderer paper 'none' + `dark` option (book pages
//   stay white). Text highlights store a colour name (yellow|green|blue|pink) painted with fixed marker colours.
//   Setting `bookExpanded` remembers open chapters in the Book list.
// features/book/export.js  — lazy pdf-lib (vendor/pdf-lib/): annotated copy of the original (strokes as vectors,
//                            images, text, shapes, highlights; voice clips listed as page notes), never edits the original
// screens/book.js (/book) and screens/reader.js (/book/:chapterId)
```
Reader UX: opens at the last page (or `?page=`), fit-width; pinch/ctrl-wheel zoom re-renders crisply; page indicator
with jump; sections/outline sheet; thumbnails strip; search in the PDF text; **Edit** toggle shows the tool bar:
select/lasso, pen (pressure), highlighter, text highlight (select text → colour), eraser, shapes, text box, sticky
note, image (Photos/Camera/Files), voice note (record on the page, pin plays it), undo/redo, colours/sizes (remembered).
Autosave per page (debounced) + on page leave/pagehide. Old phones: only visible pages ±1 are rendered, canvases
are released when far away, backing store capped. Everything works offline; nothing is ever uploaded.

#### 7.17.1 The whole book once (owner request 2026-10-28)
The owner has one PDF of the whole book (≈ 425 MB, 1976 pages, front matter first; Volume 2 has its own front
matter, so Volumes 1 and 2 have different page offsets). "Add the whole book" (Book hero + empty state) stores it
**once**; every chapter opens as a **page range** of it. A chapter's own PDF (`books`) always wins over the book.

Storage (DB version **4**, additive migration `wholebook`, internal: not in `ALL_STORES`, **never in backups**):
| store | keyPath | records |
|---|---|---|
| `wholebook` | `id` | `{id:'meta', fileName, bytes, pages, added, updated, map: BookMap \| null, outline: [{title, page, level}], positions: {[chapterId]: {lastPage /* within the chapter */, lastScale, updated}}}` and `{id:'file', blob}` |
`BookMap = { version: 1, pages, detected, chapters: { ch01: { from, to /* 1-based PDF pages, inclusive */, how: 'labels'|'confirmed'|'folio'|'title'|'estimated'|'manual' } } }`.
`outline` keeps only entries at or after chapter 1's first page (front matter never stored).
```js
export const WHOLE_BOOK_MAX_BYTES /* 2 GB */, BOOK_MAP_HOW, normalizeBookMap(map, pages), checkWholeBookInput(blob)
export const wholeBookRepo = { get() /* meta + lazy blob */, meta(), put({blob, fileName, pages, map?, outline?}) /* keeps positions */,
                               setMap(map, {outline?}), setPosition(chapterId, {lastPage, lastScale}), remove() }  // store:change 'wholebook'
```
**Range loading** (`pdf.js`): `openPdf(blob, { range: true, rangeChunkSize = RANGE_CHUNK_SIZE /* 1 MB */ })` uses a
`PDFDataRangeTransport` fed by `blob.slice()` (`disableAutoFetch`, `disableStream`), so only the file structure and the
viewed pages are read (300 MB synthetic book: import + detection read ≈ 3 MB; a read failure → `PdfError 'read'`).
`pdfInfo(blob, {range})`. Note: PDF.js still reserves a buffer of the file length (lazily committed memory).

**Viewer**: `createPdfViewer(container, doc, { …, pages: {from, to} })` shows only that range through
`pageRangeDoc(doc, {from, to})` (exported, pure): pages renumbered 1..n ("Page 3 of 21"), search, text, thumbnails,
outline (refs outside → dropped) never see other pages. `destinationPage` shifts integer page targets by `doc.offset`.

**Annotation key scheme (both sources)**: notes are keyed per **chapter + page within the chapter**:
`pdfnotes` id `${chapterId}|${n}` with `n = pdfPage − range.from + 1` for the whole book, = the PDF page for a chapter
PDF (which starts at the chapter's first page, the same assumption `data/book.json` makes). Voice `book:<ch>|<n>`,
images `book:<ch>`. So notes follow the chapter whichever file is used; nothing existing is migrated or re-keyed.

`features/book/wholebook.js` (pure helpers + drivers): `WHOLE_BOOK_MIN_PAGES` (150), `FOLIO_BAND` (0.12), `TITLE_MIN` (0.75),
`SHARE_CACHE` ('cmcq-share-inbox'), `wordsOf`, `titleWords`, `titleScore(text, title)`, `pageFacts(items, view)` → `{text,
folios}` (1–4 digit whole tokens in the top/bottom band), `labelStarts(labels, chapters)`, `estimateMissing`, `computeRanges`
(a chapter ends before the next start and is never longer than its printed length, so the next volume's front matter
is excluded; the last chapter runs to the end), `rangeOf(meta, id)`, `outlineFor(outline, range)`,
`detectChapterStarts({chapters, numPages, readPage, getLabels?, onProgress?, signal?})` → `{starts, reads}`,
`detectBookMap(doc, chapters, {onProgress, signal})`, `adjustRanges(chapters, ranges, id, from|null, numPages)` (manual start;
estimated chapters re-estimated), `chapterRefsOf(index)`, `importWholeBook(file, {chapters, requireMatch?, onProgress?, signal?})`
(errors `code`: bad-input|empty|not-pdf|too-large|too-short|not-book|no-space|password|damaged|error; checks free space;
stores while detecting, or after a match with `requireMatch`), `redetectWholeBook({chapters, onProgress})`, `pageCountOf(blob)`,
`isShareId`, `takeSharedFiles(id)`.
Detection: page labels when present; else per chapter verify `bookPage + offset` (folio on p, p+1, p+2 and the title on p:
1 folio + title = 'confirmed', 2 folios = 'folio', title only when the pages have no numbers = 'title'); when it fails, probe
pages after the guess (first chapter: +40, +60, … to skip front matter; later: +1, +3, … +100, −1 …), take offsets from
folios confirmed by a neighbouring page, verify. Never scans the whole book (synthetic 1985-page book: 173 page reads,
55/55 at the exact page, Volume 1 front matter never read). Missing chapters get 'estimated' from the nearest found
chapter of the same volume. **Front matter (before chapter 1) is never shown, searched, listed or stored.**

**Export of a whole-book chapter** (`export.js`): `features/book/extract.js` `extractPageRange(pdfLib, blob, from, to, {onRead})`
builds a new pdf-lib document with only those pages, reading only their objects with `blob.slice()` (classic xref tables,
xref streams with PNG/TIFF predictors, object streams, hybrid `/XRefStm`, `/Prev` chains; inherited Resources/MediaBox/
CropBox/Rotate; links and back-pointers out of the range dropped; encrypted → `ExtractError 'encrypted'`). 300 MB file:
≈ 170 KB read for one chapter. Fallback when the range copy fails: the whole file through pdf-lib only if
`canLoadWhole(bytes)` (≈ `deviceMemory × 64 MB`, else 150 MB on touch devices / 600 MB on desktop); otherwise a plain
message suggesting the chapter's own PDF. Annotations are then drawn exactly as for a chapter PDF.

**Book screen**: hero "Add the whole book" (hidden once added) + "Add PDFs"; empty state with the same button; a
whole-book card (file, pages, size, "N of 55 chapters found", **Check chapter pages** / **Find chapters**, ⋯: Find again,
Replace, Remove with Undo — the file is deleted only after the 6.5 s undo window); progress sheet "Finding chapters… 23/55";
chapter-pages sheet (status Found / Estimated / Set by you / Not found, "Starts on PDF page" field, Undo, Find again);
rows of whole-book chapters open the reader; chapters not found offer "Set its pages". Add PDFs / drop / share route a
file with > 300 MB or ≥ 150 pages to the whole-book import with `requireMatch` (≥ 3 chapters found), else per chapter.
Query: `#/book?pages=<ch>` (sheet at that chapter), `#/book?add=book`, `#/book?import=<shareId>`.
**Reader**: chapter PDF first, else the book range (positions in `wholebook.positions`); "Page 3 of 21, book page 30"
labels; jump sheet shows book pages; More: Check this chapter's pages, Use a separate PDF; a chapter missing from the map
shows "Set this chapter's pages".

**Android share target**: manifest `share_target` (POST multipart to `./share-target`, file field `pdf`, accept
application/pdf). sw.js stashes the files in Cache Storage `cmcq-share-inbox` (kept by activate) under
`__share/<id>/<n>` (`X-File-Name` header; id = base36 time (9) + 8 random) and redirects 303 to `#/book?import=<id>`
(`import=failed` on error). The Book tab takes and deletes them (stale entries > 24 h dropped) and imports them.
Tests never open the owner's book: `tests/unit/book-fixture.mjs` builds a synthetic two-volume book (titles/pages from
data/index.json, front matter marked `PRIVATEFRONTMATTER`) and a padded 300 MB copy.

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
- `node scripts/lint.mjs` — static code checks; `node tests/smoke.mjs` — boot smoke test.
