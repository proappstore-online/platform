# Play listing: ProAppStore (Android companion)

Proposed text for Play Console (#665); Serge pastes it in #666. The wording follows #661: a companion for
ProAppStore web apps, never called an app store, with user-started sessions (#668).

| Field | Value |
|---|---|
| App name | `ProAppStore` |
| Category | Health & Fitness (matches the background-location feature declaration and the Health apps answer, #662) |
| App icon | `icon-512.png`: 512×512, 32-bit PNG with alpha |
| Feature graphic | `feature-graphic.png`: 1024×500, 24-bit PNG |
| Phone screenshots | `screenshots/1-store.png` … `6-settings.png`: six 1080×2400 24-bit PNGs rendered from fixture state by `PlayScreenshots` (#665 item 4); no real place, name or email |

## Short description (78 of 80 characters)

```
Record runs and routes for your ProAppStore apps, even with your phone locked.
```

## Full description

```
ProAppStore keeps your ProAppStore web apps working while your phone is locked.

Tap Start for Run, Ski or Rideshare (in ProAppStore, or from the app itself), then put your phone away. While you share, ProAppStore records your location with the screen locked and sends it only to the apps you chose, so your route is complete when you open the app again.

• You choose each app. Each one explains what it receives before you turn it on.
• See what each app received today, what is waiting to upload, and a 30-day history that stays on your phone.
• Stop sharing from the notification or the app. Sharing also stops by itself after 30 minutes without moving, or after 12 hours.
• Disconnect your phone to delete its data from ProAppStore.
• Browse ProAppStore apps and open them in your browser.

Your location is never sold or used for advertising. ProAppStore deletes its copies of your location after 7 days.

Sign in with the Google or GitHub account you use in your ProAppStore apps.
```

## How the images are made

Both images are rendered from the workspace brand kit (`stores-workspace/brand/generate.py`), never edited by hand:

- `icon-512.png` is `exports()`'s `icon-512` composition, `svg(tile(brand, maskable=True))`, rendered by CairoSVG
  2.9.0 at 512×512 and saved RGBA. Its colour pixels are identical to the kit's `assets/pas/icon-512.png`, which is RGB.
- `feature-graphic.png` is `social()`'s `og-image` layout (surface `#f8fafc`, accent circles, `tile(brand)`, the
  `letters()` wordmark and accent rule) at 1024×500, with the tagline "Your apps, with your phone locked" in place of the
  domain, rendered by CairoSVG and flattened to RGB.

The kit has no 1024×500 export yet. Until a `feature(brand)` export is added to `generate.py`, re-render both from the
kit rather than editing these files.
