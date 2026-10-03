import { defineConfig } from '@playwright/test';

// E2E runs against the e2e-mode production build (`pnpm build:e2e`) served by `vite preview` with the
// production headers from server/headers.json (plan §4.9.3). `pnpm e2e` builds first.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // audio runs in real time; parallel workers starve each other
  retries: 0, // a flaky audio test is a bug, not noise
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: 'http://localhost:4173', channel: 'chromium', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  webServer: [
    {
      command: 'pnpm preview:e2e',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      // pnpm runs the script in its own process group, so Playwright's default SIGKILL of pnpm's group
      // orphans `vite preview`, which keeps the pipe open and hangs the run. SIGTERM is forwarded by pnpm.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      // The installability spec's negative control (issue #100): a copy of dist-e2e whose manifest has no
      // `purpose: "any"` icon, served by `vite preview` with the same config, so the same headers. It needs
      // dist-e2e, which `pnpm e2e` (and CI's e2e job) builds before Playwright starts.
      command:
        'node e2e/fixtures/bad-manifest/make.mjs && vite preview --outDir dist-e2e-badmanifest --port 4175 --strictPort',
      url: 'http://localhost:4175',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // The update spec's one-origin server (issue #101): builds the v1 and v2 variants of the e2e build
      // (dist-e2e-v1/, dist-e2e-v2/), then serves the active one on port 4174 and flips it on /__switch.
      // The timeout covers the two builds.
      command: 'node scripts/build-update-variants.mjs && node e2e/update-proxy.mjs --port 4174',
      url: 'http://localhost:4174',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
