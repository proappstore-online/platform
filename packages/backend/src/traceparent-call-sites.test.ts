import { describe, expect, it, vi } from 'vitest';

const recorders = vi.hoisted(() => ({
  server: vi.fn(async () => null),
  operation: vi.fn(async () => undefined),
}));

vi.mock('./lib/error-telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/error-telemetry.js')>()),
  recordServerError: (...args: unknown[]) => recorders.server(...args),
}));
vi.mock('./lib/operation-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/operation-log.js')>()),
  recordOperationFailure: (...args: unknown[]) => recorders.operation(...args),
}));

const { app } = await import('./index.js');

// A deliberately tiny in-process route exercises index.ts's two onError
// recorder call sites without depending on an application route or a database.
app.post('/__test/traceparent/:appId', () => {
  throw new Error('intentional traceparent recorder test failure');
});

describe('index error recorder traceparent extraction', () => {
  it.each([
    ['garbage-abc-def', null],
    ['00-00000000000000000000000000000000-anything-00', null],
    ['00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '4bf92f3577b34da6a3ce929d0e0e4736'],
  ])('passes only the validated trace id to both recorders (%s)', async (traceparent, expected) => {
    recorders.server.mockClear();
    recorders.operation.mockClear();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await app.request('/__test/traceparent/app-one', {
        method: 'POST',
        headers: { traceparent },
      }, {} as never);

      expect(res.status).toBe(500);
      expect(recorders.server).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ traceId: expected }));
      expect(recorders.operation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ traceId: expected }));
    } finally {
      consoleError.mockRestore();
    }
  });
});
