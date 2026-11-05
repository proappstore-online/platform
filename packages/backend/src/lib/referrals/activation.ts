import type { MiddlewareHandler } from 'hono';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../../types.js';
import { APP_CONTEXT_HEADER } from '../app-context.js';
import { parseCredentialContext } from '../accounts/credential-context.js';
import { recordActivation } from './service.js';

/**
 * The authoritative first-app-activation event (#550). After a request has succeeded, if it was
 *   - host-mediated (the host's `X-PAS-App` claim, which only the private HostApi binding can set),
 *   - authenticated by a valid PAS session that is bound to THAT app (`app_bound`, never first-party), and
 *   - not telemetry ingestion or the referral claim itself,
 * then this person has activated this app, and the server records it. Everything is read from the request by the
 * server: a client cannot send, forge or edit an activation. A request with no session, a failed request, a page
 * load, a token being issued, and a direct (unmediated) API call are not activations.
 *
 * Failures are swallowed: this observes traffic and must never break a request.
 */
const EXEMPT = /^\/v1\/(storefront\/|apps\/[^/]+\/(logs|referrals\/claim)(\/|$))/;

export const activationObserver: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  try {
    const appId = c.req.header(APP_CONTEXT_HEADER);
    const header = c.req.header('Authorization');
    if (!appId || !header?.startsWith('Bearer ') || c.req.method === 'OPTIONS' || c.res.status >= 400) return;
    if (EXEMPT.test(new URL(c.req.url).pathname)) return;
    const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
    const context = parseCredentialContext(claims?.cred);
    if (!claims || claims.via || context?.kind !== 'app_bound' || context.appId !== appId) return;
    // One indexed read for a person already recorded; the write batch only runs for a first activation.
    await recordActivation(c.env.DB, appId, claims.uid);
  } catch (error) {
    console.warn(`activation observer: ${(error as Error)?.message ?? error}`);
  }
};
