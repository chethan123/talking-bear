import { defineConfig } from '@playwright/test';

// The hook-free smoke test of the production image (issue #107, plan §7 M7 and §9 `image-smoke`): e2e/smoke/ only,
// against an image that is already running at BASE_URL (CI: `docker run … -p 8080:8080 bear:ci`). There is no
// webServer: the image under test is the server.
const baseURL = process.env.BASE_URL;
if (!baseURL) {
  throw new Error(
    'playwright.smoke.config.ts: set BASE_URL to the running image, e.g. BASE_URL=http://localhost:8080',
  );
}

export default defineConfig({
  testDir: 'e2e/smoke',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // audio runs in real time
  retries: 0, // a flaky smoke test is a bug, not noise
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: { baseURL, channel: 'chromium', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { channel: 'chromium' } }],
});
