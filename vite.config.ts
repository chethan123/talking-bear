import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { PWA_MANIFEST } from './src/pwa-manifest.ts';

// server/headers.json is the single source of the app's response headers (plan §4.8.3, §4.9.3);
// the Go server loads the same file. Of Vite's servers only `vite preview` sends them. The dev
// server stays header-free: it injects <style> tags, which the production CSP blocks.
function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/** headers.json's two header maps: `common` on every response, `htmlOnly` added on text/html responses. */
interface PreviewHeaders {
  common: Record<string, string>;
  htmlOnly: Record<string, string>;
}

function readHeaders(): PreviewHeaders {
  const parsed: unknown = JSON.parse(readFileSync(new URL('./server/headers.json', import.meta.url), 'utf8'));
  const obj = typeof parsed === 'object' && parsed !== null ? parsed : {};
  const common = 'common' in obj ? obj.common : null;
  const htmlOnly = 'htmlOnly' in obj ? obj.htmlOnly : null;
  if (!isStringMap(common)) {
    throw new Error('server/headers.json: "common" must map header names to string values');
  }
  if (!isStringMap(htmlOnly)) {
    throw new Error('server/headers.json: "htmlOnly" must map header names to string values');
  }
  return { common, htmlOnly };
}

const HEADERS = readHeaders();

/**
 * The header fields `vite preview` sets on a text/html response on top of the common ones, by the Go server's rule
 * (server/headers.go `htmlHeaders`; plan §4.8.3, issue #121): every `htmlOnly` header, except that one `common` also
 * names (compared case-insensitively) is merged into the common value as `common + '; ' + htmlOnly`, so it is sent
 * once. A browser enforces every CSP field it receives as a separate policy.
 */
function htmlHeaderFields(
  common: Record<string, string>,
  htmlOnly: Record<string, string>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(htmlOnly)) {
    const base = Object.entries(common).find(([c]) => c.toLowerCase() === name.toLowerCase())?.[1];
    fields[name] = base === undefined ? value : `${base}; ${value}`;
  }
  return fields;
}

/** The Content-Type a `writeHead(status, [message], [headers])` call sends: its headers argument wins over setHeader. */
function contentTypeOf(res: ServerResponse, args: readonly unknown[]): string {
  for (const arg of args.slice(1)) {
    if (Array.isArray(arg)) {
      // The flat [name, value, name, value, …] form.
      for (let i = 0; i + 1 < arg.length; i += 2) {
        const name: unknown = arg[i];
        const value: unknown = arg[i + 1];
        if (typeof name === 'string' && name.toLowerCase() === 'content-type' && typeof value === 'string') {
          return value;
        }
      }
    } else if (typeof arg === 'object' && arg !== null) {
      for (const [name, value] of Object.entries(arg)) {
        if (name.toLowerCase() === 'content-type' && typeof value === 'string') return value;
      }
    }
  }
  const set = res.getHeader('content-type');
  return typeof set === 'string' ? set : '';
}

/**
 * Sets the HTML header fields (`htmlHeaderFields`) on `vite preview`'s text/html responses, as the Go server does
 * (plan §4.8.3: the Trusted Types directives go on HTML only; on worker scripts they would break `importScripts`).
 * `preview.headers` keeps sending the common ones on every response. The Content-Type is only known when a later
 * middleware (sirv, or Vite's index.html fallback) writes the head, so `writeHead` is wrapped; an implicit head
 * (`res.end()` without `writeHead`) goes through it too. The fields are set, like the Go server's `Header.Set`: a
 * merged field replaces the common one (one CSP field, never two), any other is added.
 *
 * Vite skips its own "Did you build your project?" check as soon as any plugin defines `configurePreviewServer`,
 * so this plugin makes the same check, with Vite 8.3.1's message: a preview without a build fails at once instead of
 * serving 404s.
 */
function htmlOnlyHeaders(fields: Record<string, string>): Plugin {
  let outDir = '';
  let distDir = '';
  return {
    name: 'bear-html-only-headers',
    configResolved(config) {
      outDir = config.build.outDir;
      distDir = resolve(config.root, outDir);
    },
    configurePreviewServer(server) {
      if (!existsSync(distDir)) {
        throw new Error(`The directory "${outDir}" does not exist. Did you build your project?`);
      }
      server.middlewares.use((_req, res, next) => {
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (...args: unknown[]): ServerResponse => {
          if (!res.headersSent && /^text\/html\b/i.test(contentTypeOf(res, args))) {
            for (const [name, value] of Object.entries(fields)) res.setHeader(name, value);
          }
          Reflect.apply(writeHead, res, args);
          return res;
        };
        next();
      });
    },
  };
}

// The build id (issue #101): `BEAR_BUILD_ID` names a build, e.g. the update spec's v1 and v2 variants
// (scripts/build-update-variants.mjs) or the CI images (#108); 'dev' when unset. It is put on <html> as
// `data-build`, so `document.documentElement.dataset.build` tells which build a page runs (the update spec reads
// it), and is defined as `__BUILD_ID__` for app code (none reads it yet; a reader declares
// `declare const __BUILD_ID__: string;` in src/vite-env.d.ts). It goes into HTML, so it is restricted to letters,
// digits, '.', '_' and '-'.
const BUILD_ID = process.env.BEAR_BUILD_ID ?? 'dev';
if (!/^[\w.-]+$/.test(BUILD_ID)) {
  throw new Error(`BEAR_BUILD_ID must match [A-Za-z0-9_.-]+, got ${JSON.stringify(BUILD_ID)}`);
}

/** Adds `data-build="<BUILD_ID>"` to index.html's <html> element. */
function buildIdAttribute(): Plugin {
  return {
    name: 'bear-build-id',
    transformIndexHtml: (html) => html.replace(/<html\b/, `<html data-build="${BUILD_ID}"`),
  };
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  preview: {
    headers: HEADERS.common,
  },
  plugins: [
    buildIdAttribute(),
    htmlOnlyHeaders(htmlHeaderFields(HEADERS.common, HEADERS.htmlOnly)),
    // The service worker and the manifest (plan §4.7): generateSW in prompt mode, registered by
    // src/pwa/register.ts through `virtual:pwa-register` (no injected <script>, so nothing inline under the CSP).
    VitePWA({
      injectRegister: false, // no inline <script>; register.ts imports virtual:pwa-register
      registerType: 'prompt', // we choose when to activate (register.ts, plan §4.7 update flow)
      includeManifestIcons: false,
      manifest: PWA_MANIFEST,
      workbox: {
        // Workbox's default is js,wasm,css,html only. txt: public/licenses.txt is precached too (plan §7 M2).
        globPatterns: ['**/*.{html,js,css,webmanifest,png,svg,webp,bin,json,txt}'],
        globIgnores: ['**/*.{br,gz,map}', 'screenshots/**'], // screenshots only matter to the installer
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024, // the default; Workbox skips larger files (check-dist, #99)
        inlineWorkboxRuntime: true, // a single sw.js, no importScripts
        // Prompt mode doesn't claim clients, so the first page would stay uncontrolled. Safe: updates still wait
        // for SKIP_WAITING. navigateFallback 'index.html' and cleanupOutdatedCaches are plugin defaults.
        clientsClaim: true,
      },
    }),
  ],
});
