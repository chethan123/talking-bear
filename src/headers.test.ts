import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Mirrors the Go server's parsed shape (plan §4.8.3): Common/HTMLOnly map[string]string,
// CacheControl []{Match, Value string}, ErrorCacheControl string, MIME map[string]string.
interface CacheRule {
  match: string;
  value: string;
}

interface HeadersJson {
  common: Record<string, string>;
  htmlOnly: Record<string, string>;
  cacheControl: CacheRule[];
  errorCacheControl: string;
  mime: Record<string, string>;
}

const CSP =
  "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

// Plan §4.8.3: the Trusted Types directives, on HTML responses only: Report-Only in M7, enforced from M8 (issue #121).
const TRUSTED_TYPES = "require-trusted-types-for 'script'; trusted-types default";

// Issue #121: the one CSP field of text/html responses, the common CSP with the Trusted Types directives merged in.
const HTML_CSP =
  "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types default";

const PERMISSIONS_POLICY =
  'microphone=(self), screen-wake-lock=(self), autoplay=(self), fullscreen=(self), camera=(), geolocation=(), display-capture=(), usb=(), serial=(), midi=(), payment=(), accelerometer=(), gyroscope=(), magnetometer=(), idle-detection=(), publickey-credentials-get=(), browsing-topics=()';

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isCacheRule(value: unknown): value is CacheRule {
  return (
    isObject(value) &&
    'match' in value &&
    'value' in value &&
    typeof value.match === 'string' &&
    typeof value.value === 'string'
  );
}

function isCacheRules(value: unknown): value is CacheRule[] {
  return Array.isArray(value) && value.every((rule) => isCacheRule(rule));
}

const raw: unknown = JSON.parse(readFileSync(new URL('../server/headers.json', import.meta.url), 'utf8'));

function loadHeaders(): HeadersJson {
  if (
    isObject(raw) &&
    'common' in raw &&
    'htmlOnly' in raw &&
    'cacheControl' in raw &&
    'errorCacheControl' in raw &&
    'mime' in raw &&
    isStringMap(raw.common) &&
    isStringMap(raw.htmlOnly) &&
    isCacheRules(raw.cacheControl) &&
    typeof raw.errorCacheControl === 'string' &&
    isStringMap(raw.mime)
  ) {
    return {
      common: raw.common,
      htmlOnly: raw.htmlOnly,
      cacheControl: raw.cacheControl,
      errorCacheControl: raw.errorCacheControl,
      mime: raw.mime,
    };
  }
  throw new Error('server/headers.json does not match the documented schema');
}

describe('server/headers.json', () => {
  it('has exactly the documented top-level keys and value types', () => {
    expect(isObject(raw) ? Object.keys(raw) : raw).toStrictEqual([
      'common',
      'htmlOnly',
      'cacheControl',
      'errorCacheControl',
      'mime',
    ]);
    expect(loadHeaders).not.toThrow();
  });

  it('sets the exact production CSP, without wasm-unsafe-eval', () => {
    const csp = loadHeaders().common['Content-Security-Policy'];
    expect(csp).toBe(CSP);
    expect(csp).not.toContain('wasm-unsafe-eval');
  });

  it('sets the exact Permissions-Policy, without hid or bluetooth', () => {
    const policy = loadHeaders().common['Permissions-Policy'];
    expect(policy).toBe(PERMISSIONS_POLICY);
    expect(policy).not.toMatch(/\b(hid|bluetooth)=/);
  });

  it('has exactly the common headers of plan §4.8.3', () => {
    const headers = loadHeaders();
    expect(headers.common).toStrictEqual({
      'Content-Security-Policy': CSP,
      'Permissions-Policy': PERMISSIONS_POLICY,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
  });

  it('enforces Trusted Types on HTML only: htmlOnly adds the TT directives to the CSP (plan §4.8.3, §7 M8)', () => {
    const headers = loadHeaders();
    expect(headers.htmlOnly).toStrictEqual({ 'Content-Security-Policy': TRUSTED_TYPES });
    // The Go server and vite preview merge a same-name htmlOnly header into the common value: one CSP field.
    expect(
      `${headers.common['Content-Security-Policy']}; ${headers.htmlOnly['Content-Security-Policy']}`,
    ).toBe(HTML_CSP);
    // Not in the common headers: on worker scripts the TT directives would break importScripts.
    expect(Object.values(headers.common).join('\n')).not.toContain('trusted-types');
  });

  it('serves .wasm as application/wasm with no parameters', () => {
    expect(loadHeaders().mime['.wasm']).toBe('application/wasm');
  });

  it('has the documented MIME table', () => {
    expect(loadHeaders().mime).toStrictEqual({
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.wasm': 'application/wasm',
      '.bin': 'application/octet-stream',
      '.onnx': 'application/octet-stream',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
      '.wav': 'audio/wav',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8',
    });
  });

  it('ends the cacheControl rules with the ** catch-all', () => {
    expect(loadHeaders().cacheControl.at(-1)).toStrictEqual({ match: '**', value: 'no-cache' });
  });

  it('has the documented cacheControl rules (first match wins) and error Cache-Control', () => {
    const headers = loadHeaders();
    expect(headers.cacheControl).toStrictEqual([
      { match: '/assets/**', value: 'public, max-age=31536000, immutable' },
      { match: '/', value: 'no-cache' },
      { match: '/index.html', value: 'no-cache' },
      { match: '/sw.js', value: 'no-cache' },
      { match: '/manifest.webmanifest', value: 'no-cache' },
      { match: '**', value: 'no-cache' },
    ]);
    expect(headers.errorCacheControl).toBe('no-store');
  });
});
