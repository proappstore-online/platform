import { afterEach, expect, it, vi } from 'vitest';
import { scheduleContributions } from './scheduler.js';

afterEach(() => vi.restoreAllMocks());

it('logs unconfigured ingestion without accessing D1 or exposing credentials', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const prepare = vi.fn(() => { throw new Error('must not access D1'); });
  await scheduleContributions({ DB: { prepare } as unknown as D1Database }, 123);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('[contributions] tick unconfigured: GITHUB_TOKEN is not configured');
  expect(prepare).not.toHaveBeenCalled();
});
