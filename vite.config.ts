import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
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
  plugins: [
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
