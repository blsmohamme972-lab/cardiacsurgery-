#!/usr/bin/env node
/**
 * Tiny static file server for development and the end-to-end tests.
 *
 * Serves the repository root under `/cardiacsurgery-/`, the same path the
 * hosted site uses, so relative URLs, the service worker scope and the
 * manifest behave exactly as in production. `/` redirects there.
 *
 * - Zero dependencies (node:http), Node 20+.
 * - Correct MIME types, `Cache-Control: no-cache` + ETag (304 when unchanged).
 * - Never serves dotfiles/dot-folders (.git) or anything outside the root.
 * - Overrides: tests can replace a file's content without touching the disk
 *   (for example a bumped `sw.js` to test the "Update available" banner).
 *
 * Standalone:
 *   node tests/serve.mjs [--port 8080] [--host 127.0.0.1] [--log]
 *
 * Module:
 *   import { startServer } from './serve.mjs';
 *   const server = await startServer({ port: 0 });
 *   // server.url → 'http://127.0.0.1:54321/cardiacsurgery-/'
 *   server.setOverride('sw.js', text);   // or null to remove
 *   await server.close();
 *
 * Dev-only. Never loaded by the app.
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** URL path prefix the app is served under (same as the hosted site). */
export const PREFIX = '/cardiacsurgery-/';

/** Repository root (this file lives in tests/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Content types by file extension (lowercase). */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
});

/**
 * Content type for a file name.
 * @param {string} file
 * @returns {string}
 */
export function contentType(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Headers sent with every file. */
const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
});

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function sendText(res, status, message, headers = {}) {
  const body = `${message}\n`;
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} location
 */
function redirect(res, status, location) {
  sendText(res, status, `Moved to ${location}`, { Location: location });
}

/**
 * Maps a URL path below the prefix to a safe relative file path, or null.
 * @param {string} pathname URL path after the prefix (still encoded).
 * @returns {string | null} POSIX-style relative path ('' = root).
 */
export function toRelativePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/');
  for (const segment of segments) {
    // Blocks "..", ".", ".git", ".nojekyll" and every other dotfile.
    if (segment.startsWith('.')) return null;
  }
  return segments.filter(Boolean).join('/') + (decoded.endsWith('/') && decoded !== '/' ? '/' : '');
}

/**
 * Starts the server.
 * @param {{ port?: number, host?: string, root?: string, prefix?: string,
 *           overrides?: Record<string, string | Buffer>, log?: boolean }} [options]
 *   port 0 picks a free port. overrides maps relative paths (e.g. 'sw.js') to content.
 * @returns {Promise<{ url: string, origin: string, port: number, server: http.Server,
 *                     setOverride(file: string, content: string | Buffer | null): void,
 *                     clearOverrides(): void, close(): Promise<void> }>}
 */
export async function startServer({
  port = 0,
  host = '127.0.0.1',
  root = ROOT,
  prefix = PREFIX,
  overrides = {},
  log = false,
} = {}) {
  if (!prefix.startsWith('/') || !prefix.endsWith('/')) throw new Error('prefix must start and end with "/"');
  const rootReal = await realpath(path.resolve(root));
  /** @type {Map<string, Buffer>} */
  const overrideMap = new Map();
  let overrideStamp = Date.now();

  /** @param {string} file @param {string | Buffer | null} content */
  const setOverride = (file, content) => {
    const key = String(file).replace(/^\.?\/+/, '');
    if (content === null || content === undefined) overrideMap.delete(key);
    else overrideMap.set(key, Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    overrideStamp += 1;
  };
  for (const [file, content] of Object.entries(overrides)) setOverride(file, content);

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname, search } = url;

    if (pathname === '/' || pathname === '/index.html') {
      redirect(res, 302, prefix + search);
      return;
    }
    if (pathname === prefix.slice(0, -1)) {
      redirect(res, 301, prefix + search);
      return;
    }
    if (!pathname.startsWith(prefix)) {
      sendText(res, 404, 'Not found');
      return;
    }

    let rel = toRelativePath(pathname.slice(prefix.length - 1));
    if (rel === null) {
      sendText(res, 404, 'Not found');
      return;
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const etagMatches = (/** @type {string} */ etag) => {
      const header = req.headers['if-none-match'];
      return typeof header === 'string' && header.split(/\s*,\s*/).includes(etag);
    };

    const override = overrideMap.get(rel);
    if (override) {
      const etag = `W/"o-${override.length}-${overrideStamp}"`;
      if (etagMatches(etag)) {
        res.writeHead(304, { ...BASE_HEADERS, ETag: etag });
        res.end();
        return;
      }
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': contentType(rel),
        'Content-Length': override.length,
        ETag: etag,
      });
      res.end(req.method === 'HEAD' ? undefined : override);
      return;
    }

    const file = path.resolve(rootReal, ...rel.split('/'));
    let real;
    let info;
    try {
      real = await realpath(file);
      info = await stat(real);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        sendText(res, 404, 'Not found');
        return;
      }
      throw err;
    }
    // Symlinks must not lead outside the root.
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      sendText(res, 404, 'Not found');
      return;
    }
    if (info.isDirectory()) {
      redirect(res, 301, `${pathname}/${search}`);
      return;
    }
    if (!info.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      ...BASE_HEADERS,
      'Content-Type': contentType(real),
      ETag: etag,
      'Last-Modified': info.mtime.toUTCString(),
    };
    if (etagMatches(etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(real);
    stream.on('error', (err) => {
      console.error('[serve] Read error', real, err);
      res.destroy(err);
    });
    stream.pipe(res);
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    if (log) {
      res.on('finish', () => {
        console.log(`[serve] ${res.statusCode} ${req.method} ${req.url} ${Date.now() - started}ms`);
      });
    }
    handle(req, res).catch((err) => {
      console.error('[serve] Error', req.url, err);
      if (!res.headersSent) sendText(res, 500, 'Server error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 2000;

  await new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(undefined);
    });
  });

  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const origin = `http://${urlHost}:${address.port}`;

  /** @type {Promise<void> | null} */
  let closing = null;
  const close = () => {
    if (!closing) {
      closing = new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    }
    return closing;
  };

  return {
    url: origin + prefix,
    origin,
    port: address.port,
    server,
    setOverride,
    clearOverrides: () => {
      overrideMap.clear();
      overrideStamp += 1;
    },
    close,
  };
}

/**
 * @param {string[]} argv
 * @returns {{ port: number, host: string, log: boolean }}
 */
function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || 8080, host: '127.0.0.1', log: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [name, inline] = arg.split('=', 2);
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (name === '--port' || name === '-p') opts.port = Number(value());
    else if (name === '--host') opts.host = String(value());
    else if (name === '--log') opts.log = true;
    else if (name === '--help' || name === '-h') {
      console.log('Usage: node tests/serve.mjs [--port 8080] [--host 127.0.0.1] [--log]');
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error('Invalid --port');
  return opts;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const server = await startServer(opts);
    console.log(`Serving ${ROOT}`);
    console.log(`Open ${server.url}`);
    if (opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
      console.log('Note: service workers only run on https or localhost, so offline mode is off on other addresses.');
    }
    const stop = () => {
      server.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (err) {
    const message = err && err.code === 'EADDRINUSE' ? 'That port is already in use. Try --port 0 or another port.' : err && err.message;
    console.error(`serve: ${message || err}`);
    process.exit(1);
  }
}
