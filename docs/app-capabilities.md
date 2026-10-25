# App capabilities

What a hosted app on `<app>.proappstore.online` (or its custom domain) may use in
the browser, and the platform limits around it. The rule is **default-open**
(#436): the platform does not block a browser feature in its headers. The
browser already asks the user before granting the camera, the microphone,
location, sensors and the rest, so a feature an app needs simply works once the
user agrees.

The source of truth is `packages/host/src/capabilities.ts` (Permissions-Policy)
and `securityHeaders()` in `packages/host/src/host.ts` (CSP). Tests pin every value.

## Browser features (Permissions-Policy)

Every feature below is `=(self)`: allowed on the app's own origin. The browser
still prompts where the feature needs consent.

| Feature | Use | User prompt |
|---|---|---|
| `camera`, `microphone` | `getUserMedia`, recording, video calls | yes |
| `display-capture` | `getDisplayMedia` (screen sharing) | yes |
| `geolocation` | `navigator.geolocation` | yes |
| `accelerometer`, `gyroscope`, `magnetometer`, `ambient-light-sensor` | motion and orientation sensors (`DeviceMotionEvent`, Generic Sensor API) | on iOS, `DeviceMotionEvent.requestPermission()` |
| `midi` | Web MIDI | yes |
| `usb`, `serial`, `hid`, `bluetooth` | WebUSB, Web Serial, WebHID, Web Bluetooth | yes (device chooser) |
| `clipboard-read`, `clipboard-write` | async Clipboard API | read: yes |
| `screen-wake-lock` | keep the screen on (`navigator.wakeLock`) | no |
| `web-share` | `navigator.share()` | no (needs a user gesture) |
| `fullscreen`, `picture-in-picture` | `requestFullscreen()`, PiP video | no (needs a user gesture) |
| `autoplay` | media playing without a gesture | browser policy |
| `encrypted-media` | EME (DRM video) | no |
| `xr-spatial-tracking` | WebXR | yes |
| `gamepad` | Gamepad API | no |
| `payment` | Payment Request API | yes |
| `publickey-credentials-create`, `publickey-credentials-get`, `otp-credentials`, `identity-credentials-get` | passkeys/WebAuthn, WebOTP, FedCM | yes |
| `idle-detection` | Idle Detection API | yes |
| `local-fonts` | Local Font Access | yes |
| `storage-access` | Storage Access API | yes |
| `window-management` | multi-screen window placement | yes |
| `compute-pressure`, `attribution-reporting` | Compute Pressure, Attribution Reporting | no |

**Tell users up front.** Declare the ones your app asks for in `mcp.json` `permissions` so its storefront listing shows them: see [App permissions](./app-permissions.md).

**Iframes your app embeds** get none of these unless you delegate them, for example
`<iframe src="https://partner.example" allow="camera; microphone">`.

## Inside a preview

A page that previews a hosted app (the storefront, the console, the QA runner)
frames it with `allow` delegating every feature above to the app's origin
(`PREVIEW_IFRAME_ALLOW`). Its own Permissions-Policy allows each feature to `*` so the
delegation takes effect. A mic, camera or motion app works in the preview, with
the same user prompts.

## What the page may load and connect to (CSP)

| Directive | Value | Means |
|---|---|---|
| `script-src` | `'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https:` | your bundle, inline scripts, any HTTPS CDN, WebAssembly, `blob:` scripts |
| `connect-src` | `'self' https: wss: data: blob:` | `fetch`/XHR/WebSocket/EventSource to any HTTPS or WSS API |
| `img-src` | `'self' data: blob: https:` | any HTTPS image, generated images |
| `media-src` | `'self' data: blob: mediastream: https:` | audio/video from anywhere over HTTPS, recordings (`blob:`), camera streams |
| `worker-src` | `'self' blob:` | Web Workers, the service worker, `blob:` workers |
| `frame-src` | `'self' https:` | embeds: maps (`app.maps.embedUrl`), video, payment widgets |
| `style-src` / `font-src` | `'self' 'unsafe-inline' https:` / `'self' data: https:` | any HTTPS stylesheet or font |
| `form-action` | `'self' https:` | forms may post to an HTTPS endpoint |
| `frame-ancestors` | `'self'` + PAS's own surfaces, plus the origins in your `embed.allow` | **who may frame your app**: off for other sites by default; opt in per origin with [`embed`](./mcp-app-tools.md#embedding-embed) |
| `base-uri` | `'self'` | |

Plain `http:` is not allowed anywhere (the app is served over HTTPS; a browser
blocks mixed content regardless).

## Not on by default

| Capability | Why | Status |
|---|---|---|
| `SharedArrayBuffer` / cross-origin isolation (COOP + COEP) | `Cross-Origin-Embedder-Policy: require-corp` breaks every cross-origin image, font or script that does not send CORP/CORS headers, which most apps use | **Opt-in per app:** declare `"isolation": "cross-origin"` (or `"cross-origin-strict"` for Safari) in `mcp.json` ([#452](https://github.com/proappstore-online/platform/issues/452); [what it does and what breaks](./mcp-app-tools.md#cross-origin-isolation-isolation)) |
| Being framed by other sites | clickjacking protection for your users | `frame-ancestors` lists PAS surfaces only. **Opt-in per app, for named origins:** declare `embed: { "allow": [...] }` in `mcp.json` ([#453](https://github.com/proappstore-online/platform/issues/453); [how, and the clickjacking trade-off](./mcp-app-tools.md#embedding-embed)) |

## An app's own `_headers` file

The host sets these headers itself and does not read a `_headers` file in the
app's build (that was a Cloudflare Pages convention). A `web/public/_headers`
in an app repo has no effect on PAS: neither loosening nor tightening.

## Platform limits

These are quotas, not browser blocks. The SDK reports a limit as an error.

| Service | Limit |
|---|---|
| Storage (`app.storage`) | 50 MB per file, 1,000 files per namespace |
| KV (`app.kv`) | 64 KB per value, 1,000 keys and 10 MB per user |
| Counters (`app.counters`) | 1,000 per app, key ≤ 128 chars, increment ≤ 1,000 |
| Rooms (`app.rooms`, WebSocket) | 32 peers per room, 4 KB per message, 100 messages/s |
| AI (`app.ai`) | 16,000-char prompt, 1,024 max tokens, 100 items per batch |
| Email | 100 per app per day (10 per recipient for notifications) |
| Web push | VAPID push via `app.notifications`; the browser prompts |
| App worker | 3 MB bundle, 50 modules, 30 s CPU, 500 subrequests per invocation |
| PWA install | supported: the template ships a manifest and service worker |
