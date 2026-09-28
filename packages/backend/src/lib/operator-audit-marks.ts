/**
 * Per-request marks for the operator audit trail (#240). The operator routes
 * check ownership through requireOperatorOwner, which remembers the owner for
 * this request; the executor marks a request once it has written its audit
 * row. The refusal middleware (routes/operator-audit.ts) then records every
 * refused attempt by an owner exactly once — and nothing for callers who never
 * got past the ownership check, so a stranger cannot fill an app's trail.
 */
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { requireAppOwner, type FasUser } from './auth.js';

const owners = new WeakMap<Request, FasUser>();
const audited = new WeakSet<Request>();

/** requireAppOwner, remembering the owner for the refusal audit. */
export async function requireOperatorOwner(c: Context<{ Bindings: Env }>, appId: string): Promise<FasUser> {
  const owner = await requireAppOwner(c, appId);
  owners.set(c.req.raw, owner);
  return owner;
}

export const operatorOwnerOf = (req: Request): FasUser | undefined => owners.get(req);
export const markAudited = (req: Request): void => { audited.add(req); };
export const wasAudited = (req: Request): boolean => audited.has(req);
