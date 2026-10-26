# CLAUDE.md

Project rules for every Claude session working in this repository.
Read this first. These decisions are fixed unless the owner changes them.

## What this is

A cardiac surgery MCQ (multiple-choice question) study app for board-level exam preparation.

## Status

Planning only. The app has **not** been built yet. Do not add app code, data,
icons or scripts until the owner asks for them.

## Communication

- Talk to the owner in **Arabic**.
- Code, comments, commit messages and question content are in English.

## Architecture

- A **Progressive Web App (PWA)** made only of static files: HTML, CSS, vanilla JS and JSON.
- **No** framework, **no** build step, **no** backend, **no** database, **no** API keys.
- Use **relative paths** everywhere and **no server-only features**, so the same files
  can later be wrapped with Capacitor (Android APK, maybe iOS IPA).

## Hosting and deployment

- **Cloudflare Pages**, connected to this repo.
- Framework preset: **None**. Build command: **empty**. Output directory: **`/`**.
- Every push auto-deploys. Treat every push to `main` as a production release.

## Installation targets

- **iPad**: Safari > Share > Add to Home Screen.
- **Android**: Chrome > Install app.
- Possible later: Capacitor wrap (Android APK, maybe iOS IPA).

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
