// The web app manifest (plan §4.7), passed to `VitePWA({ manifest })` in vite.config.ts, which writes it to
// dist/manifest.webmanifest and links it from index.html. scripts/manifest.test.ts deep-equals it against the
// plan's JSON.
//
// Never change `id` (a WebAPK update check is dropped if it changes) or `name` (Q8: "Talking Bear"; a WebAPK
// update field). Deliberately left out (plan §4.7): `shortcuts` (any change forces a WebAPK update),
// `prefer_related_applications` (routes to the Play Store path) and `display_override` (not needed).
//
// Not app code: nothing under src/ imports it, so it never reaches the bundle.

import type { ManifestOptions } from 'vite-plugin-pwa';

export const PWA_MANIFEST: Partial<ManifestOptions> = {
  id: '/',
  start_url: '/',
  scope: '/',
  name: 'Talking Bear',
  short_name: 'Talking Bear',
  lang: 'en',
  description:
    'Talk to Juni the bear and hear yourself back in a funny bear voice. Works offline; audio never leaves your device.',
  display: 'standalone',
  orientation: 'portrait',
  theme_color: '#2F7A6D',
  background_color: '#FFF4E0',
  launch_handler: { client_mode: 'focus-existing' },
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  screenshots: [
    {
      src: '/screenshots/phone-1.webp',
      sizes: '1080x1920',
      type: 'image/webp',
      form_factor: 'narrow',
      label: 'The bear listening',
    },
    {
      src: '/screenshots/phone-2.webp',
      sizes: '1080x1920',
      type: 'image/webp',
      form_factor: 'narrow',
      label: 'The bear talking back',
    },
    {
      src: '/screenshots/desktop-1.webp',
      sizes: '1920x1080',
      type: 'image/webp',
      form_factor: 'wide',
      label: 'Desktop',
    },
  ],
};
