import { describe, expect, it } from 'vitest';
import { validateWorkerManifest } from './worker.js';

describe('validateWorkerManifest', () => {
  it('treats an absent worker as none', () => {
    expect(validateWorkerManifest(undefined)).toEqual({ worker: null });
    expect(validateWorkerManifest(null)).toEqual({ worker: null });
  });

  it('accepts secrets and schedules', () => {
    expect(validateWorkerManifest({ secrets: ['API_KEY'], schedules: [{ name: 'sync', cron: '*/5 * * * *', params: { full: true } }] }))
      .toEqual({ worker: { secrets: ['API_KEY'], schedules: [{ name: 'sync', cron: '*/5 * * * *', params: { full: true } }] } });
    expect(validateWorkerManifest({})).toEqual({ worker: { secrets: [], schedules: [] } });
  });

  it('refuses unknown fields and a non-object', () => {
    expect(validateWorkerManifest([])).toEqual({ error: 'worker must be an object' });
    expect(validateWorkerManifest({ queues: [] })).toEqual({ error: 'worker: unknown field "queues"' });
    expect(validateWorkerManifest({ schedules: [{ name: 'a', cron: '0 * * * *', foo: 1 }] })).toEqual({ error: 'worker.schedules[0]: unknown field "foo"' });
  });

  it('refuses repeated or malformed secret names', () => {
    expect(validateWorkerManifest({ secrets: ['API_KEY', 'API_KEY'] })).toEqual({ error: 'worker.secrets must not repeat a name' });
    expect(validateWorkerManifest({ secrets: ['bad name'] })).toMatchObject({ error: expect.stringContaining('worker.secrets must be an array') });
  });

  it('applies the cron rules to schedules', () => {
    expect(validateWorkerManifest({ schedules: [{ name: 'a', cron: 'nope' }] })).toEqual({ error: 'worker.schedules[0].cron must be a valid five-field numeric UTC cron' });
    expect(validateWorkerManifest({ schedules: [{ name: 'a', cron: '*/7 * * * *' }] }))
      .toEqual({ error: 'worker.schedules[0].cron minutes must be multiples of 5 (the platform ticks every 5 minutes)' });
    expect(validateWorkerManifest({ schedules: [{ name: 'a', cron: '0 * * * *' }, { name: 'a', cron: '0 * * * *' }] })).toEqual({ error: 'worker.schedules[1]: duplicate name "a"' });
  });

  it('caps the schedule count and the params size', () => {
    const s = (name: string) => ({ name, cron: '0 * * * *' });
    expect(validateWorkerManifest({ schedules: [s('a'), s('b'), s('c'), s('d')] })).toEqual({ error: 'worker.schedules must be an array of at most 3 schedules' });
    expect(validateWorkerManifest({ schedules: [{ ...s('a'), params: { blob: 'x'.repeat(5000) } }] }))
      .toEqual({ error: 'worker.schedules[0].params must be at most 4096 bytes of JSON' });
  });
});
