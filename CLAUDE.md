# CLAUDE.md

Project rules for every Claude session working in this repository.
Read this first. These decisions are fixed unless the owner changes them.

## What this is

A cardiac surgery MCQ (multiple-choice question) study app for board-level exam preparation.

## Status

Planning only. The app has **not** been built yet. Do not add app code, data,
icons or scripts until the owner asks for them.

The current `index.html`, `manifest.webmanifest`, `sw.js` and `icons/` are a
throwaway **install test** (does the PWA install and open offline on iPad/Android).
Replace them when the real app is built.

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

## Hosting and deployment

- **GitHub Pages** from this repo (the repo is **public** for this reason).
  Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
- Site URL: https://blsmohamme972-lab.github.io/cardiacsurgery-/
  The app lives under the `/cardiacsurgery-/` sub-path, so all paths must be relative.
- `.nojekyll` at the root turns off Jekyll processing. Keep it.
- Every push to `main` auto-deploys. Treat every push to `main` as a production release.
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

- Target: **5000+ board-level MCQs**, written in **English**.
- UI language: **Arabic and English**, with full **RTL** support for Arabic.
- Questions are **AI-generated** and carry `"reviewed": false` until a specialist
  reviews them (then `"reviewed": true`).

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

## Security

- **Never commit secrets or keys.** The app needs none.
