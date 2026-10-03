// The update spec's one-origin server (plan §4.9.3 `update`, issue #101): it serves the v1 or the v2 build at the
// same origin, so the page's service worker sees a new version of itself without the origin changing.
//
//   node e2e/update-proxy.mjs [--port 4174]
//
// - Static files come from the **active** directory, dist-e2e-v1/ at start (scripts/build-update-variants.mjs
//   builds both), with server/headers.json's headers, as the Go server sends them (server/handler.go): the common
//   headers on every response, htmlOnly on HTML, the first matching cacheControl rule, and the MIME type by
//   extension (application/octet-stream otherwise; never sniffed). GET and HEAD only (405 otherwise); `/` is
//   /index.html; exact lookup: no directory index, no SPA fallback. No ETag, 304, ranges or precompressed variants:
//   the update spec needs none of them, and the Go server's tests cover them.
// - Test-only endpoints, which exist only in this proxy: `GET /__switch?to=v1|v2` makes that directory the active
//   one (204; any other method gets 405, so a HEAD never switches), and `GET /__404s` returns every 404 so far as a
//   JSON array of "<METHOD> <raw path> (<active id>)", the path as requested, without its query. Both are
//   `no-store`, like the 404s and 405s (errorCacheControl).
// Plain Node ESM with no dependencies.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** The repo root: this file is e2e/update-proxy.mjs. */
const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** The variant ids and their directories (scripts/build-update-variants.mjs). */
const DIRS = { v1: join(ROOT, 'dist-e2e-v1'), v2: join(ROOT, 'dist-e2e-v2') };

/**
 * server/headers.json (plan §4.8.3), the Go server's and vite preview's single source of response headers.
 * @type {{ common: Record<string, string>, htmlOnly: Record<string, string>,
 *   cacheControl: { match: string, value: string }[], errorCacheControl: string, mime: Record<string, string> }}
 */
const HEADERS = JSON.parse(readFileSync(join(ROOT, 'server', 'headers.json'), 'utf8'));

const { values } = parseArgs({ options: { port: { type: 'string', default: '4174' } } });
const PORT = Number(values.port);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`update-proxy: --port must be an integer in 1..65535, got ${JSON.stringify(values.port)}`);
  process.exit(1);
}

for (const [id, dir] of Object.entries(DIRS)) {
  for (const file of ['index.html', 'sw.js']) {
    if (!existsSync(join(dir, file))) {
      console.error(
        `update-proxy: ${id}: ${join(dir, file)} not found: run scripts/build-update-variants.mjs`,
      );
      process.exit(1);
    }
  }
}

/** @type {keyof typeof DIRS} */
let active = 'v1';
/** @type {string[]} */
const notFound = [];

/**
 * The first cacheControl rule matching `path` (server/headers.go cacheControlFor): "**" matches every path, a
 * pattern ending in "/**" every path under that prefix, any other pattern exactly one path.
 * @param {string} path
 * @returns {string}
 */
function cacheControlFor(path) {
  for (const { match, value } of HEADERS.cacheControl) {
    if (match === '**' || match === path) return value;
    if (match.endsWith('/**') && path.startsWith(match.slice(0, -2))) return value;
  }
  return HEADERS.errorCacheControl; // unreachable: headers.json's last rule is "**" (server/headers.go validate)
}

/**
 * The file under the active directory that `path` names, or null: no `..` or empty segments, no directories.
 * @param {string} path a decoded URL path starting with "/"
 * @returns {string | null}
 */
function fileFor(path) {
  const segments = path.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) {
    return null;
  }
  const file = join(DIRS[active], ...segments);
  if (!file.startsWith(DIRS[active] + sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

const server = createServer((req, res) => {
  for (const [name, value] of Object.entries(HEADERS.common)) res.setHeader(name, value);
  const url = new URL(req.url ?? '/', 'http://localhost');
  /**
   * Ends the response with an error status and the errorCacheControl.
   * @param {number} status
   * @param {string} body
   */
  const error = (status, body) => {
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.writeHead(status).end(req.method === 'HEAD' ? undefined : `${body}\n`);
  };

  if (url.pathname === '/__switch') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET'); // only a GET switches; a HEAD must be safe
      error(405, 'Method Not Allowed');
      return;
    }
    const to = url.searchParams.get('to');
    if (to !== 'v1' && to !== 'v2') {
      error(400, 'to must be v1 or v2');
      return;
    }
    active = to;
    console.log(`update-proxy: active ${active}`);
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.writeHead(204).end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    error(405, 'Method Not Allowed');
    return;
  }
  if (url.pathname === '/__404s') {
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.setHeader('Content-Type', HEADERS.mime['.json'] ?? 'application/json');
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : JSON.stringify(notFound));
    return;
  }

  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname; // malformed escapes name no file
  }
  if (path === '/') path = '/index.html';
  const file = fileFor(path);
  if (file === null) {
    const rawPath = (req.url ?? '/').split('?')[0];
    notFound.push(`${req.method} ${rawPath} (${active})`);
    console.log(`update-proxy: 404 ${req.method} ${rawPath} (${active})`);
    error(404, 'Not Found');
    return;
  }
  let body;
  try {
    body = readFileSync(file);
  } catch {
    // The file went away between the lookup and the read (e.g. the variants were rebuilt under a running proxy).
    error(404, 'Not Found');
    return;
  }
  const contentType = HEADERS.mime[extname(file).toLowerCase()] ?? 'application/octet-stream';
  if (contentType.split(';')[0]?.trim().toLowerCase() === 'text/html') {
    for (const [name, value] of Object.entries(HEADERS.htmlOnly)) res.appendHeader(name, value);
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControlFor(path));
  res.setHeader('Content-Length', body.length);
  res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
});

server.on('error', (err) => {
  console.error(`update-proxy: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, 'localhost', () => {
  console.log(`update-proxy: serving dist-e2e-v1/ (active) and dist-e2e-v2/ on http://localhost:${PORT}`);
});
