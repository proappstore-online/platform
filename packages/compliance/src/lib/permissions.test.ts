import { describe, expect, it } from 'vitest';
import { detectPermissions, detectPermissionsInSource, PERMISSION_IDS, validatePermissions } from './permissions.js';

const ids = (src: string) => [...detectPermissionsInSource(src)].sort();

describe('detectPermissionsInSource (#437)', () => {
  it.each<[string, string, string[]]>([
    ['getUserMedia audio only', 'navigator.mediaDevices.getUserMedia({ audio: true })', ['microphone']],
    ['getUserMedia video only', 'await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } })', ['camera']],
    ['getUserMedia both', 'getUserMedia({ video: true, audio: true })', ['camera', 'microphone']],
    ['getUserMedia with a variable', 'getUserMedia(constraints)', ['camera', 'microphone']],
    ['speech recognition', 'const r = new (window.SpeechRecognition || window.webkitSpeechRecognition)()', ['microphone']],
    ['screen share', 'navigator.mediaDevices.getDisplayMedia({ video: true })', ['screen-capture']],
    ['geolocation', 'navigator.geolocation.watchPosition(cb)', ['location']],
    ['motion event', "window.addEventListener('devicemotion', onMove)", ['motion']],
    ['orientation permission', 'DeviceOrientationEvent.requestPermission()', ['motion']],
    ['sensor class', 'const a = new Accelerometer({ frequency: 60 })', ['motion']],
    ['midi', 'navigator.requestMIDIAccess()', ['midi']],
    ['notifications', 'await Notification.requestPermission()', ['notifications']],
    ['push', 'registration.pushManager.subscribe(opts)', ['notifications']],
    ['SDK push', 'await app.notifications.subscribe()', ['notifications']],
    ['clipboard read', 'await navigator.clipboard.readText()', ['clipboard']],
    ['wake lock', "await navigator.wakeLock.request('screen')", ['wake-lock']],
    ['devices', 'navigator.bluetooth; navigator.usb.requestDevice(); navigator.serial; navigator.hid', ['bluetooth', 'hid', 'serial', 'usb']],
    ['payment', 'new PaymentRequest(methods, details)', ['payment']],
  ])('%s', (_label, src, expected) => {
    expect(ids(src)).toEqual(expected);
  });

  it('ignores comments, clipboard writes and lookalikes', () => {
    expect(ids('// navigator.geolocation.getCurrentPosition()\n/* getUserMedia({audio:true}) */')).toEqual([]);
    expect(ids("navigator.clipboard.writeText('x')")).toEqual([]);
    expect(ids('const geolocation = null; myMidi.requestAccess(); notifications.list()')).toEqual([]);
    expect(ids("const url = 'https://example.com/path'; navigator.geolocation")).toEqual(['location']);
  });
});

describe('detectPermissions (#437)', () => {
  it('scans app sources only, in catalogue order', () => {
    expect(detectPermissions([
      ['web/src/Call.tsx', 'getUserMedia({ video: true, audio: true })'],
      ['web/src/Map.tsx', 'navigator.geolocation.getCurrentPosition(cb)'],
      ['web/src/Call.test.tsx', 'navigator.requestMIDIAccess()'],
      ['e2e/tests/a.spec.ts', 'navigator.clipboard.readText()'],
      ['worker/src/index.ts', 'navigator.usb'],
      ['web/vite.config.ts', 'navigator.serial'],
      ['web/src/README.md', 'navigator.hid'],
    ])).toEqual(['microphone', 'camera', 'location']);
    expect(detectPermissions([])).toEqual([]);
  });
});

describe('validatePermissions (#437)', () => {
  it('accepts ids and { id, reason }; absent is empty', () => {
    expect(validatePermissions(undefined)).toEqual({ permissions: [] });
    expect(validatePermissions(['camera', { id: 'location', reason: '  Show nearby courts  ' }])).toEqual({
      permissions: [{ id: 'camera' }, { id: 'location', reason: 'Show nearby courts' }],
    });
  });

  it('refuses unknown ids, duplicates and unsafe or long reasons', () => {
    expect(validatePermissions({})).toEqual({ error: expect.stringMatching(/must be an array/) });
    expect(validatePermissions([{ id: 'telepathy' }])).toEqual({ error: expect.stringContaining(PERMISSION_IDS.join(', ')) });
    expect(validatePermissions(['camera', 'camera'])).toEqual({ error: expect.stringMatching(/declared twice/) });
    for (const reason of ['', 'a'.repeat(121), 'two\nlines', '<b>bold</b>', 5]) {
      expect(validatePermissions([{ id: 'camera', reason }]), String(reason)).toEqual({ error: expect.stringMatching(/reason/) });
    }
  });
});
