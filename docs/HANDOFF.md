# Handoff: build status (2026-10-26)

The previous session stopped mid-build at the owner's request. This file says
exactly what exists, what is verified, and what to do next. Read `CLAUDE.md`
and `docs/ARCHITECTURE.md` first; they are the binding rules and contract.

Branch: `claude/cardiac-surgery-claude-md-wgvai0`. `main` still serves the old
install-test page on GitHub Pages; do **not** push the app to `main` until it
passes the full checks in step 6 below.

## 1. Done (wave 1 of the build, written against the contract)

| Area | Files | State |
|---|---|---|
| Core | `package.json`, `js/app.js`, `js/core/{dom,events,util,router,settings}.js`, `js/core/store/{db,repo}.js`, `tests/unit/util.test.mjs` | Complete. 44 unit tests pass. |
| UI kit + shell | `index.html`, `css/{tokens,base,components,shell}.css`, `js/ui/{icons,components,shell,tour}.js` | Complete. Tour CSS lives in `components.css`. |
| Offline + updates | `sw.js`, `js/core/sw-client.js`, `js/version.js`, `manifest.webmanifest`, `scripts/bump-version.mjs`, `tests/serve.mjs` | Complete. `sw-client.js` exports `initServiceWorker`, `applyUpdate`, `checkForUpdate`, `getVersionInfo`. |
| Data | `js/core/data.js`, `scripts/validate.mjs`, `data/index.json`, `data/retired.json`, `data/demo.json`, `data/ch01-cpb.json` … `data/ch13-trauma.json` | Complete **for the old 13-chapter plan** — must be migrated to 55 chapters (step 2). `demo.json` has 10 demo questions about using the app (no medical facts). |
| Logic (partial) | `js/features/srs.js`, `js/features/quiz/builder.js` | Written; no unit tests yet. |

Extra exports the wave-1 engineers added (all documented in their files' JSDoc):
`dom.text/setText/listen`, `bus.EVENTS`, util time constants, `router.href()`,
`settings.DEFAULTS/getAllSettings/resolvedTheme`, `db.StorageError/isQuotaError/closeDB`,
`repo.emptyQState/inkId`, `data.DataError(code)/blockPlainText/clearDataCache`,
`icons.ICON_NAMES/hasIcon` (+ icons heart, wifi-off, chevron-up, arrow-left/right, copy, external, plus, minus).

Checks at handoff:
- `node --test tests/unit/*.test.mjs` → 44/44 pass. (Note: Node 22 needs the glob; a bare directory fails.)
- `node scripts/validate.mjs` → fails only because files listed in `sw.js` APP_SHELL do not exist yet (expected until the build is finished). `--data-only` passes.
- No end-to-end boot test has been run yet.

## 2. Next: migrate to the 55-chapter book structure

The owner sent the book's table of contents. `docs/ARCHITECTURE.md` §3.1 now has
the fixed table (7 parts, 55 chapters, ids `ch01`–`ch55`, prefixes `CH01`–`CH55`,
files `data/ch01.json`–`data/ch55.json`, book pages) and the `published` rule:
**a chapter is completely hidden until `published: true`; a part is hidden until
it has a published chapter.** All 55 start unpublished and empty.

Update to match §3.1:
- `data/index.json` (parts, chapters with `published:false`, `demo` entry), create the 55 empty files, delete `data/ch01-cpb.json` … `data/ch13-trauma.json`.
- `js/core/data.js` (parts, published filter, `includeUnpublished` option, demo entry, `getQuestion` → null for unpublished).
- `scripts/validate.mjs` (`CHAPTER_TABLE` → the 55-chapter table + parts + demo; validate `published`, `page`, `part`).
- `sw.js` install: precache only published chapter files + demo.
- `js/features/quiz/builder.js`: `'all'` = published chapters only.

## 3. Next: finish wave 1

- Logic: `js/features/quiz/engine.js`, `js/features/stats.js`, `js/features/search.js` (§7.3–7.5), unit tests for srs, builder, engine, search.
- Explanations: `js/features/explain/inline.js`, `js/features/explain/render.js`, `css/explanation.css`, `tests/unit/inline.test.mjs` (§3.4, §3.5, §7.6).
- Integration check: every import resolves to a real export; CSS uses only defined tokens; boot the app in Playwright with no console errors except missing screens.

## 4. Next: wave 2 (features and screens)

- Annotations: `js/features/annotate/{anchor,highlight,ink,ink-toolbar,scratchpad}.js`, `css/annotate.css`, `tests/unit/anchor.test.mjs` (§7.7).
- Features: `js/features/{notes,voice,askgpt,review,backup}.js`, `tests/unit/askgpt.test.mjs` (§7.8–7.12).
- Screens (§5.4, §8): `js/screens/{player,results,question}.js` + `css/screen-player.css`;
  `js/screens/{home,chapter,builder,library}.js` + `css/screen-home.css` (Home lists **published chapters grouped by part**; demo card when nothing is published);
  `js/screens/{stats,search,settings,reviewer}.js` + `css/screen-misc.css`.

## 5. Next: wave 3 (integration, tests, review)

- `tests/e2e.mjs` per §9 (phone + iPad viewports), using `tests/serve.mjs` and the pre-installed Playwright.
- Fix everything until unit + e2e + validate are green.
- Adversarial review (correctness/data loss, offline + update flow, UX on phone/iPad, accessibility, security/XSS, performance) and fix confirmed findings.

## 6. Release

1. `node scripts/bump-version.mjs` → `node scripts/validate.mjs` → `node --test tests/unit/*.test.mjs` → `node tests/e2e.mjs`.
2. Push to the branch, then to `main` (GitHub Pages deploys in 1–2 minutes).
3. Tell the owner (in Arabic) how to test: open https://blsmohamme972-lab.github.io/cardiacsurgery-/ in Chrome/Safari,
   accept "Update available", try the demo chapter, airplane mode.

## Owner preferences to remember

- Talk to the owner in Arabic, short and clear. The app itself is English only.
- The owner is not a developer and works from a phone: give click-by-click steps with links.
- No chapter content yet. Content comes later, only from text the owner provides, never from any other source or search.
