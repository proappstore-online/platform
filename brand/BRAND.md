# ProAppStore brand

Kit version **2026-11-18**. Canonical source: [`serge-ivo/stores-workspace` `brand/`](https://github.com/serge-ivo/stores-workspace/tree/main/brand). This repo vendors the exact PAS export in [`brand/assets/`](assets/).

## Identity

- **Name:** ProAppStore, one PascalCase word. Colour **App** with the accent.
- **Symbol:** four offset rounded tiles, shared with FreeAppStore. No letter A/P, envelope or lightning icon.
- **Wordmark:** Manrope 800, outlined in the SVGs so it does not depend on installed fonts.
- **Colours:** accent `#7c3aed`; hover `#6d28d9`; dark-surface accent `#a78bfa`; light tint `#f5f3ff`.
- **Typography:** Manrope for UI, Fraunces for editorial headings.

## Assets

| File | Use |
|---|---|
| `favicon.svg` | Standalone rounded icon; browser favicon and header icon |
| `mark.svg` / `mark-mono.svg` | Transparent glyph, in colour or `currentColor` |
| `wordmark-light.svg` / `wordmark-dark.svg` | Complete outlined wordmark for light and dark surfaces |
| `icon-{16,32,48,64,128,180,192,512}.png` | Raster icons; 192 and 512 are the PWA manifest icons |
| `apple-touch-icon.png` | iOS home-screen icon (same bytes as `icon-180.png`) |
| `og-image.svg` / `og-image.png` | 1200×630 platform share card |
| `brand.json` | Kit version and colour/identity provenance |

## Usage rules

- Header: a 28–40px icon with the accessible full name beside it.
- Decorative images next to the name use `alt=""`. A symbol-only link or control needs the full name as its accessible label.
- `icon-192.png` and `icon-512.png` are opaque, full-bleed maskable exports. Do not use them as a square header badge.
- Copy the exports. Never redraw the symbol or letters, abbreviate the name, or add a space to it.
- Individual apps keep their own names, icons and palettes. The catalogue, Console, Dashboard and platform docs share this identity.

## Where it ships

- **This repo, `docs/public/`** (8 files, served at `docs.proappstore.online`): `favicon.svg`, `favicon-16x16.png` (kit `icon-16.png`), `favicon-32x32.png` (kit `icon-32.png`), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `og-image.png`, `brand.json`.
- **This repo, `packages/admin/src/publish.ts`:** the favicon SVG is embedded as a string in the knowledge-base workflow that the admin worker writes into app repos.
- **`proappstore-online/proappstore`** (storefront): 8 served files at the repo root plus the full export in `brand/assets/`. Its pages and manifest reference them with the `?v=2026-11-18` cache parameter.
- **`proappstore-online/console`:** `web/public/`.
- **`proappstore-online/dashboard`:** `web/public/`.

## Store-specific notes

- Theme behaviour and neutral surfaces follow the shared `DESIGN-SYSTEM.md` contract; app-facing UI rules are in [`docs/ui.md`](../docs/ui.md).
- Platform product policy, analytics and pricing belong in their current product documents, not this visual guide.

## Updating

1. Change the master in the workspace kit (`brand/` in `serge-ivo/stores-workspace`) and regenerate it there.
2. Copy the PAS export to `brand/assets/` here and to every surface listed above, including the string in `packages/admin/src/publish.ts`.
3. Bump the `?v=` parameter wherever it is used.
4. Run `python3 brand/check-copies.py` in the workspace.
5. Land each repo through its normal main-branch workflow.
