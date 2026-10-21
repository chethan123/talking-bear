import { defineConfig } from '@playwright/test';

// E2E runs against the e2e-mode production build with the production headers (plan §4.9.3). Two targets:
// - Locally (no BASE_URL): `pnpm build:e2e` (`pnpm e2e` builds first) served by `vite preview` on 4173 with the
//   headers from server/headers.json, plus the update spec's proxy in static mode on 4174.
// - In CI (BASE_URL set; the `e2e` job, issue #108, plan §7 M7): the e2e-mode image itself, so the real server and
//   headers are under test. The job runs the image at BASE_URL and the v1/v2 images behind the update proxy in
//   upstream mode on 4174 (e2e/update-proxy.mjs --upstream), so neither 4173 nor 4174 is started here. Only the
//   installability spec's negative control (4175) still is, and it builds dist-e2e first: the runner has none.
const imageURL = process.env.BASE_URL;
/** BASE_URL names the image under test; an empty value counts as unset. */
const underImage = imageURL !== undefined && imageURL !== '';

const PREVIEW = {
  command: 'pnpm preview:e2e',
  url: 'http://localhost:4173',
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
  // pnpm runs the script in its own process group, so Playwright's default SIGKILL of pnpm's group
  // orphans `vite preview`, which keeps the pipe open and hangs the run. SIGTERM is forwarded by pnpm.
  gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
} as const;

const BAD_MANIFEST = {
  // The installability spec's negative control (issue #100): a copy of dist-e2e whose manifest has no
  // `purpose: "any"` icon, served by `vite preview` with the same config, so the same headers. It needs
  // dist-e2e: locally `pnpm e2e` builds it before Playwright starts; under BASE_URL the command is
  // prefixed with `pnpm build:e2e &&` (below), so it builds it first.
  command:
    'node e2e/fixtures/bad-manifest/make.mjs && vite preview --outDir dist-e2e-badmanifest --port 4175 --strictPort',
  url: 'http://localhost:4175',
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
} as const;

const UPDATE_PROXY = {
  // The update spec's one-origin server (issue #101): builds the v1 and v2 variants of the e2e build
  // (dist-e2e-v1/, dist-e2e-v2/), then serves the active one on port 4174 and flips it on /__switch.
  // The timeout covers the two builds.
  command: 'node scripts/build-update-variants.mjs && node e2e/update-proxy.mjs --port 4174',
  url: 'http://localhost:4174',
  reuseExistingServer: !process.env.CI,
  timeout: 120_000,
} as const;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // audio runs in real time; parallel workers starve each other
  retries: 0, // a flaky audio test is a bug, not noise
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: underImage ? imageURL : 'http://localhost:4173',
    channel: 'chromium',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
  webServer: underImage
    ? [
        {
          ...BAD_MANIFEST,
          // The timeout covers the e2e build.
          command: `pnpm build:e2e && ${BAD_MANIFEST.command}`,
          timeout: 120_000,
        },
      ]
    : [PREVIEW, BAD_MANIFEST, UPDATE_PROXY],
});
