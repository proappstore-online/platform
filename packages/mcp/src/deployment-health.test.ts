import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCurrentDeployment } from './deployment-health.js';

afterEach(() => vi.useRealTimers());
const gh = (result: unknown) => ({ getDeployStatus: vi.fn().mockResolvedValue(result) });
const host = (response: Response) => ({ fetch: vi.fn().mockResolvedValue(response) }) as unknown as Fetcher;

describe('current deployment diagnostics', () => {
  it('reads current workflow state and route separately from a historical receipt', async () => {
    const github = gh({ ok: true, data: { workflow_runs: [{ name: 'Deploy to R2', conclusion: 'success', status: 'completed', updated_at: '2026-10-23T00:00:00Z' }] } });
    const route = host(new Response(null, { status: 200 }));
    const result = await readCurrentDeployment(github, route, 'example');
    expect(result).toContain('Current deployment and route health (checked ');
    expect(result).toContain('+ Deploy to R2: success (2026-10-23T00:00:00Z)');
    expect(result).toContain('Current route health: ok');
    expect(route.fetch).toHaveBeenCalledWith('https://example.proappstore.online', { method: 'HEAD' });
  });

  it.each(['queued', 'in_progress', 'failure'] as const)('reports an actual %s workflow without presenting it as deployed', async status => {
    const result = await readCurrentDeployment(gh({ ok: true, data: { workflow_runs: [{ name: 'Deploy', status, conclusion: status === 'failure' ? 'failure' : null, updated_at: 'now' }] } }), host(new Response(null, { status: 404 })), 'example');
    expect(result).toContain(`Deploy: ${status}`);
    expect(result).toContain('Current route health: down');
  });

  it('recognizes an intentional private-app access gate as healthy', async () => {
    const result = await readCurrentDeployment(gh({ ok: true, data: { workflow_runs: [] } }), host(new Response(null, { status: 403, headers: { 'X-PAS-Visibility': 'private' } })), 'private-app');
    expect(result).toContain('Current route health: ok');
    expect(result).toContain('No workflow runs found');
  });

  it('reports unavailable GitHub diagnostics without hiding the route result', async () => {
    const result = await readCurrentDeployment(gh({ ok: false, status: 503 }), host(new Response(null, { status: 200 })), 'example');
    expect(result).toContain('GitHub Actions: unavailable (HTTP 503)');
    expect(result).toContain('Current route health: ok');
  });

  it('bounds both diagnostics when dependencies never respond', async () => {
    vi.useFakeTimers();
    const github = { getDeployStatus: vi.fn(() => new Promise<never>(() => {})) };
    const route = { fetch: vi.fn(() => new Promise<never>(() => {})) } as unknown as Fetcher;
    const pending = readCurrentDeployment(github, route, 'example');
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result).toContain('GitHub Actions: unavailable (timed out)');
    expect(result).toContain('Current route health: timeout');
  });
});
