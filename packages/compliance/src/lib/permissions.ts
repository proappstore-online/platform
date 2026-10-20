/**
 * App permissions (#437): what an app will ask the browser for, so a storefront
 * listing can say so up front and the prompt is no surprise.
 *
 * One catalogue and one detector, shared by `pas check` (the `permissions`
 * compliance check), the deploy pipeline (which reports what it detected) and the
 * platform (which validates declarations and serves the listing).
 */

export interface PermissionInfo {
  /** Stable id used in mcp.json `permissions` and in the API. */
  id: string;
  /** Plain name shown to users. */
  name: string;
  /** A small icon for the listing and the app card. */
  icon: string;
}

export const PERMISSION_CATALOGUE: readonly PermissionInfo[] = [
  { id: 'microphone', name: 'Microphone', icon: '🎤' },
  { id: 'camera', name: 'Camera', icon: '📷' },
  { id: 'screen-capture', name: 'Screen sharing', icon: '🖥️' },
  { id: 'location', name: 'Location', icon: '📍' },
  { id: 'motion', name: 'Motion sensors', icon: '📱' },
  { id: 'midi', name: 'MIDI devices', icon: '🎹' },
  { id: 'notifications', name: 'Notifications', icon: '🔔' },
  { id: 'clipboard', name: 'Read clipboard', icon: '📋' },
  { id: 'wake-lock', name: 'Keep screen on', icon: '💡' },
  { id: 'bluetooth', name: 'Bluetooth devices', icon: '🔵' },
  { id: 'usb', name: 'USB devices', icon: '🔌' },
  { id: 'serial', name: 'Serial devices', icon: '🔌' },
  { id: 'hid', name: 'Game controllers & HID devices', icon: '🎮' },
  { id: 'payment', name: 'Payments', icon: '💳' },
  { id: 'idle-detection', name: 'Idle detection', icon: '⏱️' },
  { id: 'local-fonts', name: 'Installed fonts', icon: '🔤' },
];

export const PERMISSION_IDS: readonly string[] = PERMISSION_CATALOGUE.map((p) => p.id);
const BY_ID = new Map(PERMISSION_CATALOGUE.map((p) => [p.id, p]));
export function permissionInfo(id: string): PermissionInfo | undefined {
  return BY_ID.get(id);
}

/** API usage that implies a permission. Matched on comment-stripped source. */
const DETECTORS: ReadonlyArray<[string, RegExp]> = [
  ['microphone', /\b(?:webkit)?SpeechRecognition\b/],
  ['screen-capture', /\bgetDisplayMedia\s*\(/],
  ['location', /\bnavigator\s*\.\s*geolocation\b/],
  ['motion', /\bDevice(?:Motion|Orientation)Event\b|['"`]device(?:motion|orientation)(?:absolute)?['"`]|\bnew\s+(?:Accelerometer|LinearAccelerationSensor|Gyroscope|Magnetometer|AbsoluteOrientationSensor|RelativeOrientationSensor|GravitySensor)\s*\(/],
  ['midi', /\brequestMIDIAccess\s*\(/],
  ['notifications', /\bNotification\s*\.\s*requestPermission\s*\(|\bpushManager\s*\.\s*subscribe\s*\(|\bnotifications\s*\.\s*subscribe\s*\(/],
  ['clipboard', /\bclipboard\s*\.\s*read(?:Text)?\s*\(/],
  ['wake-lock', /\bwakeLock\s*\.\s*request\s*\(/],
  ['bluetooth', /\bnavigator\s*\.\s*bluetooth\b/],
  ['usb', /\bnavigator\s*\.\s*usb\b/],
  ['serial', /\bnavigator\s*\.\s*serial\b/],
  ['hid', /\bnavigator\s*\.\s*hid\b/],
  ['payment', /\bnew\s+PaymentRequest\s*\(/],
  ['idle-detection', /\bIdleDetector\b/],
  ['local-fonts', /\bqueryLocalFonts\s*\(/],
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/**
 * The permissions one source file uses. getUserMedia is split by its
 * constraints: `audio` → microphone, `video` → camera, both when it cannot tell.
 */
export function detectPermissionsInSource(source: string): Set<string> {
  const code = stripComments(source);
  const found = new Set<string>();
  for (const [id, re] of DETECTORS) if (re.test(code)) found.add(id);
  for (const m of code.matchAll(/\bgetUserMedia\s*\(([^)]{0,300})/g)) {
    const args = m[1] ?? '';
    const audio = /\baudio\b/.test(args);
    const video = /\bvideo\b/.test(args);
    if (audio || !video) found.add('microphone');
    if (video || !audio) found.add('camera');
  }
  return found;
}

/** Source files an app ships to the browser; tests, configs and tooling excluded. */
export function isAppSourcePath(path: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|vue|svelte|html)$/.test(path)) return false;
  if (/(?:^|\/)(?:node_modules|dist|build|coverage|e2e|tests?|__tests__|scripts|worker|marketing)\//.test(path)) return false;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || /(?:^|\/)(?:vite|vitest|playwright|eslint|tailwind|postcss)\.config\./.test(path)) return false;
  return true;
}

/** The catalogue ids detected across an app's sources, in catalogue order. */
export function detectPermissions(files: Iterable<[path: string, source: string]>): string[] {
  const found = new Set<string>();
  for (const [path, source] of files) {
    if (!isAppSourcePath(path)) continue;
    for (const id of detectPermissionsInSource(source)) found.add(id);
  }
  return PERMISSION_IDS.filter((id) => found.has(id));
}

export interface DeclaredPermission { id: string; reason?: string }
export const MAX_PERMISSION_REASON = 120;

/** Validate mcp.json `permissions`. Absent is an empty list. */
export function validatePermissions(raw: unknown): { error: string } | { permissions: DeclaredPermission[] } {
  if (raw === undefined || raw === null) return { permissions: [] };
  if (!Array.isArray(raw)) return { error: 'permissions must be an array of { id, reason? }' };
  const out: DeclaredPermission[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `permissions[${i}]`;
    const e = typeof entry === 'string' ? { id: entry } : entry;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return { error: `${at} must be an object { id, reason? } or an id` };
    const { id, reason } = e as { id?: unknown; reason?: unknown };
    if (typeof id !== 'string' || !BY_ID.has(id)) return { error: `${at}.id must be one of: ${PERMISSION_IDS.join(', ')}` };
    if (out.some((p) => p.id === id)) return { error: `${at}: ${id} is declared twice` };
    if (reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_PERMISSION_REASON || /[\r\n<>]/.test(reason))) {
      return { error: `${at}.reason must be one line of plain text, at most ${MAX_PERMISSION_REASON} characters` };
    }
    out.push(reason === undefined ? { id } : { id, reason: (reason as string).trim() });
  }
  return { permissions: out };
}
