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
  webServer: {
    command: 'pnpm preview:e2e',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // pnpm runs the script in its own process group, so Playwright's default SIGKILL of pnpm's group
    // orphans `vite preview`, which keeps the pipe open and hangs the run. SIGTERM is forwarded by pnpm.
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
