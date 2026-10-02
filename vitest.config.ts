import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// `pnpm test:coverage` passes `--coverage`. Under v8 coverage CPU-bound tests run 3–11× slower
// (measured for #33: voicing.test.ts "cost per call (informational)" 0.8 s → 5.5–5.7 s), so a
// coverage run gives every test that sets no timeout of its own 30 s instead of Vitest's 5 s
// default. Plain runs (`pnpm test`, `pnpm test:browser`) keep the default (`undefined`).
// Only the bare `--coverage` flag (as passed by `pnpm test:coverage`) is detected;
// `--coverage.enabled` keeps the default.
const coverageRun = process.argv.includes('--coverage');
const testTimeout = coverageRun ? 30_000 : undefined;

export default defineConfig({
  test: {
    // Off unless `--coverage` is passed. Plan §4.9.1: v8, ≥ 90 % lines and branches per glob on
    // the pure modules only; no global threshold (adapters are covered by Browser Mode and e2e).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.gen.ts', 'src/test-hooks.ts'],
      thresholds: {
        'src/dsp/**': { lines: 90, branches: 90 },
        'src/app/machine.ts': { lines: 90, branches: 90 },
        'src/app/settings.ts': { lines: 90, branches: 90 },
        'src/input/recognizer.ts': { lines: 90, branches: 90 },
        'src/anim/director.ts': { lines: 90, branches: 90 },
      },
    },
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts', '**/*.worklet.test.ts', 'docs/research/**', 'node_modules/**'],
          testTimeout,
        },
      },
      {
        test: {
          name: 'worklet',
          environment: 'node',
          include: ['src/**/*.worklet.test.ts'],
          setupFiles: ['test/worklet-scope.ts'],
          testTimeout,
        },
      },
      {
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: {
                channel: 'chromium',
                args: [
                  '--use-fake-device-for-media-stream',
                  '--use-fake-ui-for-media-stream',
                  '--autoplay-policy=no-user-gesture-required',
                  '--enable-precise-memory-info',
                  '--js-flags=--expose-gc',
                ],
              },
            }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
