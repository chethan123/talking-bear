// The web app manifest (src/pwa-manifest.ts) is exactly plan §4.7's JSON, inlined below. It reads no build
// output: CI's `verify` runs the tests before `pnpm build` (#99 checks the built dist/manifest.webmanifest).
import { describe, expect, it } from 'vitest';

import { PWA_MANIFEST } from '../src/pwa-manifest.ts';

/** Plan §4.7 "Manifest", verbatim. */
const PLAN_MANIFEST = {
  id: '/',
  start_url: '/',
  scope: '/',
  name: 'Talking Bear',
  short_name: 'Talking Bear',
  lang: 'en',
  description:
    'Talk to Juni the bear or Fenn the duckling and hear yourself back in a funny voice. Works offline; audio never leaves your device.',
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
      src: '/screenshots/phone-3.webp',
      sizes: '1080x1920',
      type: 'image/webp',
      form_factor: 'narrow',
      label: 'The duckling talking back',
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

describe('PWA_MANIFEST (plan §4.7)', () => {
  it('deep-equals the plan JSON', () => {
    expect(PWA_MANIFEST).toStrictEqual(PLAN_MANIFEST);
  });

  it("is named 'Talking Bear' (Q8)", () => {
    expect(PWA_MANIFEST.name).toBe('Talking Bear');
    expect(PWA_MANIFEST.short_name).toBe('Talking Bear');
  });

  it('leaves out shortcuts, prefer_related_applications and display_override', () => {
    expect(Object.keys(PWA_MANIFEST)).not.toContain('shortcuts');
    expect(Object.keys(PWA_MANIFEST)).not.toContain('prefer_related_applications');
    expect(Object.keys(PWA_MANIFEST)).not.toContain('display_override');
  });
});
