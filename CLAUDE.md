# CLAUDE.md

Project rules for every Claude session working in this repository.
Read this first. These decisions are fixed unless the owner changes them.

## What this is

A cardiac surgery MCQ (multiple-choice question) study app for board-level exam preparation.

## Status

**Building v1** (owner said "start building", 2026-10-26). The full design
contract is in `docs/ARCHITECTURE.md` — read it before touching code, and keep
it in sync with any contract change.

The question chapters are **empty** until the owner provides source material.
`data/demo.json` holds an "App tour (demo)" chapter whose questions are about
using the app (no medical facts), so every feature can be tried now.

Install test result (2026-10-26): on Android Chrome the PWA installs from
GitHub Pages, opens standalone, and works offline in airplane mode.
iPad/iPhone not tested yet.

## Decisions made by Claude (owner said "choose the best"; owner may change)

- **5 answer choices** per question by default (4 allowed).
- **Features in v1**: practice (tutor) mode, timed exam mode, custom quiz
  builder, spaced repetition review, strike-through choices, statistics,
  search, bookmarks, notes, voice notes, highlights, drawing, scratchpad,
  Ask GPT, report a problem, reviewer mode, "not yet reviewed" badge,
  shuffled choices, resume, first-run tour, backup export/import.
- **Images**: supported inside questions/explanations (from the owner's
  sources). User-added images are not in v1.
- **Board**: general cardiac surgery board level; no single board's format is assumed.
- **Sources**: the owner uploads them in the chat (PDF or text). They are not committed.

## Communication

- Talk to the owner in **Arabic**.
- Code, comments, commit messages and question content are in English.

## Cost: 100% free

- The whole project must cost **nothing**. Use only free services and free tiers.
- Never add a paid service, paid plan, paid library or paid API.
- If a feature would need payment, stop and ask the owner first.
- Known limits that keep it free:
  - Stay within GitHub Pages limits: published site under 1 GB,
    soft limit of 100 GB bandwidth per month, no file over 100 MB.
  - An iOS App Store / IPA build needs a paid Apple Developer account, so it is
    **out of scope**. iPhone/iPad use the PWA only.
  - An Android APK can be built and installed directly (sideloaded) for free.
    Publishing on Google Play needs a one-time fee, so ask first.

## Architecture

- A **Progressive Web App (PWA)** made only of static files: HTML, CSS, vanilla JS and JSON.
- **No** framework, **no** build step, **no** backend, **no** database, **no** API keys.
- Use **relative paths** everywhere and **no server-only features**, so the same files
  can later be wrapped with Capacitor (Android APK; iOS IPA only if the owner
  ever accepts the Apple fee).

## Code quality: very advanced

The owner requires **very advanced, professional code** everywhere, within the
rules above (vanilla JS, no framework, no build step). That means:

- Modern JavaScript: ES modules, `async`/`await`, no global variables, small focused modules.
- Robust storage: **IndexedDB** for user data (with schema versions and migrations),
  Cache Storage for app files; call `navigator.storage.persist()`.
- Careful service worker: versioned caches, safe updates, no data loss.
- Fast: load chapters on demand, keep the first load small, smooth on old phones.
- Accessible: semantic HTML, keyboard and screen-reader friendly, good contrast,
  light and dark mode.
- Handle every error and edge case (offline, storage full, corrupt backup file).
- Validate all question data before it ships.
- Clean, consistent, well-structured code that is easy to extend.

## User experience: extremely user-friendly

The owner requires **extreme user-friendliness** in every screen and feature:

- **Zero learning curve**: everything is obvious on first use; no manual needed.
  A short optional first-run tour, skippable.
- **Fewest taps**: the most common actions (answer, next, bookmark, highlight,
  note) are one tap away. Start studying within 2 taps of opening the app.
- **Big touch targets** (at least 44×44 px), comfortable one-hand use on phones,
  a two-pane layout on iPad (question beside explanation).
- **Instant feedback**: every tap responds immediately; smooth animations that
  never slow the user down; respect "reduce motion".
- **Never lose work**: autosave everything instantly. Prefer **Undo** over
  "Are you sure?" dialogs.
- **Always resume** exactly where the user left off.
- **Clear, calm reading**: excellent typography, comfortable line length,
  adjustable font size, light/dark mode, high contrast.
- **Plain-language messages** for offline, errors, storage, and updates, each
  with a clear next step.
- **Gestures are shortcuts, never the only way**: every swipe also has a visible button.
- **Drawing tools stay simple**: a small palette, last-used tool and color remembered.
- **Settings remembered**, sensible defaults, nothing required to configure.
- Test every feature on a real phone and iPad size before calling it done.

## Hosting and deployment

- **GitHub Pages** from this repo (the repo is **public** for this reason).
  Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
- Site URL: https://blsmohamme972-lab.github.io/cardiacsurgery-/
  The app lives under the `/cardiacsurgery-/` sub-path, so all paths must be relative.
- `.nojekyll` at the root turns off Jekyll processing. Keep it.
- Every push to `main` auto-deploys. Treat every push to `main` as a production release.
- **Before every push that changes app files or data**: run
  `node scripts/bump-version.mjs` then `node scripts/validate.mjs`
  (and the tests in `tests/`). Without a version bump, installed apps never see the update.
- Because the repo is public, never put anything private in it.
- Cloudflare Pages was tried first and dropped (GitHub connection kept failing).

## Installation targets

- **iPad**: Safari > Share > Add to Home Screen.
- **Android**: Chrome > Install app.
- Possible later: Capacitor wrap for an Android APK (free when sideloaded).
  No iOS IPA, because it needs a paid Apple account.

## Offline

- Must work **100% offline** after the first load.
- A **service worker precaches everything** (HTML, CSS, JS, icons, manifest, all JSON data).

## Updates

- On launch, when online, the app checks for a new version.
- If one exists, show an **"Update available"** banner; the user chooses when to reload.
- **User progress must survive updates.** Never clear or overwrite progress storage
  when the service worker or cache changes.

## Content

- Audience: **cardiac surgery residents** preparing for the **cardiac surgery board**.
- Target: **5000+ board-level MCQs**.
- Language: **English only**, for both the UI and the questions. No Arabic UI, no RTL.
- Questions are **AI-generated** and carry `"reviewed": false` until a specialist
  reviews them (then `"reviewed": true`).

## Sources (strict)

- Write questions **only from the source material the owner provides**, exactly as given.
- **No external sources** and no outside knowledge: no other books, websites,
  guidelines or memory. If the provided sources do not support a fact, do not use it.
- Every question must say which provided source (and section/page) it comes from.
- If the sources are unclear or not enough for a question, skip it or ask the owner.
- The repo is public: do not commit the owner's source files (they may be
  copyrighted) unless the owner explicitly says so.

## Question generation (very precise)

Questions are made with a **highly precise, rigorous process**, not freehand writing:

- **Grounding**: every fact in the stem, the correct answer and the explanation
  must trace back to a specific passage in the owner's source. Keep a source
  reference (source, section/page) on every question.
- **Board quality**: clinical-vignette style for residents, one clearly best
  answer, plausible distractors that are wrong *according to the source*.
- **Automated checks** (dev-only scripts, never part of the app): schema
  validation, permanent unique IDs, no duplicate or near-duplicate questions,
  balanced position of the correct answer, every explanation block valid,
  every question has a source reference.
- Generate in small batches per chapter; check each batch before committing.

## Explanations (below the question)

- Shown **below the question** after answering (in practice mode) or in review.
- Written **only from the owner's source text**. Memory aids (mnemonics,
  diagrams) may restructure the source, but must not add facts.
- Goal: **very highly readable and unforgettable**. Use advanced formatting:
  - headings, **bold** key terms, short bullet lists
  - **tables** (comparisons, classifications, indications vs contraindications)
  - **arrows / flow chains** (cause → effect, pathophysiology, algorithms)
  - **mind maps** (a central concept with branches)
  - callout boxes: key point, pearl, pitfall, mnemonic
  - a short **source quote** with its reference
- Store explanations as **structured JSON blocks** (paragraph, list, table, flow,
  mindmap, callout, quote), not raw HTML. The app renders them with its own
  code as real HTML text (so highlights, ink and search work everywhere),
  works offline, and stays consistent and safe.
- Richer explanations make the data bigger (maybe 15–25 MB for 5000 questions);
  load chapters on demand to keep the app fast.

## Data layout

- One JSON file per chapter in `data/`.
- `data/index.json` lists the chapters.
- **Question IDs are permanent and never reused**, because progress is keyed by ID.
  Never renumber, recycle or change an existing ID. A deleted question's ID stays retired.

## Chapters

1. CPB & myocardial protection
2. CABG
3. Valves
4. Aorta
5. Congenital
6. HF/VAD/transplant
7. Arrhythmia surgery
8. Pericardium & tumors
9. Thoracic basics
10. Postop ICU
11. Anatomy & physiology
12. Pharmacology
13. Trauma

## Progress storage

- Stored **on the device** only.
- **Export and import** as a JSON backup file.

## User features (planned)

- **Highlights** on question text, saved per question ID.
- **Voice notes**: the user records a short audio note on a question
  (MediaRecorder, needs microphone permission once). Stored on the device in
  IndexedDB as audio blobs and played back offline.
  - Not wanted: text-to-speech (reading questions aloud) and voice dictation.
- **Highlights and drawing on the explanation too**, including on top of tables,
  flows and mind maps. Saved on the device per question.
  - Highlights anchor to the explanation block ID + the highlighted text (with a
    little text before/after), so they survive screen size changes and small
    explanation edits.
  - Drawing is a transparent layer over each explanation block, with stroke
    coordinates relative to that block's size, so ink stays on the right spot
    after rotation, a different screen, or a font-size change.
  - If an explanation is edited a lot later, flag highlights/ink that no longer
    match instead of silently losing them.
- **Drawing and handwriting** (professional, like a note-taking app): a canvas per
  question for drawing and writing with finger or stylus (Apple Pencil / S Pen).
  Pressure-sensitive pen, highlighter, eraser, colors and sizes, undo/redo,
  zoom/pan, palm rejection (use Pointer Events, `pointerType === "pen"`).
  Save strokes as vector data in IndexedDB (small, sharp at any zoom), not as images.
- **"Ask GPT" button** on each question: opens ChatGPT (the app if installed,
  otherwise the website) with the question, choices and the user's answer
  pre-filled, via a link like `https://chatgpt.com/?q=<encoded text>`.
  - No API, no key, no cost. Needs internet; hide or disable it when offline.
  - Fallback: copy the prompt to the clipboard, then open ChatGPT.
  - Show a short note that ChatGPT is an outside source and may not match the
    app's sources. This button is for the user only; it never feeds question writing.
- **Images**: still to be decided by the owner (images inside questions from the
  owner's sources, and/or images the user adds).
- All of this user data lives on the device and must be included in the backup
  export/import, with an option to export without media to keep the file small.

## Security

- **Never commit secrets or keys.** The app needs none.
