/**
 * Cardiac Surgery MCQ: service worker (docs/ARCHITECTURE.md §5.8).
 *
 * - Precaches every app file (APP_SHELL) and the question data the app can
 *   show (published chapters + the demo) at install, so the app works 100%
 *   offline after the first load. Unpublished chapters are never fetched.
 * - Two caches per release: `cmcq-shell-<VERSION>` (app files) and
 *   `cmcq-data-<VERSION>` (question data + images).
 * - Install is all-or-nothing: if any app file or data file is missing or
 *   broken, the new version is not installed and users keep the current,
 *   working one. A bad deploy can never reach installed apps.
 * - No automatic skipWaiting: the page shows "Update available" and the user
 *   chooses when to reload (message SKIP_WAITING).
 * - Never touches IndexedDB. User progress survives every update.
 *
 * Classic script on purpose (module workers are not supported everywhere).
 * The VERSION line is rewritten by scripts/bump-version.mjs; keep its format.
 */
'use strict';

const VERSION = '2026.10.26-1';

/** Every cache this app creates starts with this prefix (other apps may share the origin). */
const CACHE_PREFIX = 'cmcq-';
const SHELL_CACHE = CACHE_PREFIX + 'shell-' + VERSION;
const DATA_CACHE = CACHE_PREFIX + 'data-' + VERSION;
/** Caches left by the throwaway install test that preceded the real app. */
const LEGACY_CACHE_PREFIXES = ['install-test-'];

/**
 * Every file the app needs, relative to this script. scripts/validate.mjs
 * checks that the list is complete and that every entry exists.
 * Keep one quoted path per line.
 */
const APP_SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'css/tokens.css',
  'css/base.css',
  'css/components.css',
  'css/shell.css',
  'css/explanation.css',
  'css/annotate.css',
  'css/ink.css',
  'css/features.css',
  'css/review.css',
  'css/screen-player.css',
  'css/screen-home.css',
  'css/screen-misc.css',
  'js/app.js',
  'js/version.js',
  'js/core/dom.js',
  'js/core/events.js',
  'js/core/util.js',
  'js/core/router.js',
  'js/core/settings.js',
  'js/core/data.js',
  'js/core/sw-client.js',
  'js/core/store/db.js',
  'js/core/store/repo.js',
  'js/features/srs.js',
  'js/features/quiz/builder.js',
  'js/features/quiz/engine.js',
  'js/features/stats.js',
  'js/features/search.js',
  'js/features/explain/inline.js',
  'js/features/explain/render.js',
  'js/features/annotate/anchor.js',
  'js/features/annotate/highlight.js',
  'js/features/annotate/ink.js',
  'js/features/annotate/ink-toolbar.js',
  'js/features/annotate/scratchpad.js',
  'js/features/notes.js',
  'js/features/voice.js',
  'js/features/askgpt.js',
  'js/features/tts.js',
  'js/features/lists.js',
  'js/features/question-view.js',
  'js/features/quiz/start.js',
  'js/features/review.js',
  'js/features/backup.js',
  'js/ui/icons.js',
  'js/ui/components.js',
  'js/ui/shell.js',
  'js/ui/tour.js',
  'js/screens/home.js',
  'js/screens/chapter.js',
  'js/screens/builder.js',
  'js/screens/player.js',
  'js/screens/results.js',
  'js/screens/question.js',
  'js/screens/library.js',
  'js/screens/stats.js',
  'js/screens/search.js',
  'js/screens/settings.js',
  'js/screens/reviewer.js',
];

/** Data entry points (relative to this script). Chapter files come from the index. */
const DATA_INDEX = 'data/index.json';
const DATA_RETIRED = 'data/retired.json';

/** Parallel downloads during install. */
const CONCURRENCY = 6;
/** Attempts per file during install (network errors and 5xx only). */
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

/** App root, e.g. https://example.org/cardiacsurgery-/ (always ends with "/"). */
const BASE = new URL('./', self.location.href).href;
const BASE_PATH = new URL(BASE).pathname;
const DATA_BASE = new URL('data/', BASE).href;
const INDEX_URL = new URL('index.html', BASE).href;
const SELF_URL = new URL(self.location.href).href;

const LOG = '[sw ' + VERSION + ']';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Absolute URL for an app-relative path.
 * @param {string} path
 * @returns {string}
 */
function toUrl(path) {
  return new URL(path, BASE).href;
}

/**
 * URL without query string or hash (data cache keys).
 * @param {URL} url
 * @returns {string}
 */
function withoutSearch(url) {
  return url.origin + url.pathname;
}

/** @param {string} name */
function isOwnCache(name) {
  return name.startsWith(CACHE_PREFIX) || LEGACY_CACHE_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * True when the URL points at a document (no file extension, or .html).
 * @param {URL} url
 */
function looksLikePage(url) {
  const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  return last === '' || !last.includes('.') || /\.html?$/i.test(last);
}

/**
 * True when the server answered a non-HTML path with an HTML page
 * (single-page-app fallbacks on some hosts return index.html with 200 for
 * missing files). Such a response must never be cached as a script or data.
 * @param {URL} url
 * @param {Response} response
 */
function isHtmlFallback(url, response) {
  if (looksLikePage(url)) return false;
  const type = (response.headers.get('content-type') || '').toLowerCase();
  return type.startsWith('text/html');
}

/**
 * Navigations reject responses that were redirected (Safari and Chrome show a
 * network error), so redirected responses are rebuilt before caching.
 * @param {Response} response
 * @returns {Promise<Response>}
 */
async function cleanResponse(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Fetches a file for precaching. Retries network errors and 5xx answers.
 * Rejects on anything but a same-origin 200 with the right kind of content.
 * @param {string} url Absolute URL.
 * @param {RequestCache} cacheMode
 * @returns {Promise<Response>}
 */
async function fetchForCache(url, cacheMode) {
  const target = new URL(url);
  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(new Request(url, { cache: cacheMode, credentials: 'same-origin', redirect: 'follow' }));
    } catch (err) {
      lastError = new Error('Network error for ' + url + ': ' + ((err && err.message) || err));
      if (attempt < FETCH_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }
    if (response.status === 200 && response.type === 'basic' && !isHtmlFallback(target, response)) {
      return cleanResponse(response);
    }
    lastError = new Error(
      isHtmlFallback(target, response)
        ? 'Missing file (the server sent a page instead): ' + url
        : 'Could not download ' + url + ' (HTTP ' + response.status + ', ' + response.type + ')',
    );
    // A 4xx (missing file) will not fix itself; only retry server errors.
    if (response.status < 500 || attempt >= FETCH_ATTEMPTS) break;
    await sleep(RETRY_DELAY_MS * attempt);
  }
  throw lastError || new Error('Could not download ' + url);
}

/**
 * Downloads `urls` in batches and stores them. All-or-nothing per call:
 * the first failure rejects (and the install fails).
 * @param {Cache} cache
 * @param {string[]} urls Absolute URLs.
 * @param {{ cacheMode: RequestCache, inspect?: (url: string, response: Response) => Promise<void> }} options
 */
async function cacheStrict(cache, urls, { cacheMode, inspect }) {
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    const entries = await Promise.all(
      batch.map(async (url) => {
        const response = await fetchForCache(url, cacheMode);
        if (inspect) await inspect(url, response);
        return [url, response];
      }),
    );
    await Promise.all(entries.map(([url, response]) => cache.put(url, response)));
  }
}

/**
 * Best-effort precache (images). Failures are logged, never fatal: a missing
 * image is downloaded later when online and must not block an update.
 * @param {Cache} cache
 * @param {string[]} urls
 * @param {RequestCache} cacheMode
 */
async function cacheOptional(cache, urls, cacheMode) {
  let failed = 0;
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const batch = urls.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (url) => {
        try {
          if (await cache.match(url)) return;
          await cache.put(url, await fetchForCache(url, cacheMode));
        } catch (err) {
          failed += 1;
          console.warn(LOG, 'Optional file not cached:', url, err && err.message);
        }
      }),
    );
  }
  if (failed > 0) console.warn(LOG, failed + ' image(s) will be downloaded when first viewed online.');
}

/**
 * Reads a JSON body without consuming the response that will be cached.
 * @param {string} url
 * @param {Response} response
 */
async function readJson(url, response) {
  try {
    return await response.clone().json();
  } catch (err) {
    throw new Error('Invalid JSON in ' + url + ': ' + ((err && err.message) || err));
  }
}

/**
 * Resolves an app-relative file path from the data, refusing anything that
 * leaves the app folder or the origin.
 * @param {unknown} path
 * @returns {string | null}
 */
function safeAppUrl(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return null;
  }
  try {
    const url = new URL(path, BASE);
    return url.href.startsWith(BASE) ? withoutSearch(url) : null;
  } catch {
    return null;
  }
}

/**
 * Collects image paths used by a chapter's questions (question image and
 * explanation image blocks).
 * @param {any} chapter Parsed chapter file.
 * @param {Set<string>} out
 */
function collectImages(chapter, out) {
  const questions = chapter && Array.isArray(chapter.questions) ? chapter.questions : [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const main = q.image && safeAppUrl(q.image.src);
    if (main) out.add(main);
    if (!Array.isArray(q.explanation)) continue;
    for (const block of q.explanation) {
      if (block && block.type === 'image') {
        const src = safeAppUrl(block.src);
        if (src) out.add(src);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Downloads every app file into the shell cache (bypasses the HTTP cache). */
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  await cacheStrict(cache, APP_SHELL.map(toUrl), { cacheMode: 'reload' });
}

/** @param {unknown} v */
function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The data files to precache, from the parsed index: data/retired.json, the
 * file of every chapter with `"published": true`, and the demo file.
 * Unpublished chapters are hidden in the app, so their files are never
 * fetched by the worker. Every entry is still checked, so a malformed index
 * fails the install (and never reaches installed apps).
 * @param {any} index Parsed data/index.json.
 * @returns {string[]} Absolute URLs, without duplicates.
 * @throws {Error} When the index, a chapter entry or the demo entry is malformed.
 */
function dataFilesOf(index) {
  if (!isObject(index)) throw new Error(DATA_INDEX + ' is not a JSON object');
  if (!Array.isArray(index.chapters)) throw new Error(DATA_INDEX + ' has no "chapters" list');

  const files = new Set([toUrl(DATA_RETIRED)]);
  index.chapters.forEach((chapter, i) => {
    const at = DATA_INDEX + ' chapters[' + i + ']';
    if (!isObject(chapter)) throw new Error(at + ' is not an object');
    const url = safeAppUrl(chapter.file);
    if (!url) throw new Error(at + ' has an invalid chapter file: ' + JSON.stringify(chapter.file));
    if (chapter.published === true) files.add(url);
  });

  if (!isObject(index.demo)) throw new Error(DATA_INDEX + ' has no "demo" entry');
  const demoUrl = safeAppUrl(index.demo.file);
  if (!demoUrl) throw new Error(DATA_INDEX + ' has an invalid demo file: ' + JSON.stringify(index.demo.file));
  files.add(demoUrl);

  return [...files];
}

/**
 * Downloads data/index.json, data/retired.json, the file of every published
 * chapter and the demo file (all must be valid JSON), then the images those
 * files use (best effort). The index is stored last.
 * Data uses `cache: 'no-cache'`: always revalidated with the server, but an
 * unchanged multi-megabyte chapter is not downloaded again.
 */
async function precacheData() {
  const cache = await caches.open(DATA_CACHE);

  const indexUrl = toUrl(DATA_INDEX);
  const indexResponse = await fetchForCache(indexUrl, 'no-cache');
  const files = dataFilesOf(await readJson(indexUrl, indexResponse));

  const images = new Set();
  await cacheStrict(cache, files, {
    cacheMode: 'no-cache',
    inspect: async (url, response) => {
      const json = await readJson(url, response);
      collectImages(json, images);
    },
  });
  // The index goes in last, after every file it lists is safely stored.
  await cache.put(indexUrl, indexResponse);

  if (images.size > 0) await cacheOptional(cache, [...images], 'no-cache');
}

/** True when the throwaway install-test worker's cache is still around. */
async function hasLegacyCaches() {
  const names = await caches.keys();
  return names.some((name) => LEGACY_CACHE_PREFIXES.some((p) => name.startsWith(p)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const started = Date.now();
      await Promise.all([precacheShell(), precacheData()]);
      console.info(LOG, 'Installed in ' + (Date.now() - started) + ' ms.');
      // One-time migration from the install test (it holds no user data):
      // take over right away. Real updates always wait for the user.
      if (await hasLegacyCaches()) await self.skipWaiting();
    })().catch((err) => {
      console.error(LOG, 'Install failed; the current version stays in use.', err);
      throw err;
    }),
  );
});

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, DATA_CACHE]);
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => isOwnCache(name) && !keep.has(name))
          .map((name) => caches.delete(name).catch(() => false)),
      );
      // Navigations are served from the cache, so a navigation preload
      // request would be a wasted download on every launch.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable().catch(() => {});
      }
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Plain offline page for a navigation that is neither cached nor reachable. */
function offlineResponse() {
  const home = BASE.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="color-scheme" content="light dark"><title>Offline</title><style>' +
    'body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
    'display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box;text-align:center}' +
    'main{max-width:28rem}h1{font-size:1.4rem;margin:0 0 8px}p{margin:0 0 20px;opacity:.8}' +
    'a{display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:12px;' +
    'background:#b01e2d;color:#fff;text-decoration:none;font-weight:600}' +
    '</style></head><body><main><h1>You are offline</h1>' +
    '<p>The app is not saved on this device yet. Connect to the internet once, then try again.</p>' +
    '<a href="' + home + '">Try again</a></main></body></html>';
  return new Response(html, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Looks up a request in this version's caches only (never in another
 * version's caches, so files of two releases are never mixed).
 * @param {Request} request
 * @param {boolean} isData
 * @param {URL} url
 * @returns {Promise<Response | undefined>}
 */
async function matchOwn(request, isData, url) {
  try {
    const primary = await caches.open(isData ? DATA_CACHE : SHELL_CACHE);
    const hit = isData
      ? await primary.match(withoutSearch(url), { ignoreSearch: true, ignoreVary: true })
      : await primary.match(request, { ignoreVary: true });
    if (hit) return hit;
    const secondary = await caches.open(isData ? SHELL_CACHE : DATA_CACHE);
    return await secondary.match(request, { ignoreVary: true });
  } catch (err) {
    console.warn(LOG, 'Cache lookup failed', err);
    return undefined;
  }
}

/**
 * Stores a network response for offline use, if it is a complete,
 * same-origin, successful answer.
 * @param {string} cacheName
 * @param {Request | string} key
 * @param {URL} url
 * @param {Response} response A clone the caller does not read.
 */
async function storeCopy(cacheName, key, url, response) {
  try {
    if (response.status !== 200 || response.type !== 'basic' || isHtmlFallback(url, response)) return;
    const cache = await caches.open(cacheName);
    await cache.put(key, await cleanResponse(response));
  } catch (err) {
    console.warn(LOG, 'Could not store a copy of', url.href, err && err.message);
  }
}

/**
 * The app is a single page with a hash router: every launch gets the cached
 * index.html; the network is only a fallback.
 * @param {FetchEvent} event
 */
async function handleAppNavigation(event) {
  try {
    const cache = await caches.open(SHELL_CACHE);
    const cached =
      (await cache.match(INDEX_URL, { ignoreSearch: true, ignoreVary: true })) ||
      (await cache.match(BASE, { ignoreSearch: true, ignoreVary: true }));
    if (cached) return cached;
  } catch (err) {
    console.warn(LOG, 'Cache lookup failed for the app page', err);
  }
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    return offlineResponse();
  }
}

/**
 * Cache-first for every other file, then network (a copy is stored).
 * @param {FetchEvent} event
 * @param {URL} url
 */
async function handleAsset(event, url) {
  const { request } = event;
  const isData = url.href.startsWith(DATA_BASE);
  // Page code can ask for a fresh copy explicitly (fetch(url, {cache: 'reload'|'no-store'})).
  const wantsNetwork = request.cache === 'reload' || request.cache === 'no-store';

  if (!wantsNetwork) {
    const cached = await matchOwn(request, isData, url);
    if (cached) return cached;
  }

  try {
    const response = await fetch(request);
    if (!wantsNetwork) {
      const key = isData ? withoutSearch(url) : request;
      event.waitUntil(storeCopy(isData ? DATA_CACHE : SHELL_CACHE, key, url, response.clone()));
    }
    return response;
  } catch {
    // Offline (or the server is unreachable): last chance is the cache.
    if (wantsNetwork) {
      const cached = await matchOwn(request, isData, url);
      if (cached) return cached;
    }
    if (request.mode === 'navigate') return offlineResponse();
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // Chrome DevTools quirk: this combination throws when fetched.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Cross-origin, other apps on the same origin, and this script: not ours.
  if (url.origin !== self.location.origin || !url.href.startsWith(BASE) || url.href === SELF_URL) return;
  // Media range requests are left to the browser.
  if (request.headers.has('range')) return;

  const isAppPage = url.pathname === BASE_PATH || withoutSearch(url) === INDEX_URL;
  if (request.mode === 'navigate' && isAppPage) {
    event.respondWith(handleAppNavigation(event));
    return;
  }
  event.respondWith(handleAsset(event, url));
});

// ---------------------------------------------------------------------------
// Messages from the page
// ---------------------------------------------------------------------------

/**
 * Replies to a message on its MessagePort when given, else to its sender.
 * @param {ExtendableMessageEvent} event
 * @param {unknown} payload
 */
function reply(event, payload) {
  try {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
    else if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(payload);
  } catch (err) {
    console.warn(LOG, 'Could not reply to the page', err);
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
  switch (data.type) {
    case 'SKIP_WAITING':
      event.waitUntil(self.skipWaiting());
      break;
    case 'GET_VERSION':
      reply(event, { type: 'VERSION', version: VERSION });
      break;
    default:
      break;
  }
});
