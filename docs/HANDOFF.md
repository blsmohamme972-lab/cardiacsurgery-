# Handoff: build status (2026-10-26, session 4)

The previous session stopped mid-build at the owner's request. This file says
exactly what exists, what is verified, and what to do next. Read `CLAUDE.md`
and `docs/ARCHITECTURE.md` first; they are the binding rules and contract.

Branch: **`claude/cardiac-surgery-continue-32w2av`** (session 4; built on top of `claude/cardiac-surgery-claude-md-wgvai0`). `main` still serves the old
install-test page on GitHub Pages; do **not** push the app to `main` until it
passes the full checks in step 6 below.

## Owner decisions made in session 2 (already in CLAUDE.md / ARCHITECTURE.md)

- **Read aloud approved**: a "Listen" button using the device's own voices
  (Web Speech API), free forever, offline. Contract: ARCHITECTURE §7.15,
  settings `ttsRate`/`ttsVoice` (already added to `js/core/settings.js`).
- **No extra AI features for now** (owner declined "smart practice",
  "readiness score" and "Ask Claude" when offered). Keep Ask GPT only.
- **Demo mode** (§3.1): while no chapter is published, the demo chapter stands
  in for the whole bank everywhere; once one chapter is published, the demo is
  only reachable from Settings > Help > "Try the demo". Only `data.js`
  (`demoMode`, `studyChapters()`) decides this.



## Session 4 (stopped by the owner mid-build: "Hand off") — START HERE

Unit tests: `node --test tests/unit/*.test.mjs` → **903/903 pass**. `node scripts/lint.mjs` → 2 errors
(missing `screens/results.js`, `screens/question.js`) + 4 warnings (missing APP_SHELL files). All finished
groups were reviewed by the orchestrator and their contract additions are already in ARCHITECTURE.md.

| item | state |
|---|---|
| Step 3.1 review engine/stats/search/inline/data/builder/sw | **DONE** (5 bugs fixed + regression tests) |
| validate.mjs inlineIssues via parseInline | **DONE** |
| `scripts/lint.mjs` + `tests/unit/lint.test.mjs` + package.json `lint`/`check`/`release` | **DONE** |
| `tests/smoke.mjs` boot smoke (stubs missing files in memory) | **DONE**, passes |
| `explain/render.js`, `css/explanation.css`, `tests/fixtures/explain.html`, `tests/visual/render.mjs` | **DONE** |
| `annotate/anchor.js`, `highlight.js`, `css/annotate.css`, `tests/visual/highlight.mjs` | **DONE** |
| `annotate/ink.js`, `ink-toolbar.js`, `scratchpad.js`, `css/ink.css`, `tests/unit/ink.test.mjs`, `tests/visual/ink.mjs` | **DONE** |
| `notes.js`, `voice.js`, `askgpt.js`, `tts.js`, `css/features.css`, unit tests, `tests/visual/features.mjs` | **DONE** |
| `review.js`, `backup.js`, `css/review.css`, `tests/unit/backup.test.mjs`, `tests/visual/backup.mjs` | **DONE** |
| `icons.js` `volume` icon | **DONE** |
| `question-view.js` (1066 lines), `screens/player.js` (977) | **DRAFT** — agent stopped mid-task; finish + test |
| `screens/results.js`, `screens/question.js`, `css/screen-player.css` | **MISSING** |
| `quiz/start.js`, `lists.js`, `screens/home.js`, `chapter.js`, `builder.js`, `library.js`, `css/screen-home.css` | **DRAFT** — agent stopped while finishing library; verify + test (no `tests/unit/{start,lists}.test.mjs`, no `tests/visual/home.mjs` yet) |
| `screens/stats.js`, `search.js`, `settings.js`, `reviewer.js` | **DRAFT** — agent stopped before CSS |
| `css/screen-misc.css`, `tests/visual/misc.mjs` | **MISSING** |
| `tests/e2e.mjs` | **MISSING** (agent stopped before writing to disk) |
| Wave 3 (e2e, fixes, adversarial review), release | not started |

Owner wishes (session 4): **publish to `main` as soon as the screens work** (quick checks: validate, lint,
unit, smoke + a manual Playwright run through the main flows), then keep doing e2e/review and ship
fixes as updates. Then tell the owner in Arabic how to test on the phone.

Notes for the next session:
- The per-group briefs + shared rule sheet worked well; the rule sheet text is in this file's
  "Session 3" notes (one shared sheet + one brief per group with an exact file list). Agents never commit;
  orchestrator commits after each one finishes. Small contract additions are reported by agents and
  applied to ARCHITECTURE.md by the orchestrator.
- Visual checks run with `node tests/visual/<name>.mjs`; they load Playwright via `createRequire`
  (plain ESM import can't find the global package).
- Integration notes for question-view: `initInk(root, q)` once per question; `setDrawing` → enable/disable;
  mount `createInkToolbar(ctrl, {onDone, onScratchpad: () => openScratchpad(q)})` while drawing; listen
  `on('stale')` for a calm notice; `highlightSelection()` for the bottom-bar Highlight button (false →
  "Select some text first"); choice text inside `<button>` needs `user-select: text`; badges/strike
  buttons need `data-anchor-skip`.
- Known open points: Settings "Check for update" may need an exported check function in `sw-client.js`;
  shell.css sticky `:hover` on tabs after tap (wrap in `@media (hover:hover)`); a shared "element removed"
  watcher is duplicated in notes/voice/askgpt/tts (could move to dom.js); repo.js has no multi-store
  `replaceAll` transaction (backup Replace uses snapshot+restore).

## Session 3 (stopped by the owner mid-build: "Hand off now")

Session 3 started step 3 and wave 2 in parallel with 11 sub-agents (step-3
reviews, render, lint, and all wave-2 groups 1–7). The owner asked for a
handoff while they were still running, so every agent was **stopped
mid-task**. What was on disk at that moment is committed as is. Unit tests:
`node --test tests/unit/*.test.mjs` → **737/737 pass** at handoff.

Treat everything below marked DRAFT as **unfinished and unreviewed**: read it,
finish it against ARCHITECTURE.md, test it. Don't assume it's complete.

| item | state at handoff |
|---|---|
| Review of `data.js`, `builder.js`, `sw.js` (step 3.1) | partly done: small fixes + tests in `data.js`, `builder.js`, `sw.js`, `tests/unit/{data,builder}.test.mjs`. Agent was adding a test for an encoded-dot file path (ch17). Re-check the diff (`git diff efbea1a -- js/core/data.js js/features/quiz/builder.js sw.js`). |
| Review of `engine.js`, `stats.js`, `search.js`, `inline.js` (step 3.1) | **not done** (no edits were saved; agent had just started the engine). |
| `validate.mjs` uses `parseInline`/`inlineToPlain` (step 3.3) | done or nearly done (`inlineIssues()` rewritten, tests in `tests/unit/validate.test.mjs`). Verify. |
| `scripts/lint.mjs` + package.json scripts (step 3.4) | **not started on disk**. |
| `js/features/explain/render.js` (step 3.2) | DRAFT, 712 lines, syntax OK. `css/explanation.css` and the gallery `tests/fixtures/explain.html` **missing**; no visual QA yet. |
| `annotate/anchor.js` + `tests/unit/anchor.test.mjs` | DRAFT (tests pass). `highlight.js`, `css/annotate.css` missing. |
| `annotate/ink.js`, `ink-toolbar.js`, `scratchpad.js`, `css/ink.css`, `tests/unit/ink.test.mjs` | missing. |
| `notes.js`, `askgpt.js` | DRAFT (syntax OK). `voice.js`, `tts.js`, `css/features.css`, `tests/unit/{askgpt,tts}.test.mjs` missing. |
| `review.js` | DRAFT, **syntax error** (file cut off mid-write). `backup.js`, `css/review.css`, `tests/unit/backup.test.mjs` missing. |
| `quiz/start.js`, `lists.js` | DRAFT (syntax OK). Screens home/chapter/builder/library, `css/screen-home.css` missing. |
| `screens/stats.js` | DRAFT (syntax OK). Screens search/settings/reviewer, `css/screen-misc.css` missing. |
| `question-view.js`, screens player/results/question, `css/screen-player.css` | missing. |
| Boot smoke test (step 3.5), wave 3, release | not started. |

Extra contract notes the stopped agents were asked to add (only if you build them):
`tts.js` also exports `listEnglishVoices()` and `previewVoice(voice, rate)` (Settings
needs them); `backup.js` also exports `openImportDialog(file)` (Settings import);
document both in ARCHITECTURE §7.15 / §7.12 when written.

The per-agent briefs used in session 3 are a good template: one shared rule
sheet (CLAUDE.md + ARCHITECTURE.md + "no innerHTML, no console.log, @module
header, reuse dom/components/repo, don't commit, random-port `startServer({port:0})`,
setOverride stubs for missing modules, screenshots at 390×844 and 834×1194 light/dark")
plus one brief per group with its exact file list. Run fewer agents at a time
(4 CPUs) and commit after each one finishes.

## 1. Done before session 2

Core (`js/core/*`, store), UI kit + shell (`css/{tokens,base,components,shell}.css`,
`js/ui/*`), offline/update (`sw.js`, `sw-client.js`, `version.js`, bump script,
`tests/serve.mjs`), `srs.js`, `quiz/builder.js`. See git history for details.

## 2. Step 2 — 55-chapter data layer: DONE

- `data/index.json`: 7 parts + 55 chapters (`published: false`, `count: 0`,
  `short` labels ≤ 16 chars) + `demo` entry. `data/ch01.json` … `data/ch55.json`
  are empty (`{"schemaVersion":1,"chapter":"chNN","questions":[]}`). Old
  13-chapter files deleted.
- `js/core/data.js`: new API exactly as §5.6 (`loadIndex({includeUnpublished})`
  → `{schemaVersion, parts, chapters, demo, demoMode}`, `studyChapters()`,
  `getChapter()`, `loadChapter(id, {includeUnpublished})`, `loadAll()`,
  `loadStudyBank()`, `getQuestion()` → null for unpublished, …). Chapter
  `order = number`; demo `order = Number.MAX_SAFE_INTEGER`. Missing demo →
  `demo: null` + warning. Test: `tests/unit/data.test.mjs`.
- `scripts/validate.mjs`: fixed 55-row `CHAPTER_TABLE`, `PARTS`, `DEMO`
  (exported); checks published/page/part/short/count; error for a published
  empty chapter and for an empty demo. Reviewed + fixed. Test:
  `tests/unit/validate.test.mjs`.
- `sw.js` `precacheData()`: precaches only published chapter files + demo +
  `retired.json`, index last; a malformed index fails the install.
- `quiz/builder.js`: `'all'` = `studyChapters()`; explicit ids limited to
  published + demo. Tests: `tests/unit/srs.test.mjs`, `tests/unit/builder.test.mjs`.

## 3. Step 3 — wave 1: MOSTLY DONE

Written and unit-tested (all pass):
- `js/features/explain/inline.js` + `tests/unit/inline.test.mjs` (rules in §3.5:
  exact marker runs, flanking, sup/sub without spaces, atomic code, escapes, arrows).
- `js/features/quiz/engine.js` + `tests/unit/engine.test.mjs` (§7.3; decisions:
  new Session field `graded`; `recordAnswer` saves immediately in both modes and
  returns `{session, correct, applied}`; `completeSession` never double-counts).
- `js/features/stats.js` + `tests/unit/stats.test.mjs` (§7.4; pure
  `aggregateStats`; byChapter rows have `short`, weakTopics rows have `correct`).
- `js/features/search.js` + `tests/unit/search.test.mjs` (§7.5; also exports
  `prepareSearchIndex()` — call when the Search screen opens — and
  `clearSearchIndex()` — call after `clearDataCache()`).

Checks at handoff: `node --test tests/unit/*.test.mjs` → **700/700 pass**;
`node scripts/validate.mjs --data-only` → **0 errors, 0 warnings**.
Full `node scripts/validate.mjs` still fails only because wave-2 files listed in
`sw.js` APP_SHELL don't exist yet (expected).

**Still to do for step 3** (the workflow was stopped here):
1. Adversarial review + fix of: `data.js`, `engine.js` (review was interrupted;
   may have left small edits — tests pass), `stats.js`/`search.js`, `inline.js`,
   `sw.js`+`builder.js` (review interrupted). `validate.mjs` is already reviewed.
2. Write `js/features/explain/render.js` + `css/explanation.css` (§7.6, §7.7
   `[data-block]` rule) and a dev gallery `tests/fixtures/explain.html`; visual
   QA with Playwright screenshots at 390×844 and 834×1194, light + dark.
3. `scripts/validate.mjs` `inlineIssues()` is only a rough marker count; switch it
   to `parseInline`/`inlineToPlain` from `js/features/explain/inline.js` so warnings
   match the real renderer.
4. Create `scripts/lint.mjs` (import/export resolution, CSS vars defined, no
   innerHTML except icons.js, no leading "/" URLs, no console.log, @module
   headers) and add it to `package.json` "check"/"release".
5. Boot smoke test in Playwright (expect only "screen missing" errors until wave 2).

## 4. Next: wave 2 (features and screens)

Contract is ready: §7.7–§7.15 (incl. new §7.13 shared modules `quiz/start.js`,
`lists.js`, `question-view.js`; §7.14 CSS ownership; §7.15 `tts.js`). `index.html`
and `sw.js` APP_SHELL already list the new files (`css/ink.css`,
`css/features.css`, `css/review.css`, `js/features/{tts,lists,question-view}.js`,
`js/features/quiz/start.js`).

Suggested parallel groups (disjoint files):
1. `annotate/{anchor,highlight}.js`, `css/annotate.css`, `tests/unit/anchor.test.mjs`
2. `annotate/{ink,ink-toolbar,scratchpad}.js`, `css/ink.css` (+ unit test for `strokeToPath`)
3. `notes.js`, `voice.js`, `askgpt.js`, `tts.js`, `css/features.css`, `tests/unit/{askgpt,tts}.test.mjs`
4. `review.js`, `backup.js`, `css/review.css`, `tests/unit/backup.test.mjs` (pure validate/merge parts)
5. `question-view.js`, `screens/{player,results,question}.js`, `css/screen-player.css`
6. `quiz/start.js`, `lists.js`, `screens/{home,chapter,builder,library}.js`, `css/screen-home.css`
   (Home lists **published chapters grouped by part**; demo card in demo mode)
7. `screens/{stats,search,settings,reviewer}.js`, `css/screen-misc.css`
   (Settings includes "Read aloud" voice picker + speed + download tip, and Help > "Try the demo")

Screens should load heavy tools with dynamic `import()` (§7.13) so a missing or
failing tool never breaks a screen. While groups run in parallel, test against
missing modules with `server.setOverride(path, stubText)` from `tests/serve.mjs`
(in memory), never by writing stubs to disk.

## 5. Next: wave 3 (integration, tests, review)

- `tests/e2e.mjs` per §9 (phone 390×844 + iPad 834×1194), using `tests/serve.mjs`
  and the pre-installed Playwright (Chromium flags for voice:
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`).
- Fix everything until unit + e2e + validate + lint are green.
- Adversarial review (correctness/data loss, offline + update flow, UX on
  phone/iPad, accessibility, security/XSS, performance) and fix confirmed findings.

## 6. Release

1. `node scripts/bump-version.mjs` → `node scripts/validate.mjs` → `node scripts/lint.mjs`
   → `node --test tests/unit/*.test.mjs` → `node tests/e2e.mjs`.
2. Push to the branch, then to `main` (GitHub Pages deploys in 1–2 minutes).
3. Tell the owner (in Arabic) how to test: open https://blsmohamme972-lab.github.io/cardiacsurgery-/
   in Chrome/Safari, accept "Update available", try the demo chapter, airplane mode.

## Notes for the next session

- This container has **4 CPUs → the Workflow tool runs only 2 agents at a time**.
  Plan fan-outs accordingly (or split into several smaller workflows/Agent calls).
- Workflow agents must not commit; the orchestrator commits and pushes often
  (a stop hook insists on a clean, pushed tree at the end of every turn).
- Scratch files go to `/tmp/claude-0/…`, never into the repo.

## Owner preferences to remember

- Talk to the owner in Arabic, short and clear. The app itself is English only.
- The owner is not a developer and works from a phone: give click-by-click steps with links.
- **Write no chapter content at all** (owner, 2026-10-26): the 55 chapter files stay
  empty. Only when the owner explicitly asks, in a message that gives the source
  text, may questions be written — and only from that text. Never from any other
  source, memory or search. Tests and fixtures use neutral placeholder text only.
