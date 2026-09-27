import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

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

function readCommonHeaders(): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(new URL('./server/headers.json', import.meta.url), 'utf8'));
  const common = typeof parsed === 'object' && parsed !== null && 'common' in parsed ? parsed.common : null;
  if (!isStringMap(common)) {
    throw new Error('server/headers.json: "common" must map header names to string values');
  }
  return common;
}

export default defineConfig({
  build: {
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  preview: {
    headers: readCommonHeaders(),
  },
});
