import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts', '**/*.worklet.test.ts', 'docs/research/**', 'node_modules/**'],
        },
      },
      {
        test: {
          name: 'worklet',
          environment: 'node',
          include: ['src/**/*.worklet.test.ts'],
          setupFiles: ['test/worklet-scope.ts'],
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
