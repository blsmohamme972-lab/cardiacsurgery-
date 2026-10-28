# Vendored libraries

Third-party files copied unchanged from their published npm packages. They are
static files (no build step) loaded lazily by the Book tab and precached by
`sw.js` so the reader works offline. Never edit them; to update, copy the new
files from the new package version and change this table.

| folder | library | version | license | source | files |
|---|---|---|---|---|---|
| `pdfjs/` | PDF.js (Mozilla) | 4.10.38 | Apache-2.0 (`pdfjs/LICENSE`; fonts: `standard_fonts/LICENSE_FOXIT`, `LICENSE_LIBERATION`) | npm `pdfjs-dist@4.10.38` | `legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs`, `standard_fonts/*`, `LICENSE` |
| `pdf-lib/` | pdf-lib | 1.17.1 | MIT (`pdf-lib/LICENSE.md`) | npm `pdf-lib@1.17.1` | `dist/pdf-lib.esm.min.js`, `LICENSE.md` |

## Why the PDF.js *legacy* build

The modern build of PDF.js 4.x uses JavaScript features newer than the app's
oldest target, Safari on iOS/iPadOS 16.4 (docs/ARCHITECTURE.md §1). The legacy
build is the same library compiled with polyfills for those browsers. It is used
by `js/features/book/pdf.js` (lazy `import()`; the worker runs as a module worker).
