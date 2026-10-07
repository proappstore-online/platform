/**
 * Who may use the console operator view, and per-request marks for its audit
 * trail (#240, #293).
 *
 * - requireOperatorAccess: the owner (creator, team `owner` or platform admin),
 *   or a holder of one of the app roles the contract declares in
 *   `admin_access.roles` (#302). Admission grants no action by itself: every
 *   read and write still runs under the referenced action's own role gate,
 *   step_up and audit (routes/operator-exec.ts).
 * - requireOperatorOwner: the owner only, for the routes the admin gate does not
 *   open (the audit trail keeps its own gate; the platform-held users list).
 *
 * Both remember the admitted caller for this request; the executor marks a
 * request once it has written its audit row. The refusal middleware
 * (routes/operator-audit.ts) then records every refused attempt by an admitted
 * caller exactly once — and nothing for callers who never got past the gate, so
 * a stranger cannot fill an app's trail.
 */
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppOwner, requireUser, type FasUser } from './auth.js';
import { roleSubjects } from './role-subject.js';
import { APP_CONTEXT_HEADER } from './app-context.js';

const admitted = new WeakMap<Request, FasUser>();
const audited = new WeakSet<Request>();

/**
 * The operator view and its authoring routes answer the console's direct Bearer
 * calls only (#300). A request the host mediated from an app origin carries
 * X-PAS-App: it is page JS on some app holding the visitor's cookie session —
 * any app's page, not the console — so it never reaches an owner's or admin's
 * operator data or actions.
 */
export function refuseAppMediated(c: Context<{ Bindings: Env }>): void {
  if (c.req.header(APP_CONTEXT_HEADER) !== undefined) throw new HttpError('the operator view is not reachable from an app page', 403);
}

/** requireAppOwner, remembering the owner for the refusal audit. */
export async function requireOperatorOwner(c: Context<{ Bindings: Env }>, appId: string): Promise<FasUser> {
  refuseAppMediated(c);
  const owner = await requireAppOwner(c, appId);
  admitted.set(c.req.raw, owner);
  return owner;
}

/**
 * Whether `user` holds one of the app's declared `admin_access.roles` (#293),
 * read from the stored contract and `app_roles` on every request (no caching,
 * so a revoked role or a removed declaration refuses the next request). The
 * role subject is #272's: a GitHub session's login alias, never another
 * provider's free-text login.
 */
export async function holdsOperatorAdminRole(db: D1Database, appId: string, user: FasUser): Promise<boolean> {
  return Boolean(await db.prepare(
    `SELECT 1 FROM app_operator_view v, json_each(v.contract, '$.admin_access.roles') declared
      WHERE v.app_id = ?1
        AND EXISTS (SELECT 1 FROM app_roles r WHERE r.app_id = ?1 AND (r.user_id = ?2 OR r.user_id = ?3) AND r.role_name = declared.value)
      LIMIT 1`,
  ).bind(appId, ...roleSubjects(user)).first());
}

/** The owner, or a holder of a declared admin role (#293); remembered for the refusal audit. */
export async function requireOperatorAccess(c: Context<{ Bindings: Env }>, appId: string): Promise<FasUser> {
  refuseAppMediated(c);
  let caller: FasUser;
  try {
    caller = await requireAppOwner(c, appId);
  } catch (e) {
    // Signed out (401) and an unknown app (404) stay as they are; only "not the owner" can be an admin.
    if (!(e instanceof HttpError) || e.status !== 403) throw e;
    const user = await requireUser(c);
    if (!(await holdsOperatorAdminRole(c.env.DB, appId, user))) {
      throw new HttpError("the operator view needs the app owner or one of the app's admin roles", 403);
    }
    caller = user;
  }
  admitted.set(c.req.raw, caller);
  return caller;
}

export const operatorCallerOf = (req: Request): FasUser | undefined => admitted.get(req);
export const markAudited = (req: Request): void => { audited.add(req); };
export const wasAudited = (req: Request): boolean => audited.has(req);
