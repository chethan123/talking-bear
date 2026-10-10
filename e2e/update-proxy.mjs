// The update spec's one-origin server (plan §4.9.3 `update`, issue #101): it serves the v1 or the v2 build at the
// same origin, so the page's service worker sees a new version of itself without the origin changing.
//
//   node e2e/update-proxy.mjs [--port 4174] [--upstream v1=<url> --upstream v2=<url>]
//
// Two modes. Static mode (no --upstream; local runs, playwright.config.ts's webServer) serves the two local builds.
// Upstream mode (the CI e2e job against the e2e-mode images, issue #108, plan §7 M7) is a reverse proxy instead:
// `--upstream v1=http://localhost:8081 --upstream v2=http://localhost:8082` names the two running images, and
// /__switch picks the one that gets the requests.
//
// - Upstream mode: every request except the two test endpoints below goes, with its method, path, query and body,
//   to the active upstream (the image answers 404, 405, 304, 206 itself), and the response comes back unchanged:
//   status, body and every end-to-end header as the image sent it, names' case, order and duplicates included. Only
//   the hop-by-hop fields are dropped, both ways (RFC 9110 §7.6.1 plus Trailer, as trailers are not forwarded):
//   Connection, Keep-Alive, Proxy-Connection, TE, Trailer, Transfer-Encoding, Upgrade and any field the Connection
//   header names. The request keeps its Host. A 404 from the upstream goes into the 404 log like a static one; an
//   upstream that cannot be reached gets the proxy's own 502 (logged to stderr).
// - Static mode: static files come from the **active** directory, dist-e2e-v1/ at start (scripts/build-update-variants.mjs
//   builds both), with server/headers.json's headers, as the Go server sends them (server/handler.go): the common
//   headers on every response, htmlOnly on HTML, the first matching cacheControl rule, and the MIME type by
//   extension (application/octet-stream otherwise; never sniffed). GET and HEAD only (405 otherwise); `/` is
//   /index.html; exact lookup: no directory index, no SPA fallback. No ETag, 304, ranges or precompressed variants:
//   the update spec needs none of them, and the Go server's tests cover them.
// - Test-only endpoints, in both modes, which exist only in this proxy: `GET /__switch?to=v1|v2` makes that directory the active
//   one (204; any other method gets 405, so a HEAD never switches), and `GET /__404s` returns every 404 so far as a
//   JSON array of "<METHOD> <raw path> (<active id>)", the path as requested, without its query (any method but GET
//   and HEAD gets 405). Both are `no-store`, like the 404s and 405s (errorCacheControl). The proxy's own responses
//   (these two, its 400, 405 and 502, and every static-mode response) carry server/headers.json's common headers;
//   a forwarded response carries the upstream's headers only.
// Plain Node ESM with no dependencies.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
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

const { values } = parseArgs({
  options: { port: { type: 'string', default: '4174' }, upstream: { type: 'string', multiple: true } },
});
const PORT = Number(values.port);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`update-proxy: --port must be an integer in 1..65535, got ${JSON.stringify(values.port)}`);
  process.exit(1);
}

/**
 * Upstream mode's origins by variant id, from `--upstream v1=<url> --upstream v2=<url>`; null in static mode.
 * @type {Record<keyof typeof DIRS, URL> | null}
 */
const UPSTREAM = parseUpstreams(values.upstream);

/**
 * Prints an --upstream error and exits with status 1.
 * @param {string} message
 * @returns {never}
 */
function failUpstream(message) {
  console.error(`update-proxy: --upstream ${message}`);
  process.exit(1);
}

/**
 * Parses the --upstream values: none → static mode (null); otherwise exactly one `v1=<url>` and one `v2=<url>`, each
 * an http: origin (no path, query or fragment). Exits 1 on anything else.
 * @param {string[] | undefined} specs
 * @returns {Record<keyof typeof DIRS, URL> | null}
 */
function parseUpstreams(specs) {
  if (specs === undefined || specs.length === 0) return null;
  /** @type {Partial<Record<keyof typeof DIRS, URL>>} */
  const found = {};
  for (const spec of specs) {
    const m = /^(v1|v2)=(.+)$/.exec(spec);
    if (m === null) failUpstream(`must be v1=<url> or v2=<url>, got ${JSON.stringify(spec)}`);
    const id = m[1] === 'v1' ? 'v1' : 'v2';
    const raw = m[2] ?? '';
    if (found[id] !== undefined) failUpstream(`${id} is given twice`);
    /** @type {URL} */
    let url;
    try {
      url = new URL(raw);
    } catch {
      failUpstream(`${id}: not a URL: ${JSON.stringify(raw)}`);
    }
    if (url.protocol !== 'http:' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      failUpstream(
        `${id}: must be an http: origin such as http://localhost:8081, got ${JSON.stringify(raw)}`,
      );
    }
    found[id] = url;
  }
  if (found.v1 === undefined || found.v2 === undefined) failUpstream('needs both v1=<url> and v2=<url>');
  return { v1: found.v1, v2: found.v2 };
}

if (UPSTREAM === null) {
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

/**
 * The hop-by-hop fields (RFC 9110 §7.6.1, plus Trailer: trailers are not forwarded), lower-case. A proxy drops them,
 * and every field a message's Connection header names, in both directions.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * A message's raw header list (`rawHeaders`: name, value, name, value, …) without its hop-by-hop fields: every other
 * field stays as it was, with its name's case, its position and its duplicates.
 * @param {string[]} raw
 * @returns {string[]}
 */
function endToEnd(raw) {
  /** @type {Set<string>} */
  const drop = new Set(HOP_BY_HOP);
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if ((raw[i] ?? '').toLowerCase() !== 'connection') continue;
    for (const name of (raw[i + 1] ?? '').split(',')) {
      const n = name.trim().toLowerCase();
      if (n !== '') drop.add(n);
    }
  }
  /** @type {string[]} */
  const kept = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] ?? '';
    if (!drop.has(name.toLowerCase())) kept.push(name, raw[i + 1] ?? '');
  }
  return kept;
}

/**
 * Sets server/headers.json's common headers on one of the proxy's own responses (never on a forwarded one).
 * @param {import('node:http').ServerResponse} res
 */
function setCommon(res) {
  for (const [name, value] of Object.entries(HEADERS.common)) res.setHeader(name, value);
}

/**
 * Upstream mode: sends the request to the active upstream and its response back unchanged but for the hop-by-hop
 * fields. Nothing has set a header on `res` before this, so the response carries the upstream's headers only.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {Record<keyof typeof DIRS, URL>} upstreams
 */
function forward(req, res, upstreams) {
  const id = active; // the upstream this request goes to, even if a /__switch arrives meanwhile
  const target = upstreams[id];
  const rawPath = (req.url ?? '/').split('?')[0];
  const upstreamReq = httpRequest({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: endToEnd(req.rawHeaders),
  });
  upstreamReq.on('response', (up) => {
    if (up.statusCode === 404) {
      notFound.push(`${req.method} ${rawPath} (${id})`);
      console.log(`update-proxy: 404 ${req.method} ${rawPath} (${id})`);
    }
    res.sendDate = false; // the upstream's own Date passes through; Node adds none
    res.writeHead(up.statusCode ?? 502, up.statusMessage, endToEnd(up.rawHeaders));
    up.pipe(res);
  });
  upstreamReq.on('error', (err) => {
    console.error(`update-proxy: upstream ${id} ${err.message}`);
    if (res.destroyed) return; // the client went away (the close handler below aborted this request)
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    setCommon(res);
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.writeHead(502).end(req.method === 'HEAD' ? undefined : 'Bad Gateway\n');
  });
  // A client that goes away before the response is complete: stop the upstream request too.
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });
  req.pipe(upstreamReq);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  /**
   * Ends the response with an error status and the errorCacheControl.
   * @param {number} status
   * @param {string} body
   */
  const error = (status, body) => {
    setCommon(res);
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.writeHead(status).end(req.method === 'HEAD' ? undefined : `${body}\n`);
  };

  if (url.pathname === '/__switch') {
    if (req.method !== 'GET') {
      setCommon(res);
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
    setCommon(res);
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/__404s') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      setCommon(res);
      res.setHeader('Allow', 'GET, HEAD');
      error(405, 'Method Not Allowed');
      return;
    }
    setCommon(res);
    res.setHeader('Cache-Control', HEADERS.errorCacheControl);
    res.setHeader('Content-Type', HEADERS.mime['.json'] ?? 'application/json');
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : JSON.stringify(notFound));
    return;
  }
  if (UPSTREAM !== null) {
    forward(req, res, UPSTREAM);
    return;
  }

  // Static mode.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    setCommon(res);
    res.setHeader('Allow', 'GET, HEAD');
    error(405, 'Method Not Allowed');
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
  setCommon(res);
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
  if (UPSTREAM === null) {
    console.log(`update-proxy: serving dist-e2e-v1/ (active) and dist-e2e-v2/ on http://localhost:${PORT}`);
  } else {
    console.log(
      `update-proxy: proxying to v1 ${UPSTREAM.v1.origin} (active) and v2 ${UPSTREAM.v2.origin} on http://localhost:${PORT}`,
    );
  }
});
