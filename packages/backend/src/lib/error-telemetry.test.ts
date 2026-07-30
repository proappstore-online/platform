import { describe, expect, it } from 'vitest';
import {
  ERROR_BLOB_COLUMNS,
  PLATFORM_INDEX,
  fingerprint,
  normalizeStack,
  recordServerError,
  redact,
} from './error-telemetry.js';

type Point = { indexes: string[]; blobs: string[]; doubles: number[] };

function fakeDataset(): { ERRORS: AnalyticsEngineDataset; points: Point[] } {
  const points: Point[] = [];
  return {
    points,
    ERRORS: {
      writeDataPoint(point: AnalyticsEngineDataPoint) {
        points.push(point as unknown as Point);
      },
    } as unknown as AnalyticsEngineDataset,
  };
}

const base = {
  service: 'backend',
  method: 'POST',
  routePath: '/v1/apps/:appId/logs',
  status: 500,
  errorType: 'TypeError',
  message: 'cannot read property x of undefined',
};

describe('normalizeStack', () => {
  it('keeps the top frames and strips line:col so groups survive a rebuild', () => {
    const before = normalizeStack('Error: x\n    at handler (worker.js:1200:14)\n    at run (worker.js:88:3)');
    const after = normalizeStack('Error: x\n    at handler (worker.js:1631:9)\n    at run (worker.js:91:7)');
    expect(before).toBe(after);
    expect(before).toBe('at handler (worker.js)|at run (worker.js)');
  });

  it('caps frame count', () => {
    const stack = ['Error: x', ...Array.from({ length: 10 }, (_, i) => `    at f${i} (w.js:1:1)`)].join('\n');
    expect(normalizeStack(stack).split('|')).toHaveLength(3);
  });

  it('ignores non-frame lines and missing stacks', () => {
    expect(normalizeStack('Error: no frames here')).toBe('');
    expect(normalizeStack(null)).toBe('');
    expect(normalizeStack(undefined)).toBe('');
  });
});

describe('redact', () => {
  it('strips bearer tokens', () => {
    expect(redact('upstream said 401 for Bearer abc.def-ghi_jkl=')).toBe(
      'upstream said 401 for Bearer [redacted]',
    );
  });

  it('strips credential-shaped key/value pairs', () => {
    expect(redact('login failed: password=hunter2 for student')).toContain('password=[redacted]');
    expect(redact('{"client_secret": "s3cr3t-value"}')).toContain('[redacted]');
    expect(redact('api_key: pk_live_9999')).toContain('api_key: [redacted]');
  });

  it('strips JWTs, emails, and long hex blobs', () => {
    expect(redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig')).toBe('token [jwt]');
    expect(redact('no user for parent@example.com')).toBe('no user for [email]');
    expect(redact(`key ${'a1b2c3d4'.repeat(4)} rejected`)).toBe('key [hex] rejected');
  });

  it('leaves ordinary messages alone', () => {
    expect(redact(base.message)).toBe(base.message);
  });
});

describe('fingerprint', () => {
  it('is stable for the same fault', async () => {
    const stack = normalizeStack('E\n    at h (w.js:1:1)');
    expect(await fingerprint('TypeError', stack, '/v1/x')).toBe(
      await fingerprint('TypeError', stack, '/v1/x'),
    );
  });

  it('separates different types, stacks, and routes', async () => {
    const a = await fingerprint('TypeError', 'at h (w.js)', '/v1/x');
    expect(a).not.toBe(await fingerprint('RangeError', 'at h (w.js)', '/v1/x'));
    expect(a).not.toBe(await fingerprint('TypeError', 'at g (w.js)', '/v1/x'));
    expect(a).not.toBe(await fingerprint('TypeError', 'at h (w.js)', '/v1/y'));
  });

  it('is 16 hex chars', async () => {
    expect(await fingerprint('E', '', '/')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('recordServerError', () => {
  it('writes one point with the documented blob layout', async () => {
    const { ERRORS, points } = fakeDataset();
    const fp = await recordServerError({ ERRORS }, {
      ...base,
      appId: 'chess-academy',
      stack: 'TypeError: x\n    at handler (worker.js:12:3)',
      traceId: '0af7651916cd43dd8448eb211c80319c',
      cfRay: '8a1b2c3d4e5f6789-SYD',
    });

    expect(points).toHaveLength(1);
    const [p] = points;
    expect(p.indexes).toEqual(['chess-academy']);
    expect(p.blobs).toHaveLength(ERROR_BLOB_COLUMNS.length);
    expect(p.blobs[ERROR_BLOB_COLUMNS.indexOf('exception.type')]).toBe('TypeError');
    expect(p.blobs[ERROR_BLOB_COLUMNS.indexOf('fingerprint')]).toBe(fp);
    expect(p.blobs[ERROR_BLOB_COLUMNS.indexOf('http.route')]).toBe('/v1/apps/:appId/logs');
    expect(p.blobs[ERROR_BLOB_COLUMNS.indexOf('trace_id')]).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(p.doubles).toEqual([1, 500]);
  });

  it('indexes app-less errors as platform', async () => {
    const { ERRORS, points } = fakeDataset();
    await recordServerError({ ERRORS }, base);
    expect(points[0].indexes).toEqual([PLATFORM_INDEX]);
  });

  it('redacts the persisted message and stack', async () => {
    const { ERRORS, points } = fakeDataset();
    await recordServerError({ ERRORS }, {
      ...base,
      message: 'provision failed: password=hunter2',
      stack: 'Error: Bearer abc123def\n    at h (w.js:1:1)',
    });
    const blobs = points[0].blobs.join(' ');
    expect(blobs).not.toContain('hunter2');
    expect(blobs).not.toContain('abc123def');
    expect(blobs).toContain('[redacted]');
  });

  it('groups the same fault across different apps and deploys', async () => {
    const { ERRORS, points } = fakeDataset();
    await recordServerError({ ERRORS }, { ...base, appId: 'a', stack: 'E\n    at h (w.js:10:1)' });
    await recordServerError({ ERRORS }, { ...base, appId: 'b', stack: 'E\n    at h (w.js:99:7)' });
    const i = ERROR_BLOB_COLUMNS.indexOf('fingerprint');
    expect(points[0].blobs[i]).toBe(points[1].blobs[i]);
    expect(points[0].indexes).not.toEqual(points[1].indexes);
  });

  it('returns the fingerprint but writes nothing when the dataset is unbound', async () => {
    expect(await recordServerError({}, base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never throws when the dataset write fails', async () => {
    const ERRORS = {
      writeDataPoint() {
        throw new Error('AE unavailable');
      },
    } as unknown as AnalyticsEngineDataset;
    await expect(recordServerError({ ERRORS }, base)).resolves.toBeNull();
  });

  it('truncates an oversized index to AE limits', async () => {
    const { ERRORS, points } = fakeDataset();
    await recordServerError({ ERRORS }, { ...base, appId: 'x'.repeat(200) });
    expect(points[0].indexes[0].length).toBe(96);
  });
});
