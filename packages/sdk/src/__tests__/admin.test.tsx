// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Actions, ActionError } from '../actions.js';
import { AdminConsole, useAction, useAdminContext, type ActionInvoker, type AdminContextValue } from '../admin.js';
import * as hooks from '../hooks.js';
import * as sdk from '../index.js';
import type { ProAppStore } from '../index.js';

/** #299: custom admin panel hooks. The server is the authority; the hooks surface what it says. */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = { id: 'gh:1', name: 'Ada', login: 'ada', avatarUrl: null, dateOfBirth: null };
const API = 'https://api.proappstore.online';

/** An app whose action endpoint answers with `answers` in turn, and whose roles/me answers `roles`. */
function fakeApp(answers: Response[], roles: string[] = ['admin']) {
  const authenticatedFetch = vi.fn(async (url: string) => {
    if (url.endsWith('/roles/me')) return Response.json({ roles });
    return answers.shift() ?? new Response('no answer', { status: 500 });
  });
  const authLike = { authenticatedFetch, handleUnauthorized: vi.fn() };
  const capture = vi.fn();
  const app = {
    appId: 'moder',
    auth: { status: 'signed-in', user: USER, onStatus: () => () => {}, init: async () => {} },
    roles: { myRoles: async () => ((await (await authenticatedFetch(`${API}/v1/apps/moder/roles/me`)).json()) as { roles: string[] }).roles },
    actions: new Actions('moder', API, authLike, { capture }),
    logs: { capture },
  } as unknown as ProAppStore;
  return { app, authenticatedFetch, capture };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Render a probe inside <AdminConsole> and hand back the latest context and invoker. */
async function mount(app: ProAppStore, name: string, onStepUp?: (e: ActionError) => boolean | Promise<boolean>) {
  const seen: { ctx?: AdminContextValue; run?: ActionInvoker<Record<string, unknown>, unknown> } = {};
  function Probe() {
    seen.ctx = useAdminContext();
    seen.run = useAction(name, { onStepUp });
    return null;
  }
  await act(async () => root.render(<AdminConsole app={app}><Probe /></AdminConsole>));
  return seen;
}

describe('useAdminContext (#299)', () => {
  it('gives { app, user, roles, session } with the roles the server reports', async () => {
    const { app } = fakeApp([], ['admin', 'moderator']);
    const seen = await mount(app, 'noop');
    expect(seen.ctx).toMatchObject({
      app: { id: 'moder' },
      user: USER,
      roles: ['admin', 'moderator'],
      session: { status: 'signed-in', rolesLoaded: true },
    });
    expect(JSON.stringify(seen.ctx)).not.toMatch(/token/i);
  });

  // #338: role answers that arrive out of order. Each myRoles() call is a promise the test resolves by hand.
  function racingApp() {
    const pending: { resolve: (roles: string[]) => void; reject: (e: Error) => void }[] = [];
    let listener: ((status: string, user: unknown) => void) | null = null;
    const app = {
      appId: 'moder',
      auth: { status: 'signed-in', user: USER, onStatus: (fn: typeof listener) => { listener = fn; return () => {}; }, init: async () => {} },
      roles: { myRoles: () => new Promise<string[]>((resolve, reject) => { pending.push({ resolve, reject }); }) },
      logs: { capture: vi.fn() },
    } as unknown as ProAppStore;
    return { app, pending, signIn: (user: typeof USER) => listener?.('signed-in', user) };
  }
  async function probe(app: ProAppStore) {
    const seen: { ctx?: AdminContextValue } = {};
    function Probe() { seen.ctx = useAdminContext(); return null; }
    await act(async () => root.render(<AdminConsole app={app}><Probe /></AdminConsole>));
    return seen;
  }

  it('same user: only the latest roles request writes, whichever answers last (#338)', async () => {
    const { app, pending } = racingApp();
    const seen = await probe(app);
    expect(pending).toHaveLength(1); // the initial load, still in flight
    let refresh!: Promise<void>;
    act(() => { refresh = seen.ctx!.session.refreshRoles(); }); // e.g. after the owner granted a role
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]!.resolve(['admin', 'moderator']); await refresh; });
    expect(seen.ctx).toMatchObject({ roles: ['admin', 'moderator'], session: { rolesLoaded: true } });
    await act(async () => { pending[0]!.resolve(['viewer']); }); // the slower initial load lands last
    expect(seen.ctx!.roles).toEqual(['admin', 'moderator']);
  });

  it("user switch: the previous user's late roles answer is dropped, the new user's stands (#338)", async () => {
    const { app, pending, signIn } = racingApp();
    const seen = await probe(app);
    const BOB = { ...USER, id: 'gh:2', name: 'Bob', login: 'bob' };
    await act(async () => { signIn(BOB); });
    expect(pending).toHaveLength(2);
    // Ada's answer lands first, while Bob's is still loading: nothing is shown for Bob yet.
    await act(async () => { pending[0]!.resolve(['admin']); });
    expect(seen.ctx).toMatchObject({ user: { id: 'gh:2' }, roles: [], session: { rolesLoaded: false } });
    await act(async () => { pending[1]!.resolve(['viewer']); });
    expect(seen.ctx).toMatchObject({ user: { id: 'gh:2' }, roles: ['viewer'], session: { rolesLoaded: true } });

    // And the other order: the new user's answer first, then the previous user's stale one.
    const CAROL = { ...USER, id: 'gh:3', name: 'Carol', login: 'carol' };
    const DAVE = { ...USER, id: 'gh:4', name: 'Dave', login: 'dave' };
    await act(async () => { signIn(CAROL); });
    await act(async () => { signIn(DAVE); });
    expect(pending).toHaveLength(4);
    await act(async () => { pending[3]!.resolve(['moderator']); });
    await act(async () => { pending[2]!.resolve(['admin']); });
    expect(seen.ctx).toMatchObject({ user: { id: 'gh:4' }, roles: ['moderator'], session: { rolesLoaded: true } });
  });

  // #344: a failed roles fetch is an error the panel can show and retry, not "no roles".
  it('surfaces a failed roles fetch as rolesError, and refreshRoles retries it', async () => {
    const { app, pending } = racingApp();
    const seen = await probe(app);
    await act(async () => { pending[0]!.reject(new Error('roles/me failed: 503')); });
    expect(seen.ctx).toMatchObject({ roles: [], session: { rolesLoaded: false, rolesError: { message: 'roles/me failed: 503' } } });
    let retry!: Promise<void>;
    act(() => { retry = seen.ctx!.session.refreshRoles(); });
    await act(async () => { pending[1]!.resolve(['admin']); await retry; });
    expect(seen.ctx).toMatchObject({ roles: ['admin'], session: { rolesLoaded: true, rolesError: null } });
  });

  it('asks myRoles to throw, and a signed-out visitor has neither roles nor an error', async () => {
    const myRoles = vi.fn(async () => ['admin']);
    const app = { appId: 'moder', auth: { status: 'signed-out', user: null, onStatus: () => () => {}, init: async () => {} }, roles: { myRoles }, logs: { capture: vi.fn() } } as unknown as ProAppStore;
    const seen = await probe(app);
    expect(myRoles).not.toHaveBeenCalled();
    expect(seen.ctx).toMatchObject({ user: null, roles: [], session: { status: 'signed-out', rolesLoaded: false, rolesError: null } });
    const signedIn = { ...app, auth: { ...app.auth, status: 'signed-in', user: USER } } as unknown as ProAppStore;
    act(() => root.unmount());
    root = createRoot(host);
    await probe(signedIn);
    expect(myRoles).toHaveBeenCalledWith({ throwOnError: true });
  });

  it('throws outside <AdminConsole>', async () => {
    let caught: unknown;
    function Bare() { try { useAdminContext(); } catch (e) { caught = e; } return null; }
    await act(async () => root.render(<Bare />));
    expect(String(caught)).toContain('inside <AdminConsole>');
  });
});

describe('useAction (#299)', () => {
  // #344: `error` reflects the latest call; an older call settling later never overwrites it.
  it('only the latest call decides error, whichever settles last', async () => {
    const calls: { resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
    const app = {
      appId: 'moder',
      auth: { status: 'signed-in', user: USER, onStatus: () => () => {}, init: async () => {} },
      roles: { myRoles: async () => ['admin'] },
      actions: { call: () => new Promise((resolve, reject) => { calls.push({ resolve, reject }); }) },
      logs: { capture: vi.fn() },
    } as unknown as ProAppStore;
    const seen = await mount(app, 'admin_x');
    // A slow failure lands after a newer success: error stays null.
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => { first = seen.run!().catch(() => {}); second = seen.run!(); });
    await act(async () => { calls[1]!.resolve({ ok: 1 }); await second; });
    await act(async () => { calls[0]!.reject(new Error('old failure')); await first; });
    expect(seen.run!.error).toBeNull();
    expect(seen.run!.pending).toBe(false);
    // And the other way: the latest call fails, an older success lands after it — the failure stands.
    let third!: Promise<unknown>;
    let fourth!: Promise<unknown>;
    act(() => { third = seen.run!(); fourth = seen.run!().catch(() => {}); });
    await act(async () => { calls[3]!.reject(new Error('latest failure')); await fourth; });
    await act(async () => { calls[2]!.resolve({ ok: 1 }); await third; });
    expect(seen.run!.error?.message).toBe('latest failure');
    expect(seen.run!.pending).toBe(false);
  });

  it('calls the declared action, returns its result and records the outcome without params', async () => {
    const { app, authenticatedFetch, capture } = fakeApp([Response.json({ meta: { changes: 1 } })]);
    const seen = await mount(app, 'admin_delete_group');
    let result: unknown;
    await act(async () => { result = await seen.run!({ group_id: 'g-secret' }); });
    expect(result).toEqual({ meta: { changes: 1 } });
    expect(authenticatedFetch).toHaveBeenCalledWith(`${API}/v1/apps/moder/actions/admin_delete_group`, expect.objectContaining({ body: JSON.stringify({ params: { group_id: 'g-secret' } }) }));
    expect(capture).toHaveBeenCalledWith('info', 'admin.action', 'admin action admin_delete_group ok', { action: 'admin_delete_group', outcome: 'ok', status: undefined });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('g-secret');
    expect(seen.run!.pending).toBe(false);
    expect(seen.run!.error).toBeNull();
  });

  it('cannot reach an action the caller\'s roles do not allow: the server refuses and the hook surfaces it', async () => {
    const { app, capture } = fakeApp([Response.json({ error: 'requires app role' }, { status: 403 })], ['member']);
    const seen = await mount(app, 'admin_delete_group');
    let caught: unknown;
    await act(async () => { await seen.run!({ group_id: 'g1' }).catch((e) => { caught = e; }); });
    expect(caught).toBeInstanceOf(ActionError);
    expect(caught).toMatchObject({ status: 403, code: 'requires app role', forbidden: true, stepUpRequired: false });
    expect(seen.run!.error).toBe(caught);
    expect(capture).toHaveBeenCalledWith('warn', 'admin.action', 'admin action admin_delete_group refused', { action: 'admin_delete_group', outcome: 'refused', status: 403 });
    act(() => seen.run!.reset());
    expect(seen.run!.error).toBeNull();
  });

  it('step_up_required: hands the error to onStepUp and retries once when it resolves true', async () => {
    const { app, authenticatedFetch } = fakeApp([
      Response.json({ error: 'step_up_required', message: 'Recent passkey verification required', max_age: 300, method: 'passkey' }, { status: 403 }),
      Response.json({ rows: [] }),
    ]);
    const onStepUp = vi.fn(async (e: ActionError) => e.needsPasskey);
    const seen = await mount(app, 'resolve_report', onStepUp);
    let result: unknown;
    await act(async () => { result = await seen.run!({ report_id: 'r1' }); });
    expect(onStepUp).toHaveBeenCalledOnce();
    expect(onStepUp.mock.calls[0]![0]).toMatchObject({ stepUpRequired: true, needsPasskey: true, forbidden: false, body: { max_age: 300 } });
    expect(result).toEqual({ rows: [] });
    expect(authenticatedFetch.mock.calls.filter(([u]) => String(u).includes('/actions/'))).toHaveLength(2);
  });

  it('step_up_required without a handler (or a declined one) rejects with the error', async () => {
    const stepUp = () => Response.json({ error: 'step_up_required', message: 'Recent authentication required', max_age: 300 }, { status: 403 });
    for (const onStepUp of [undefined, async () => false]) {
      const { app, authenticatedFetch } = fakeApp([stepUp()]);
      const seen = await mount(app, 'resolve_report', onStepUp);
      let caught: unknown;
      await act(async () => { await seen.run!({}).catch((e) => { caught = e; }); });
      expect(caught).toMatchObject({ code: 'step_up_required', stepUpRequired: true, needsPasskey: false });
      expect(seen.run!.error).toBe(caught);
      expect(authenticatedFetch.mock.calls.filter(([u]) => String(u).includes('/actions/'))).toHaveLength(1);
    }
  });
});

describe('AdminConsole error boundary (#299)', () => {
  it('a panel that throws while rendering shows a fallback and is recorded', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, capture } = fakeApp([]);
    function Broken(): never { throw new Error('panel broke'); }
    await act(async () => root.render(<AdminConsole app={app}><Broken /></AdminConsole>));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
    expect(capture).toHaveBeenCalledWith('error', 'react.error-boundary', expect.stringContaining('panel broke'), expect.anything());
    errors.mockRestore();
  });
});

describe('exports (#299)', () => {
  it('the hooks are exported from the package root and from /hooks', () => {
    for (const mod of [sdk, hooks] as Record<string, unknown>[]) {
      for (const name of ['AdminConsole', 'AdminErrorBoundary', 'useAdminContext', 'useAction', 'ActionError']) expect(typeof mod[name], name).toBe('function');
    }
  });
});
