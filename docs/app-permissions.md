# App permissions on the storefront

Every app's storefront listing says up front what it will ask the browser for:
the microphone, camera, location, motion sensors, notifications and so on. When
the browser's prompt appears, it is no surprise (#437).

All browser features are open to hosted apps (see [App capabilities](./app-capabilities.md));
the browser asks the user before granting the ones below. The listing tells the
user which ones your app will ask for, and why.

## Declare them in `mcp.json`

```json
{
  "tools": [ ... ],
  "permissions": [
    { "id": "microphone", "reason": "Record voice notes" },
    { "id": "location", "reason": "Show courts near you" },
    "notifications"
  ]
}
```

- `id` is one from the table below. The reason is optional: **one line of plain
  text, at most 120 characters**, shown under the permission on the listing.
  Write it for the user ("Record voice notes"), not for a reviewer.
- The list registers with your tools on every deploy, so it changes with the
  repo. An unknown id or an unsafe reason fails registration (400).

| `id` | Shown as | Detected from |
|---|---|---|
| `microphone` | 🎤 Microphone | `getUserMedia({ audio })`, `SpeechRecognition` |
| `camera` | 📷 Camera | `getUserMedia({ video })` |
| `screen-capture` | 🖥️ Screen sharing | `getDisplayMedia()` |
| `location` | 📍 Location | `navigator.geolocation` |
| `motion` | 📱 Motion sensors | `DeviceMotionEvent`, `DeviceOrientationEvent`, `devicemotion`/`deviceorientation` listeners, `Accelerometer`, `Gyroscope`, … |
| `midi` | 🎹 MIDI devices | `navigator.requestMIDIAccess()` |
| `notifications` | 🔔 Notifications | `Notification.requestPermission()`, `pushManager.subscribe()`, `app.notifications.subscribe()` |
| `clipboard` | 📋 Read clipboard | `navigator.clipboard.read()` / `readText()` (writing needs no prompt) |
| `wake-lock` | 💡 Keep screen on | `navigator.wakeLock.request()` |
| `bluetooth` | 🔵 Bluetooth devices | `navigator.bluetooth` |
| `usb` | 🔌 USB devices | `navigator.usb` |
| `serial` | 🔌 Serial devices | `navigator.serial` |
| `hid` | 🎮 Game controllers & HID devices | `navigator.hid` |
| `payment` | 💳 Payments | `new PaymentRequest()` |
| `idle-detection` | ⏱️ Idle detection | `IdleDetector` |
| `local-fonts` | 🔤 Installed fonts | `queryLocalFonts()` |

## Detection

The platform also reads your code, so a listing is right even if you forget:

- **`pas check`** (and your app's CI) runs the `permissions` compliance check. It
  **warns** for each permission your browser code uses that `mcp.json` does not
  declare, and prints the line to add. It never fails a build.
- **`pas permissions`** lists what your code uses (`--json` for the ids).
- **Every deploy** reports what it detected to the platform (the shared deploy
  pipeline does this keyless; nothing to configure).

Detection reads the app's browser sources under the repo. It skips tests, e2e,
configs, `node_modules`, the app worker (`worker/`, which runs on the server)
and the marketing site. A permission requested in a way the patterns cannot see
(built dynamically, or only in a minified dependency) is not detected: declare it.

## What the listing shows

**Declared ∪ detected**, in the order of the table above:

- A declared permission shows its reason.
- A detected but undeclared one shows without a reason. Declare it to say why.
- A declared one the detector did not find still shows: you know your app.
- None of either: **"No special permissions"**.

App cards on the storefront show the same permissions as a compact icon row.

API: `GET /v1/storefront/apps/:id` returns
`permissions: [{ id, name, icon, reason, source }]` (`source` is `declared`,
`detected` or `both`); `GET /v1/storefront/apps` returns each app's `permissions`
ids for its card.
