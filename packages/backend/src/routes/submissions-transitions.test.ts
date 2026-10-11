import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { APPROVAL_LEASE_MS } from './submissions-review.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #383: approve, reject and delete are conditional transitions. Each write
// re-checks the status it read, so a competing transition that lands between
// the read and the write wins cleanly: nothing is provisioned twice, published
// is never overwritten, and a failed provision leaves the submission retryable.

const ADMIN = await testToken('gh:1');
const CREATOR = await testToken('gh:2');

const provisionApp = vi.hoisted(() => vi.fn());
vi.mock('./provision.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('./provision.js')>()), provisionApp }));
const provisions = (ok = true) => provisionApp.mockImplementation(async () => {
  await new Promise((r) => setTimeout(r, 0)); // let a concurrent request run meanwhile
  return Response.json({ success: ok, steps: [], appId: 'kanban' }, { status: ok ? 200 : 207 });
});

/**
 * One submission row in a D1 fake that applies the guarded transitions the
 * handlers issue. `afterRead` runs once, right after the handler's first read:
 * it is a competing transition landing between read and write.
 */
function fakeDb(status: string, opts: { reviewedAt?: number | null; afterRead?: (row: Row) => void; releaseConflict?: boolean } = {}) {
  type Row = { status: string; reviewed_at: number | null; deleted: boolean };
  const row: Row = { status, reviewed_at: opts.reviewedAt ?? null, deleted: false };
  let afterRead = opts.afterRead;
  const sql: string[] = [];
  const full = () => (row.deleted ? null : {
    id: 'sub1', app_id: 'kanban', creator_id: 'gh:2', status: row.status, name: 'K', category: 'c', description: 'd',
    icon: null, icon_bg: null, pro_features: null, suggested_monthly_price_cents: null, repo_url: null,
    template_id: null, template_rev: null, reviewer_id: null, rejection_reason: null, created_at: 1, reviewed_at: row.reviewed_at,
  });
  const stmt = (q: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(q, a),
    first: async () => {
      if (/SELECT \* FROM submissions/.test(q)) {
        const r = full();
        await new Promise((res) => setTimeout(res, 0)); // concurrent requests both read before either writes
        if (afterRead) { afterRead(row); afterRead = undefined; }
        return r;
      }
      if (/SELECT status FROM submissions/.test(q)) return row.deleted ? null : { status: row.status };
      return null;
    },
    run: async () => {
      sql.push(q);
      const live = !row.deleted;
      let hit = false;
      if (/SET status = 'approved'/.test(q)) {
        hit = live && (row.status === 'pending' || (row.status === 'approved' && row.reviewed_at !== null && row.reviewed_at < (args[4] as number)));
        if (hit) { row.status = 'approved'; row.reviewed_at = args[1] as number; }
      } else if (/SET status = 'published'/.test(q)) {
        hit = live && row.status === 'approved';
        if (hit) row.status = 'published';
      } else if (/SET status = 'pending'/.test(q)) {
        if (opts.releaseConflict) throw new Error('D1_ERROR: UNIQUE constraint failed: submissions.app_id');
        hit = live && row.status === 'approved';
        if (hit) row.status = 'pending';
      } else if (/SET status = 'rejected'/.test(q)) {
        hit = live && row.status === 'pending';
        if (hit) row.status = 'rejected';
      } else if (/DELETE FROM submissions/.test(q)) {
        hit = live && row.status === 'pending';
        if (hit) row.deleted = true;
      }
      return { meta: { changes: hit ? 1 : 0 } };
    },
  });
  return { row, sql, DB: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}

const env = (d: ReturnType<typeof fakeDb>) => makeEnv({ DB: d.DB, ADMIN_GITHUB_IDS: 'gh:1' });
const approve = (d: ReturnType<typeof fakeDb>) =>
  app.request('/v1/submissions/sub1/approve', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: '{}' }, env(d));
const reject = (d: ReturnType<typeof fakeDb>) =>
  app.request('/v1/submissions/sub1/reject', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'no' }) }, env(d));
const remove = (d: ReturnType<typeof fakeDb>) =>
  app.request('/v1/submissions/sub1', { method: 'DELETE', headers: { Authorization: `Bearer ${CREATOR}` } }, env(d));

beforeEach(() => { provisionApp.mockReset(); provisions(); });

describe('approve claims the submission once (#383)', () => {
  it('two concurrent approvals provision exactly once', async () => {
    const d = fakeDb('pending');
    const [a, b] = await Promise.all([approve(d), approve(d)]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(provisionApp).toHaveBeenCalledTimes(1);
    expect(d.row.status).toBe('published');
  });

  it('an approval whose claim loses after reading pending provisions nothing', async () => {
    const d = fakeDb('pending', { afterRead: (r) => { r.status = 'approved'; r.reviewed_at = Date.now(); } });
    const res = await approve(d);
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('Submission is approved, not pending');
    expect(provisionApp).not.toHaveBeenCalled();
  });

  it('an approval racing the creator\'s delete provisions nothing', async () => {
    const d = fakeDb('pending', { afterRead: (r) => { r.deleted = true; } });
    expect((await approve(d)).status).toBe(404);
    expect(provisionApp).not.toHaveBeenCalled();
  });

  it('a live claim cannot be taken over; a dead one (older than the lease) can', async () => {
    const live = fakeDb('approved', { reviewedAt: Date.now() });
    expect((await approve(live)).status).toBe(422);
    expect(provisionApp).not.toHaveBeenCalled();

    const dead = fakeDb('approved', { reviewedAt: Date.now() - APPROVAL_LEASE_MS - 1 });
    expect((await approve(dead)).status).toBe(200);
    expect(provisionApp).toHaveBeenCalledTimes(1);
    expect(dead.row.status).toBe('published');
  });
});

describe('a failed provision leaves the submission retryable (#383)', () => {
  it('a throwing provisioner releases the claim and answers 500; the retry publishes', async () => {
    provisionApp.mockRejectedValueOnce(new Error('cloudflare down'));
    const d = fakeDb('pending');
    const res = await approve(d);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ provisionResult: { error: 'Error: cloudflare down' } });
    expect(d.row.status).toBe('pending');
    expect(d.sql.some((q) => /SET status = 'pending' WHERE id = \?1 AND status = 'approved'/.test(q))).toBe(true);

    expect((await approve(d)).status).toBe(200);
    expect(d.row.status).toBe('published');
  });

  it('an unsuccessful provision result releases the claim too', async () => {
    provisions(false);
    const d = fakeDb('pending');
    expect((await approve(d)).status).toBe(500);
    expect(d.row.status).toBe('pending');
  });

  it('a newer pending submission for the app keeps this one approved, and still answers 500', async () => {
    provisions(false);
    const d = fakeDb('pending', { releaseConflict: true });
    expect((await approve(d)).status).toBe(500);
    expect(d.row.status).toBe('approved');
  });
});

describe('reject and delete only act on pending (#383)', () => {
  it('a reject landing after publish does not overwrite published', async () => {
    const d = fakeDb('pending', { afterRead: (r) => { r.status = 'published'; } });
    const res = await reject(d);
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('Submission is published, not pending');
    expect(d.row.status).toBe('published');
  });

  it('a reject cannot overwrite an approval in flight', async () => {
    const d = fakeDb('pending', { afterRead: (r) => { r.status = 'approved'; } });
    expect((await reject(d)).status).toBe(422);
    expect(d.row.status).toBe('approved');
  });

  it('the creator cannot delete a submission an approval has claimed meanwhile', async () => {
    const d = fakeDb('pending', { afterRead: (r) => { r.status = 'approved'; } });
    const res = await remove(d);
    expect(res.status).toBe(422);
    expect(await res.text()).toBe('Submission is approved, not pending');
    expect(d.row.deleted).toBe(false);
  });

  it('a pending submission is still rejected and deleted as before', async () => {
    const r = fakeDb('pending');
    expect((await reject(r)).status).toBe(200);
    expect(r.row.status).toBe('rejected');
    const del = fakeDb('pending');
    expect((await remove(del)).status).toBe(200);
    expect(del.row.deleted).toBe(true);
  });
});
