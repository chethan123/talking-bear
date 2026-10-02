// @vite-pwa/assets-generator 2.0.0 config (plan §4.7, §8; docs/icons.md). Run once, by hand, from the repo root:
// `pnpm dlx @vite-pwa/assets-generator@2.0.0`. The generator is not a dependency and CI never runs it, so this
// file imports nothing from it: a plain object in the shape of its UserConfig. It emits exactly
// public/icons/icon-192.png, icon-512.png (purpose any) and maskable-512.png (purpose maskable).
type AssetType = 'transparent' | 'maskable' | 'apple';

export default {
  images: ['art/icon.svg'],
  preset: {
    // purpose any: the teal disc on a transparent square, 5 % padding (the generator's default).
    transparent: { sizes: [192, 512], padding: 0.05 },
    // purpose maskable: full-bleed teal; art/icon.svg already keeps the head inside the 40 % safe zone.
    maskable: { sizes: [512], padding: 0, resizeOptions: { fit: 'contain', background: '#2F7A6D' } },
    apple: { sizes: [] },
    // The generator writes next to the source image (art/), so the names step over to public/icons/.
    assetName: (type: AssetType, size: { width: number }): string =>
      `../public/icons/${type === 'maskable' ? 'maskable' : 'icon'}-${size.width}.png`,
  },
  manifestIconsEntry: false,
};
