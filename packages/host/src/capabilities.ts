/**
 * Default-open browser capabilities for hosted apps (#436, freeappstore#267/#284).
 *
 * The browser already asks the user before it grants the camera, microphone,
 * location, sensors and the rest, so the platform's headers do not block them
 * too: an app that needs one simply asks. Blocking in host headers only ever
 * broke working features (a creator removed a mic feature because of it).
 *
 * Every feature below is `=(self)` on the app's own origin. A cross-origin frame
 * the app embeds still gets nothing unless the app delegates it with `allow`,
 * and cross-origin embedding of the app itself stays limited by CSP
 * `frame-ancestors` (host.ts). Only features Chromium recognises are listed: an
 * unknown name logs a console warning on every page load.
 *
 * Creator docs: docs/app-capabilities.md (the capability matrix).
 */
export const HOSTED_APP_FEATURES = [
  "accelerometer",
  "ambient-light-sensor",
  "attribution-reporting",
  "autoplay",
  "bluetooth",
  "camera",
  "clipboard-read",
  "clipboard-write",
  "compute-pressure",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "gamepad",
  "geolocation",
  "gyroscope",
  "hid",
  "identity-credentials-get",
  "idle-detection",
  "local-fonts",
  "magnetometer",
  "microphone",
  "midi",
  "otp-credentials",
  "payment",
  "picture-in-picture",
  "publickey-credentials-create",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "storage-access",
  "usb",
  "web-share",
  "window-management",
  "xr-spatial-tracking",
] as const;

/**
 * A Permissions-Policy granting every feature to `self` (a hosted app), or to `*`
 * (a page that embeds app previews and must be able to delegate to them: self
 * plus whichever origin an iframe's `allow` names).
 */
export function openPermissionsPolicy(allowlist: "self" | "*" = "self"): string {
  const value = allowlist === "self" ? "(self)" : "*";
  return HOSTED_APP_FEATURES.map((f) => `${f}=${value}`).join(", ");
}

/**
 * The `allow` attribute for any iframe that previews a hosted app (the storefront,
 * the console, the QA runner): every feature delegated to the framed app's origin.
 * The browser still prompts the user before granting any of them.
 */
export const PREVIEW_IFRAME_ALLOW = HOSTED_APP_FEATURES.map((f) => `${f} 'src'`).join("; ");
