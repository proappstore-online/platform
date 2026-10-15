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
    // The old loose parser took a trace id out of anything with four dashes; #390 parses strictly.
    ['00-4bf92f3577b34da6a3ce929d0e0e4736-not-a-span', null],
    ['00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01', '4bf92f3577b34da6a3ce929d0e0e4736'],
  ])('a valid traceparent is joined, anything else gets a fresh trace id — in both recorders and the response (%s)', async (traceparent, expected) => {
    recorders.server.mockClear();
    recorders.operation.mockClear();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await app.request('/__test/traceparent/app-one', {
        method: 'POST',
        headers: { traceparent },
      }, {} as never);

      expect(res.status).toBe(500);
      const body = await res.json() as { error: string; errorCode: string; traceId: string };
      // #390: a safe code and the trace, never the thrown message.
      expect(body).toEqual({ error: 'Internal server error', errorCode: 'internal_error', traceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
      if (expected) expect(body.traceId).toBe(expected);
      expect(res.headers.get('X-PAS-Trace-Id')).toBe(body.traceId);
      expect(recorders.server).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ traceId: body.traceId }));
      const op = (recorders.operation.mock.calls[0] as unknown as [unknown, { traceId: string; spanId: string; parentSpanId: string | null; errorCode: string }])[1];
      expect(op).toMatchObject({ traceId: body.traceId, spanId: expect.stringMatching(/^[0-9a-f]{16}$/), errorCode: 'internal_error' });
      expect(op.parentSpanId).toBe(expected ? '00f067aa0ba902b7' : null);
      expect(op.spanId).not.toBe(op.parentSpanId);
    } finally {
      consoleError.mockRestore();
    }
  });
});
