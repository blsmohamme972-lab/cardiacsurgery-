# Handoff: build status (2026-10-26, session 2)

The previous session stopped mid-build at the owner's request. This file says
exactly what exists, what is verified, and what to do next. Read `CLAUDE.md`
and `docs/ARCHITECTURE.md` first; they are the binding rules and contract.

Branch: `claude/cardiac-surgery-claude-md-wgvai0`. `main` still serves the old
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
