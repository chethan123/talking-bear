import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  
  worker: { format: 'es' },
  plugins: [VitePWA({
    injectRegister: false,
    registerType: 'prompt',
    includeManifestIcons: false,
    manifest: { id: '/', start_url: '/', scope: '/', name: 'Talking Bear', short_name: 'Bear', display: 'standalone',
      icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }] },
    workbox: {
      globPatterns: ['**/*.{html,js,css,webmanifest,png,svg,webp,bin,json}'],
      globIgnores: ['**/*.{br,gz,map}', 'screenshots/**'],
      maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
      inlineWorkboxRuntime: true,
    },
  })],
});
