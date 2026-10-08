import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ProAppStore } from './index.js';
import type { User } from './base-types.js';
import type { AuthStatus } from './auth.js';
import { ActionError } from './actions.js';
import { ProProvider, resolveApp } from './provider.js';
import { ShellErrorBoundary, type ShellErrorContext } from './shell-resilience.js';

// Custom admin panels (#299). A panel is app code that runs on the app's own
// origin, never inside the PAS console (#291 §4): it reaches data only through
// the app's declared actions, and the action executor enforces auth, roles,
// step-up and audit on every call. Nothing here grants or checks access itself —
// `roles` is for rendering, the server is the authority.

/** What a custom admin panel knows about who is using it. */
export interface AdminContextValue {
  app: { id: string };
  user: User | null;
  /** The caller's roles in this app, as the server reports them (`GET /v1/apps/:id/roles/me`). Empty until loaded. */
  roles: string[];
  session: {
    status: AuthStatus;
    /** False while the caller's roles are still being fetched, and when fetching them failed. */
    rolesLoaded: boolean;
    /** Why the latest roles fetch failed (#344), or null. An empty `roles` with no error means the caller holds none. */
    rolesError: Error | null;
    /** Re-read the caller's roles, e.g. after the owner granted one. */
    refreshRoles: () => Promise<void>;
  };
}

const NO_ROLES: string[] = [];
const AdminContext = createContext<AdminContextValue | null>(null);

export interface AdminConsoleProps {
  app?: ProAppStore;
  children: ReactNode;
  /** Shown instead of the panel when it throws while rendering. */
  renderError?: (ctx: ShellErrorContext) => ReactNode;
}

/**
 * The frame for a custom admin panel: provides the app (as {@link ProProvider}
 * does) and {@link useAdminContext}, and
 * catches a render error in the panel (recorded through `app.logs`), so one
 * broken panel shows a fallback instead of a white screen.
 */
export function AdminConsole({ app: explicit, children, renderError }: AdminConsoleProps) {
  const app = resolveApp(explicit);
  const [auth, setAuth] = useState(() => ({ status: app.auth.status, user: app.auth.user }));
  const [roles, setRoles] = useState<{ for: string | null; list: string[]; error: Error | null }>({ for: null, list: [], error: null });

  useEffect(() => {
    const unsubscribe = app.auth.onStatus((status, user) => setAuth({ status, user }));
    void app.auth.init();
    return unsubscribe;
  }, [app]);

  const userId = auth.user?.id ?? null;
  // Only the latest roles request may write (#338): each call takes the next
  // number, and a user switch or unmount (the effect's cleanup) moves it on, so
  // a slower earlier answer, or one for the previous user, is dropped.
  const latest = useRef(0);
  const refreshRoles = useCallback(async () => {
    const request = ++latest.current;
    if (!userId) return setRoles({ for: null, list: [], error: null });
    // A failed fetch is an error, not "no roles" (#344): the panel can say so and retry.
    let next: { list: string[]; error: Error | null };
    try { next = { list: await app.roles.myRoles({ throwOnError: true }), error: null }; } catch (e) { next = { list: [], error: e instanceof Error ? e : new Error(String(e)) }; }
    if (request === latest.current) setRoles({ for: userId, ...next });
  }, [app, userId]);
  useEffect(() => {
    void refreshRoles();
    return () => { latest.current++; };
  }, [refreshRoles]);

  // Roles fetched for a previous user are never shown for the current one.
  const current = roles.for === userId ? roles.list : NO_ROLES;
  const rolesError = roles.for === userId ? roles.error : null;
  const value = useMemo<AdminContextValue>(() => ({
    app: { id: app.appId },
    user: auth.user,
    roles: current,
    session: { status: auth.status, rolesLoaded: userId !== null && roles.for === userId && rolesError === null, rolesError, refreshRoles },
  }), [app.appId, auth, current, userId, roles.for, rolesError, refreshRoles]);

  return (
    <ProProvider app={app}>
      <AdminContext.Provider value={value}>
        <ShellErrorBoundary app={app} renderError={renderError} resetKey="">{children}</ShellErrorBoundary>
      </AdminContext.Provider>
    </ProProvider>
  );
}

/** `{ app, user, roles, session }` for a custom admin panel. Throws outside {@link AdminConsole}. */
export function useAdminContext(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdminContext() must be used inside <AdminConsole>');
  return ctx;
}

export interface UseActionOptions {
  /**
   * Called when the server answers `step_up_required` (the action declares
   * `step_up`). Re-authenticate the user and resolve `true` to retry the call
   * once; resolve `false` to give up, and the call rejects with the error. For
   * an app action this is a passkey check on the app's own origin
   * (`error.needsPasskey`, #337): run `/.pas/auth/passkey/step-up/options` then `/.pas/auth/passkey/step-up` (if
   * step-up/options answers 404 `no_passkey`, register one first through
   * `/.pas/auth/passkey/register/options` and `/register`, which need a sign-in
   * in the last 10 minutes). Signing in again alone is refused again.
   */
  onStepUp?: (error: ActionError) => boolean | Promise<boolean>;
}

/** Calls the action; also carries the state of the latest call. Its identity changes with that state, so an effect that runs it should depend on what triggers the call, not on the invoker. */
export type ActionInvoker<P, T> = ((params?: P) => Promise<T>) & {
  pending: boolean;
  /** The latest call's failure (#344: an older call settling later never overwrites it): an {@link ActionError} for a server refusal (`forbidden`, `stepUpRequired`). */
  error: Error | null;
  reset: () => void;
};

/**
 * Call one of the app's declared actions from an admin panel.
 *
 *   const resolveReport = useAction('resolve_report', { onStepUp });
 *   await resolveReport({ report_id, decision: 'approve' });
 *
 * The server decides: an action the caller's roles do not allow rejects with an
 * {@link ActionError} whose `forbidden` is true, and the hook's `error` is set.
 * Every outcome is recorded through `app.logs` (category `admin.action`: the
 * action, outcome and status — never the params), beside the platform's own
 * audit of the call.
 */
export function useAction<P extends Record<string, unknown> = Record<string, unknown>, T = unknown>(
  name: string,
  opts: UseActionOptions & { app?: ProAppStore } = {},
): ActionInvoker<P, T> {
  const app = resolveApp(opts.app);
  const [state, setState] = useState<{ pending: number; error: Error | null }>({ pending: 0, error: null });
  const { onStepUp } = opts;
  // Only the latest call decides `error` (#344); every call still settles `pending`.
  const latest = useRef(0);

  const call = useCallback(async (params?: P): Promise<T> => {
    const id = ++latest.current;
    setState((s) => ({ pending: s.pending + 1, error: null }));
    const record = (outcome: string, status?: number) =>
      app.logs.capture(outcome === 'ok' ? 'info' : 'warn', 'admin.action', `admin action ${name} ${outcome}`, { action: name, outcome, status });
    try {
      let result: T;
      try {
        result = await app.actions.call<T>(name, params ?? {});
      } catch (e) {
        if (!(e instanceof ActionError && e.stepUpRequired && onStepUp)) throw e;
        if (!(await onStepUp(e))) throw e;
        result = await app.actions.call<T>(name, params ?? {});
      }
      record('ok');
      setState((s) => ({ pending: s.pending - 1, error: id === latest.current ? null : s.error }));
      return result;
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      record(error instanceof ActionError ? (error.forbidden ? 'refused' : error.code ?? 'failed') : 'failed', error instanceof ActionError ? error.status : undefined);
      setState((s) => ({ pending: s.pending - 1, error: id === latest.current ? error : s.error }));
      throw error;
    }
  }, [app, name, onStepUp]);

  const reset = useCallback(() => setState((s) => ({ ...s, error: null })), []);
  return useMemo(() => Object.assign((params?: P) => call(params), { pending: state.pending > 0, error: state.error, reset }), [call, state, reset]);
}

/** Catches a render error in part of a panel; recorded through `app.logs`. {@link AdminConsole} already wraps the whole panel in one. */
export function AdminErrorBoundary({ app, children, renderError }: { app?: ProAppStore; children: ReactNode; renderError?: (ctx: ShellErrorContext) => ReactNode }) {
  return <ShellErrorBoundary app={resolveApp(app)} renderError={renderError} resetKey="">{children}</ShellErrorBoundary>;
}
