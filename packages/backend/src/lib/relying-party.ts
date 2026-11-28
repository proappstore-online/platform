/**
 * Passkey relying parties (#230, #244, #331, #334, #698): the one place that
 * decides which WebAuthn relying party a request belongs to, and so which
 * `step_up_rp_id` audience a passkey step-up can mint.
 *
 * - **App origin.** Reachable only through the host's mediation: the relying
 *   party is the app hostname the host asserts in `X-PAS-Host` (the page cannot,
 *   #315), and the ceremony's origin must be exactly that hostname.
 * - **Creator Console.** A legacy-bearer page that calls the API directly, with
 *   no mediation. It is served at `console.proappstore.online` and at the
 *   storefront's `proappstore.online/app/` mirror (#698), so its relying party is
 *   the registrable parent `proappstore.online`, which WebAuthn lets both hosts
 *   use. A ceremony must come from one of those two origins exactly: an app page
 *   on `<app>.proappstore.online` can also name this RP id, but its
 *   clientDataJSON carries its own origin and is refused.
 */
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { APP_CONTEXT_HEADER, APP_HOST_HEADER } from './app-context.js';

/** The Creator Console's relying party, and the `step_up_rp_id` its step-ups carry (#698). */
export const CONSOLE_RP_ID = 'proappstore.online';

/**
 * Every origin the Console is served from. Both are first-party: the apex is the
 * storefront's Pages project (static, `script-src 'self'`) proxying `/app/*` to
 * the console, and the host Worker proxies `console.` to the same project.
 */
const CONSOLE_ORIGINS: ReadonlySet<string> = new Set(['https://proappstore.online', 'https://console.proappstore.online']);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface RelyingParty {
  /** `rp.name` in registration options: the app slug, or `console`. */
  name: string;
  /** The RP id: the rpIdHash authenticatorData must carry, a credential's `rp_id`, and the `step_up_rp_id` minted. */
  id: string;
  /** The exact `clientDataJSON.origin` a ceremony must carry. */
  origin: string;
}

/**
 * The app hostname the host mediated this request from, or undefined. Only
 * HostApi can supply the header, so a direct bearer request cannot claim an app
 * relying party to replay a step-up from another surface. A hostname the
 * Console's relying party covers is never an app's: the host serves no app
 * there and custom domains under the platform zone are refused, and refusing it
 * here too keeps an app step-up from ever minting the Console's audience.
 */
export function mediatedRelyingParty(c: Context<{ Bindings: Env }>): string | undefined {
  const rpId = c.req.header(APP_HOST_HEADER)?.toLowerCase();
  if (!rpId || !HOSTNAME.test(rpId) || rpId === CONSOLE_RP_ID || CONSOLE_ORIGINS.has(`https://${rpId}`)) return undefined;
  return rpId;
}

/**
 * The relying party of a passkey ceremony request: the mediated app hostname,
 * or — for a direct call from a Console origin, which carries neither host
 * header — the Console. A mediated request always carries X-PAS-App, so the
 * cookie data plane (which strips X-PAS-Host so page JS never receives a
 * step-up token) gets no relying party at all.
 *
 * The Console path requires the browser's Origin to be a Console origin (#334):
 * a browser sets Origin itself, so an app page holding a fresh session cannot
 * enroll a key of its own for the Console. A non-browser caller can send any
 * Origin, but it also writes clientDataJSON and, with `attestation: 'none'`, the
 * key, so Origin is exactly as strong as WebAuthn's own origin and rpIdHash
 * checks and no stronger signal exists here: api.proappstore.online is not
 * behind Cloudflare Access, and CORS lets a browser send only Authorization and
 * Content-Type. Against such a caller the boundary is the fresh sign-in that
 * registration requires.
 */
export function passkeyRelyingParty(c: Context<{ Bindings: Env }>): RelyingParty {
  const appId = c.req.header(APP_CONTEXT_HEADER);
  const origin = c.req.header('Origin');
  if (!appId && !c.req.header(APP_HOST_HEADER) && origin && CONSOLE_ORIGINS.has(origin)) {
    return { name: 'console', id: CONSOLE_RP_ID, origin };
  }
  const rpId = mediatedRelyingParty(c);
  if (!appId || !rpId) throw new HttpError('passkeys are only available on an app origin or the console', 400);
  return { name: appId, id: rpId, origin: `https://${rpId}` };
}
