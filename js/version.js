/**
 * App version (docs/ARCHITECTURE.md §2, §5.9).
 *
 * Format `YYYY.MM.DD-N`. It must always equal `VERSION` in `sw.js`.
 * Never edit it by hand: run `node scripts/bump-version.mjs`, which updates
 * both files, then `node scripts/validate.mjs`.
 *
 * Pure module: safe to import in Node.
 *
 * @module version
 */

/**
 * Version of the app files the page was loaded from.
 * @type {string}
 */
export const APP_VERSION = '2026.10.27-2';
