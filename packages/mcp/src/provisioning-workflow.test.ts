import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #367: the shared provisioning workflow, driven directly with synthetic
 * fixtures. GitHub, the backend (listing, receipts, /v1/provision) and the
 * host are fakes that record every call, so "read-only" is asserted on the
 * calls actually made. The catalogue + selection contract are the real ones.
 */

vi.mock('@proappstore/build-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@proappstore/build-core')>()),
  verifyAppOwnership: vi.fn(),
}));
const buildCore = await import('@proappstore/build-core');
const ownership = vi.mocked(buildCore.verifyAppOwnership);
const { createProvisioningWorkflow, handleInternalProvisioning, planBinding } = await import('./provisioning-workflow.js');
type Plan = import('./provisioning-workflow.js').ProvisionPlan;

const ORG = 'test-org';
const APP = 'school-clubs';
const REPO_URL = `https://github.com/${ORG}/${APP}`;
const reviewed = buildCore.getTemplate('template-marketplace')!;
const HEAD = 'a'.repeat(40);
const HEAD_TREE = 't'.repeat(40);
const REVIEWED_TREE = 'r'.repeat(40);

/** The synthetic world: GitHub repos/commits, the PAS listing, receipts, provision. */
interface World {
  repo: { status: number; private?: boolean } ;
  commits: { sha: string; tree: string }[] | 'error';
  templateHead: { sha: string; tree: string } | null;
  templateCommits: Record<string, { sha: string; tree: string }>;
  listing: number;
  provision: { status: number; body: Record<string, unknown> };
  /** #369: what GitHub's generate call copies — by default the template head at that moment. */
  onCopy?: () => { sha: string; tree: string } | null;
}
let world: World;
let repoFiles: Record<string, string>;
let calls: { kind: string; detail: string }[];
const receipts = new Map<string, { receipt: string; appId: string; status: string; steps: { name: string; status: string; detail: string }[]; attemptId: string; intent: string; failureCode?: string }>();
let patches: { body: Record<string, unknown>; internal: string | null }[];
let nextReceipt = 1;

const gh = {
  api: vi.fn(async (path: string, opts?: { method?: string }) => {
    calls.push({ kind: `gh ${opts?.method ?? 'GET'}`, detail: path });
    if (path === `/repos/${ORG}/${APP}`) {
      return world.repo.status === 200
        ? { ok: true, status: 200, data: { id: 7, private: world.repo.private } }
        : { ok: false, status: world.repo.status, data: {} };
    }
    if (path === `/repos/${ORG}/${APP}/commits?per_page=2`) {
      if (world.commits === 'error') return { ok: false, status: 500, data: {} };
      return { ok: true, status: 200, data: world.commits.map((c) => ({ sha: c.sha, commit: { tree: { sha: c.tree } } })) };
    }
    const m = path.match(/^\/repos\/test-org\/template-marketplace\/commits\/(.+)$/);
    if (m) {
      const ref = m[1]!;
      const commit = ref === 'main' ? world.templateHead : (world.templateCommits[ref] ?? Object.values(world.templateCommits).find((c) => c.sha.startsWith(ref)));
      return commit ? { ok: true, status: 200, data: { sha: commit.sha, commit: { tree: { sha: commit.tree } } } } : { ok: false, status: 404, data: {} };
    }
    return { ok: false, status: 404, data: {} };
  }),
  repoExists: vi.fn(async () => { calls.push({ kind: 'gh GET', detail: 'repoExists' }); return world.repo.status === 200; }),
  createRepoFromTemplate: vi.fn(async (id: string, opts: unknown) => {
    calls.push({ kind: 'gh WRITE', detail: `create ${id} ${JSON.stringify(opts)}` });
    world.repo = { status: 200, private: (opts as { private?: boolean }).private };
    // As on GitHub: the new repo's one commit carries the tree of whatever was copied.
    const copied = world.onCopy ? world.onCopy() : world.templateHead;
    world.commits = copied ? [{ sha: 'copy-initial', tree: copied.tree }] : [];
    return { ok: true, status: 201, data: {} };
  }),
  // A stateful scaffold: pullText reads what pushFiles last wrote.
  pullText: vi.fn(async () => ({ ok: true, sha: 'head', files: { ...repoFiles } })),
  pushFiles: vi.fn(async (_id: string, files: { path: string; content: string }[]) => {
    calls.push({ kind: 'gh WRITE', detail: 'pushFiles' });
    for (const f of files) repoFiles[f.path] = f.content;
    return { ok: true, commitSha: 'c0ffee1234567' };
  }),
  getDeployStatus: vi.fn(async () => ({ ok: true, status: 200, data: { workflow_runs: [] } })),
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
let provisionBodies: Record<string, unknown>[];
const api = {
  fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ kind: `api ${method}`, detail: url.pathname });
    if (url.pathname === `/v1/apps/${APP}/listing`) return new Response('', { status: world.listing });
    if (url.pathname === '/v1/provision') {
      provisionBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(world.provision.body, world.provision.status);
    }
    const op = url.pathname.match(/^\/v1\/provision-operations(?:\/(.+))?$/);
    if (op) {
      const appId = op[1] ? decodeURIComponent(op[1]) : (JSON.parse(String(init?.body)) as { appId: string }).appId;
      const existing = receipts.get(appId);
      if (method === 'POST') {
        const intent = JSON.stringify((JSON.parse(String(init?.body)) as { intent: unknown }).intent);
        // As the backend (#358, #369): a failed receipt resumes with its own
        // intent, or a new one only when the platform classified the failure.
        if (existing?.status === 'failed' && (existing.intent === intent || existing.failureCode)) {
          Object.assign(existing, { status: 'pending', attemptId: `attempt-${nextReceipt++}`, intent, failureCode: undefined });
          return jsonResponse({ ...existing, joined: false });
        }
        if (existing) return jsonResponse({ ...existing, joined: true });
        const created = { receipt: `receipt-${nextReceipt++}`, appId, status: 'pending', steps: [], attemptId: 'attempt-1', intent };
        receipts.set(appId, created);
        return jsonResponse({ ...created, joined: false }, 201);
      }
      if (!existing) return jsonResponse({ error: 'not found' }, 404);
      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { status?: string; steps?: { name: string; status: string; detail: string }[]; failureCode?: string };
        const internal = new Headers(init?.headers).get('X-Internal-Token');
        patches.push({ body, internal });
        if (body.failureCode && internal !== 'internal-secret') return jsonResponse({ error: 'failureCode is set by the platform only' }, 403);
        if (body.status) existing.status = body.status;
        if (body.steps) existing.steps.push(...body.steps);
        if (body.failureCode) existing.failureCode = body.failureCode;
      }
      return jsonResponse(existing);
    }
    return new Response('not found', { status: 404 });
  }),
};
const host = { fetch: vi.fn(async () => new Response(null, { status: 200 })) };
const env = { GITHUB_ORG: ORG, API_BASE: 'https://api.test', API: api as unknown as Fetcher, HOST: host as unknown as Fetcher, INTERNAL_TOKEN: 'internal-secret' };
const user = { userId: 'gh:1', token: 'tok-1', roles: ['user', 'creator'] };
const input = { appId: APP, name: 'School Clubs', description: 'Clubs.', template: 'template-marketplace', repoUrl: REPO_URL };
const CONSOLE = { mode: 'console' as const, privateRepo: true };

let workflow: ReturnType<typeof createProvisioningWorkflow>;
const writes = () => calls.filter((c) => c.kind === 'gh WRITE' || c.kind === 'api POST' || c.kind === 'api PATCH');
async function plan(over: Partial<typeof input> & { templateRev?: string } = {}, who = user): Promise<Plan> {
  const outcome = await workflow.planProvision(who, { ...input, ...over }, CONSOLE);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome.plan;
}
/** Run a confirmation, letting the 4 s post-copy settle elapse. */
async function confirm(p: Plan) {
  const pending = workflow.confirmPlan(user, p);
  await vi.advanceTimersByTimeAsync(5000);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  calls = [];
  patches = [];
  repoFiles = { 'package.json': '{"name":"APPNAME"}', 'LICENSE': 'MIT' };
  provisionBodies = [];
  receipts.clear();
  nextReceipt = 1;
  world = {
    repo: { status: 404 },
    commits: [],
    templateHead: { sha: HEAD, tree: HEAD_TREE },
    templateCommits: { [reviewed.release.source_commit]: { sha: reviewed.release.source_commit, tree: REVIEWED_TREE } },
    listing: 404,
    provision: { status: 200, body: { success: true, appUrl: `https://${APP}.proappstore.online`, steps: [{ name: 'compliance', status: 'ok', detail: '19 rules passed' }] } },
  };
  ownership.mockResolvedValue(false);
  workflow = createProvisioningWorkflow(env, gh as never);
});
afterEach(() => { vi.useRealTimers(); });

describe('planProvision (preview) is read-only', () => {
  it('a new app: create from the template head, private, normal compliance, and nothing written', async () => {
    const p = await plan();
    expect(p).toMatchObject({
      action: 'create', appRecord: 'none', blockers: [],
      repository: { owner: ORG, name: APP, url: REPO_URL, exists: false, private: true },
      template: { id: 'template-marketplace', revision: HEAD, revisionSource: 'template_head', reviewedCommit: reviewed.release.source_commit, requestedRevision: null },
      compliance: { required: true },
    });
    expect(p.changes[0]).toBe(`create private GitHub repository ${ORG}/${APP} from ${ORG}/template-marketplace@${HEAD.slice(0, 12)}`);
    expect(p.warnings.join(' ')).toContain('is not the reviewed commit');
    expect(writes()).toEqual([]);
    expect(calls.every((c) => c.kind === 'gh GET' || c.kind === 'api GET')).toBe(true);
  });

  it('every kind of preview, refused or not, writes nothing', async () => {
    for (const setup of [
      () => { world.repo = { status: 200, private: false }; world.listing = 403; },
      () => { world.repo = { status: 200, private: true }; world.commits = [{ sha: 'h2', tree: 'x' }, { sha: 'h1', tree: HEAD_TREE }]; },
      () => { world.repo = { status: 200, private: false }; world.commits = [{ sha: 'h1', tree: HEAD_TREE }]; },
      () => { world.repo = { status: 500 }; },
    ]) {
      setup();
      await plan();
    }
    expect(writes()).toEqual([]);
  });

  it('refuses invalid input before reading anything', async () => {
    for (const [over, message] of [
      [{ repoUrl: 'https://github.com/someone/else' }, /repoUrl must be https:\/\/github.com\/test-org\/school-clubs/],
      [{ repoUrl: undefined }, /repoUrl must be/],
      [{ template: undefined }, /template is required/],
      [{ template: 'template-nope' }, /unknown template "template-nope"/],
      [{ templateRev: 'main' }, /templateRev must be a git object id/],
      [{ appId: 'Bad_Id' }, /Invalid app ID/],
    ] as [Record<string, unknown>, RegExp][]) {
      const outcome = await workflow.planProvision(user, { ...input, ...over } as never, CONSOLE);
      expect(outcome.ok, JSON.stringify(over)).toBe(false);
      expect((outcome as { error: string }).error).toMatch(message);
    }
    expect(calls).toEqual([]);
  });
});

describe('ownership: only the existing owner/admin and untouched-scaffold adoption are allowed', () => {
  it('another account\'s app is refused, and nothing past existence is disclosed', async () => {
    world.repo = { status: 200, private: true };
    world.listing = 403;
    world.commits = [{ sha: 'secret-head', tree: HEAD_TREE }];
    const p = await plan();
    expect(p.action).toBe('refused');
    expect(p.blockers.map((b) => b.code)).toEqual(['owned_by_another_account']);
    expect(p.repository).toEqual({ owner: ORG, name: APP, url: REPO_URL, exists: true });
    expect(JSON.stringify(p)).not.toContain('secret-head');
    expect(calls.map((c) => c.detail)).not.toContain(`/repos/${ORG}/${APP}/commits?per_page=2`);
  });

  it('an edited orphan (commits beyond the scaffold) is refused', async () => {
    world.repo = { status: 200, private: true };
    world.commits = [{ sha: 'h2', tree: 'x' }, { sha: 'h1', tree: HEAD_TREE }];
    const p = await plan();
    expect(p.blockers.map((b) => b.code)).toEqual(['repository_edited']);
    expect(p.repository).toEqual({ owner: ORG, name: APP, url: REPO_URL, exists: true });
  });

  it('an unknown app record, or an unreadable repo, fails closed', async () => {
    world.repo = { status: 200, private: true };
    world.listing = 500;
    expect((await plan()).blockers.map((b) => b.code)).toEqual(['app_record_unavailable']);
    world.repo = { status: 502 };
    const p = await plan();
    expect(p.blockers.map((b) => b.code)).toEqual(['repository_unavailable']);
    expect(p.repository.exists).toBeNull();
  });

  it('a platform admin may reuse an unowned repo, as on the MCP path; the route grants nothing more', async () => {
    world.repo = { status: 200, private: true };
    world.listing = 200;
    world.commits = [{ sha: 'h2', tree: 'x' }, { sha: 'h1', tree: 'y' }];
    const p = await plan({}, { ...user, roles: ['user', 'admin'] });
    expect(p).toMatchObject({ action: 'reuse_admin', blockers: [], compliance: { required: true } });
  });
});

describe('provenance: proven or unknown, never today\'s head for an existing repo', () => {
  it('an untouched scaffold whose tree matches the template head is adopted at exactly that revision, visibility kept', async () => {
    world.repo = { status: 200, private: false };
    world.commits = [{ sha: 'scaffold1', tree: HEAD_TREE }];
    const p = await plan();
    expect(p).toMatchObject({
      action: 'adopt_untouched', appRecord: 'none', blockers: [],
      repository: { exists: true, private: false, headSha: 'scaffold1', untouchedScaffold: true },
      template: { revision: HEAD, revisionSource: 'scaffold_tree_match' },
    });
  });

  it('a scaffold copied from the reviewed commit (head has moved on) is proven at the reviewed commit', async () => {
    world.repo = { status: 200, private: true };
    world.commits = [{ sha: 'scaffold1', tree: REVIEWED_TREE }];
    expect((await plan()).template).toMatchObject({ revision: reviewed.release.source_commit, revisionSource: 'scaffold_tree_match' });
  });

  it('an untouched scaffold matching no known template commit cannot be adopted from the Console', async () => {
    world.repo = { status: 200, private: true };
    world.commits = [{ sha: 'scaffold1', tree: 'unrelated-tree' }];
    const p = await plan();
    expect(p.blockers.map((b) => b.code)).toEqual(['revision_unverified']);
    expect(p.template).toMatchObject({ revision: null, revisionSource: 'unknown' });
  });

  it('an owned repo past its scaffold is reused with the revision unknown, not the template head', async () => {
    ownership.mockResolvedValue(true);
    world.repo = { status: 200, private: true };
    world.commits = [{ sha: 'h3', tree: 'x' }, { sha: 'h2', tree: 'y' }];
    const p = await plan();
    expect(p).toMatchObject({ action: 'reuse_owned', appRecord: 'owner', blockers: [], template: { revision: null, revisionSource: 'unknown' } });
    const outcome = await confirm(p);
    expect(outcome.kind).toBe('done');
    expect(provisionBodies[0]).toMatchObject({ template: 'template-marketplace', skipCompliance: false });
    expect(provisionBodies[0]).not.toHaveProperty('templateRev');
  });

  it('a requested revision is honoured when proven and refused when not — never ignored', async () => {
    world.repo = { status: 200, private: true };
    world.commits = [{ sha: 'scaffold1', tree: REVIEWED_TREE }];
    const proven = await plan({ templateRev: reviewed.release.source_commit.slice(0, 7) });
    expect(proven.template).toMatchObject({ requestedRevision: reviewed.release.source_commit.slice(0, 7), revision: reviewed.release.source_commit, revisionSource: 'scaffold_tree_match' });
    expect(proven.blockers).toEqual([]);
    const mismatched = await plan({ templateRev: HEAD.slice(0, 7) });
    expect(mismatched.blockers.map((b) => b.code)).toEqual(['revision_mismatch']);

    world.repo = { status: 404 };
    expect((await plan({ templateRev: HEAD.slice(0, 10) })).blockers).toEqual([]);
    expect((await plan({ templateRev: reviewed.release.source_commit })).blockers.map((b) => b.code)).toEqual(['revision_not_current']);
    world.templateHead = null;
    expect((await plan()).blockers.map((b) => b.code)).toEqual(['revision_unresolved']);
  });
});

describe('confirmPlan executes exactly the reviewed plan', () => {
  it('create: one copy at the planned visibility, the planned revision to /v1/provision, normal compliance', async () => {
    const p = await plan();
    const outcome = await confirm(p);
    expect(outcome).toMatchObject({ kind: 'done', repoAction: 'created', succeeded: true, receipt: { receipt: 'receipt-1' } });
    expect(gh.createRepoFromTemplate).toHaveBeenCalledTimes(1);
    expect(gh.createRepoFromTemplate).toHaveBeenCalledWith(APP, { template: 'template-marketplace', description: 'Clubs.', private: true });
    expect(provisionBodies).toEqual([expect.objectContaining({
      appId: APP, repoOwner: ORG, repoName: APP, skipCompliance: false, template: 'template-marketplace', templateRev: HEAD,
      provisionReceipt: 'receipt-1', provisionAttemptId: 'attempt-1',
    })]);
    expect(provisionBodies[0]).not.toHaveProperty('allowUnapprovedTemplate');
    expect(receipts.get(APP)!.status).toBe('completed');
  });

  it('adopting an untouched public scaffold never creates a repo or changes its visibility', async () => {
    world.repo = { status: 200, private: false };
    world.commits = [{ sha: 'scaffold1', tree: HEAD_TREE }];
    const outcome = await confirm(await plan());
    expect(outcome).toMatchObject({ kind: 'done', repoAction: 'adopted' });
    expect(gh.createRepoFromTemplate).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.kind === 'gh WRITE').map((c) => c.detail)).toEqual(['pushFiles']);
    expect(provisionBodies[0]).toMatchObject({ templateRev: HEAD });
  });

  it('a plan whose facts changed (the template head moved) returns the fresh plan and changes nothing', async () => {
    const p = await plan();
    world.templateHead = { sha: 'b'.repeat(40), tree: 'other' };
    const outcome = await confirm(p);
    expect(outcome.kind).toBe('plan_changed');
    expect((outcome as { plan: Plan }).plan.template.revision).toBe('b'.repeat(40));
    expect(writes()).toEqual([]);
  });

  it('a plan whose repo appeared, or whose owner changed, cannot execute', async () => {
    const p = await plan();
    world.repo = { status: 200, private: true };
    world.listing = 403;
    const outcome = await confirm(p);
    expect(outcome.kind).toBe('plan_changed');
    expect((outcome as { plan: Plan }).plan.blockers.map((b) => b.code)).toEqual(['owned_by_another_account']);
    expect(writes()).toEqual([]);
  });

  it('a tampered plan (different binding) is refused as changed', async () => {
    const p = await plan();
    const tampered = { ...p, template: { ...p.template, revision: reviewed.release.source_commit } };
    expect(planBinding(tampered)).not.toBe(planBinding(p));
    expect((await confirm(tampered)).kind).toBe('plan_changed');
    expect(writes()).toEqual([]);
  });

  it('a blocked plan is not executed even when unchanged', async () => {
    world.repo = { status: 200, private: true };
    world.listing = 403;
    const outcome = await confirm(await plan());
    expect(outcome.kind).toBe('plan_blocked');
    expect(writes()).toEqual([]);
  });

  it('concurrent confirmations of one plan run one bootstrap; the other joins the durable receipt', async () => {
    const p = await plan();
    const [a, b] = await Promise.all([workflow.confirmPlan(user, p), workflow.confirmPlan(user, p), vi.advanceTimersByTimeAsync(5000)]);
    expect([a.kind, b.kind].sort()).toEqual(['done', 'joined']);
    expect(gh.createRepoFromTemplate).toHaveBeenCalledTimes(1);
    expect(provisionBodies).toHaveLength(1);
    const again = await confirm(p);
    expect(again.kind).toBe('plan_changed'); // the repo now exists: a new preview is needed
  });

  it('a compliance failure is surfaced and the receipt fails; nothing is reported live', async () => {
    world.provision = { status: 412, body: { success: false, steps: [{ name: 'compliance', status: 'fail', detail: '1 rule(s) failed — Theme: missing' }] } };
    const outcome = await confirm(await plan());
    expect(outcome).toMatchObject({ kind: 'done', succeeded: false });
    expect((outcome as { lines: string[] }).lines.join('\n')).toContain('! compliance: 1 rule(s) failed — Theme: missing');
    expect(receipts.get(APP)!.status).toBe('failed');
    expect(receipts.get(APP)!.steps).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'compliance', status: 'fail' })]));
    // #369: an ordinary failure is never classified, so it cannot be retried under another revision.
    expect(patches.every((p) => !('failureCode' in p.body) && p.internal === null)).toBe(true);
    expect(receipts.get(APP)!.failureCode).toBeUndefined();
  });
});

describe('a new copy is checked against the planned revision before anything else (#369)', () => {
  const B = 'b'.repeat(40);
  const B_TREE = 'u'.repeat(40);
  /** Confirm with room for the bounded wait on GitHub's asynchronous copy. */
  async function confirmSlowly(p: Plan) {
    const pending = workflow.confirmPlan(user, p);
    await vi.advanceTimersByTimeAsync(20_000);
    return pending;
  }
  const ghWrites = () => calls.filter((c) => c.kind === 'gh WRITE').map((c) => c.detail);

  it('matching copy — proceeds normally and records the proven revision', async () => {
    const p = await plan();
    expect(p.template).toMatchObject({ revision: HEAD, revisionTree: HEAD_TREE });
    const outcome = await confirm(p);
    expect(outcome).toMatchObject({ kind: 'done', repoAction: 'created', succeeded: true });
    expect((outcome as { lines: string[] }).lines).toContain(`+ Template copy: ${ORG}/${APP}'s initial tree matches template-marketplace@${HEAD.slice(0, 12)}`);
    expect(ghWrites()).toEqual([expect.stringMatching(/^create /), 'pushFiles']);
    expect(provisionBodies).toEqual([expect.objectContaining({ templateRev: HEAD })]);
    expect(receipts.get(APP)!.status).toBe('completed');
    expect(receipts.get(APP)!.steps.map((s) => s.name)).not.toContain('template_revision');
  });

  it('A→B race — the template moves during the copy: mismatch stops before placeholder/provision writes', async () => {
    const p = await plan();
    expect(p.template.revision).toBe(HEAD);
    // The confirming read sees A; GitHub's generate call then copies B.
    world.onCopy = () => { world.templateHead = { sha: B, tree: B_TREE }; return world.templateHead; };
    const outcome = await confirmSlowly(p);
    expect(outcome.kind).toBe('error');
    expect((outcome as { error: string }).error).toMatch(/revision_mismatch: test-org\/school-clubs was created, but its initial tree uuuuuuuuuuuu is not the tree tttttttttttt of template-marketplace@aaaaaaaaaaaa/);
    expect((outcome as { error: string }).error).toContain('The repository is kept as created');
    // Created, then nothing: no placeholder commit, no provisioning, no deletion.
    expect(ghWrites()).toEqual([expect.stringMatching(/^create school-clubs /)]);
    expect(gh.pushFiles).not.toHaveBeenCalled();
    expect(provisionBodies).toEqual([]);
    expect(world.repo.status).toBe(200);
    // The durable receipt says exactly that.
    const receipt = receipts.get(APP)!;
    expect(receipt.status).toBe('failed');
    expect(receipt.steps).toEqual([
      expect.objectContaining({ name: 'repo_created', status: 'ok' }),
      expect.objectContaining({ name: 'template_revision', status: 'fail', detail: expect.stringMatching(/^revision_mismatch: /) }),
    ]);
    // The classification travels with the platform's INTERNAL_TOKEN, not the session alone.
    expect(patches.at(-1)).toMatchObject({ body: { status: 'failed', failureCode: 'template_copy_mismatch' }, internal: 'internal-secret' });
    expect(receipt.failureCode).toBe('template_copy_mismatch');
  });

  it('unavailable tree proof — an unreadable copy stops before placeholder/provision writes', async () => {
    world.onCopy = () => null; // the copy never shows a commit
    const outcome = await confirmSlowly(await plan());
    expect(outcome.kind).toBe('error');
    expect((outcome as { error: string }).error).toMatch(/revision_unverified: .*could not be compared with template-marketplace@aaaaaaaaaaaa/);
    expect(gh.pushFiles).not.toHaveBeenCalled();
    expect(provisionBodies).toEqual([]);
    expect(world.repo.status).toBe(200);
    expect(receipts.get(APP)!.status).toBe('failed');
    expect(receipts.get(APP)!.steps.at(-1)).toMatchObject({ name: 'template_revision', status: 'fail', detail: expect.stringMatching(/^revision_unverified: /) });
    expect(receipts.get(APP)!.failureCode).toBe('template_copy_unverified');
    // It polled GitHub's copy a bounded number of times before giving up.
    expect(calls.filter((c) => c.detail === `/repos/${ORG}/${APP}/commits?per_page=2`)).toHaveLength(5);
  });

  it('a planned revision without a known tree is never claimed either', async () => {
    const p = await plan();
    const outcome = await confirmSlowly({ ...p, template: { ...p.template, revisionTree: null } });
    // The re-plan restores the tree, so this executes the fresh plan and proves it.
    expect(outcome).toMatchObject({ kind: 'done', succeeded: true });
    world.templateHead = { sha: HEAD, tree: null as unknown as string };
    world.repo = { status: 404 };
    receipts.clear();
    const fresh = await plan();
    expect(fresh.template).toMatchObject({ revision: HEAD, revisionTree: null });
    const refused = await confirmSlowly(fresh);
    expect((refused as { error: string }).error).toMatch(/revision_unverified/);
  });

  it('receipt truthfulness — a fresh plan adopts the kept repo at the revision it actually holds', async () => {
    const p = await plan();
    world.onCopy = () => { world.templateHead = { sha: B, tree: B_TREE }; return world.templateHead; };
    expect((await confirmSlowly(p)).kind).toBe('error');
    world.onCopy = undefined;

    // The repo exists, has no PAS app record yet, and is the untouched copy of B.
    const fresh = await plan();
    expect(fresh).toMatchObject({
      action: 'adopt_untouched', blockers: [],
      repository: { exists: true, untouchedScaffold: true },
      template: { revision: B, revisionSource: 'scaffold_tree_match', revisionTree: B_TREE },
    });
    // The stale plan for A cannot run: it no longer matches.
    expect((await confirmSlowly(p)).kind).toBe('plan_changed');
    // The fresh plan adopts it under the same durable receipt, recording B, not A.
    const adopted = await confirmSlowly(fresh);
    expect(adopted).toMatchObject({ kind: 'done', repoAction: 'adopted', succeeded: true, receipt: { receipt: 'receipt-1' } });
    expect(gh.createRepoFromTemplate).toHaveBeenCalledTimes(1);
    expect(provisionBodies).toEqual([expect.objectContaining({ templateRev: B })]);
  });
});

describe('handleInternalProvisioning', () => {
  const KEY = 'provisioning-test-signing-key';
  const ienv = { ...env, GITHUB_TOKEN: 'gh-tok', INTERNAL_TOKEN: 'internal-secret', SESSION_SIGNING_KEY: KEY };
  const session = () => buildCore.mintSession({ uid: 'gh:1', login: 'alice', avatarUrl: null, roles: ['user', 'creator'] }, KEY);
  const post = async (path: string, body: unknown, headers: Record<string, string>) =>
    handleInternalProvisioning(new Request(`https://mcp${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), ienv, () => gh as never);

  it('is invisible without the internal token, and needs a valid PAS session', async () => {
    expect((await post('/internal/provisioning/plan', { input }, {}))!.status).toBe(404);
    expect((await post('/internal/provisioning/plan', { input }, { 'X-Internal-Token': 'wrong' }))!.status).toBe(404);
    expect((await post('/internal/provisioning/plan', { input }, { 'X-Internal-Token': 'internal-secret', 'X-PAS-Session': 'forged.sig' }))!.status).toBe(401);
    expect(await handleInternalProvisioning(new Request('https://mcp/mcp'), ienv)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('plans as the session user and maps a changed plan to 409', async () => {
    const headers = { 'X-Internal-Token': 'internal-secret', 'X-PAS-Session': await session() };
    const planned = await post('/internal/provisioning/plan', { input }, headers);
    expect(planned!.status).toBe(200);
    const { plan: p } = await planned!.json() as { plan: Plan };
    expect(p.action).toBe('create');
    expect((await post('/internal/provisioning/plan', { input: { ...input, repoUrl: 'https://github.com/x/y' } }, headers))!.status).toBe(400);
    world.templateHead = { sha: 'c'.repeat(40), tree: 'z' };
    const executed = await post('/internal/provisioning/execute', { plan: p }, headers);
    expect(executed!.status).toBe(409);
    expect(await executed!.json()).toMatchObject({ error: 'plan_changed', plan: { template: { revision: 'c'.repeat(40) } } });
    expect(writes()).toEqual([]);
  });
});
