/**
 * Passkey relying parties (#230, #244, #331, #334, #698, #699): the one place
 * that decides, for a passkey request, which WebAuthn relying party its
 * credentials belong to and which `step_up_rp_id` audience a step-up mints.
 *
 * Those are two different things since #699:
 *
 * - **Credential RP id** (`RelyingParty.id`): the rpIdHash authenticatorData must
 *   carry and the `rp_id` a credential is stored under. Every surface on the
 *   platform zone shares one, `proappstore.online` (PLATFORM_RP_ID), so a person
 *   enrols one passkey and it works on the Console and in every app on
 *   `*.proappstore.online`.
 * - **Step-up audience** (`RelyingParty.audience`): the surface the ceremony ran
 *   on, and the `step_up_rp_id` minted. The Console's audience is
 *   CONSOLE_STEP_UP_AUDIENCE; an app's is its own hostname. A step-up done in one
 *   app therefore never authorises another app or the Console, and the reverse.
 *
 * Every ceremony is still bound to its exact origin (`clientDataJSON.origin`):
 *
 * - **App origin.** Reachable only through the host's mediation: the surface is
 *   the app hostname the host asserts in `X-PAS-Host` (the page cannot, #315),
 *   and the ceremony's origin must be exactly `https://<that hostname>`.
 * - **Creator Console.** A legacy-bearer page that calls the API directly, with
 *   no mediation, served at `console.proappstore.online` and at the storefront's
 *   `proappstore.online/app/` mirror (#698). A ceremony must come from one of
 *   those two origins exactly.
 *
 * **Custom domains.** WebAuthn only lets a page use an RP id that is its own
 * host or a registrable suffix of it, so an app on a domain outside
 * proappstore.online cannot use the shared RP id. Its credential RP id stays its
 * own hostname: a passkey there is enrolled separately and works only there.
 * Related Origin Requests are not used: they cap a relying party at five
 * registrable labels, which cannot cover an open set of creator domains.
 */
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { APP_CONTEXT_HEADER, APP_HOST_HEADER } from './app-context.js';

/** The credential RP id every surface on the platform zone shares (#699). */
export const PLATFORM_RP_ID = 'proappstore.online';

/** The `step_up_rp_id` a Console step-up carries, and the only one Console-gated actions accept (#698). */
export const CONSOLE_STEP_UP_AUDIENCE = 'proappstore.online';

/**
 * Every origin the Console is served from. Both are first-party: the apex is the
 * storefront's Pages project (static, `script-src 'self'`) proxying `/app/*` to
 * the console, and the host Worker proxies `console.` to the same project.
 */
const CONSOLE_ORIGINS: ReadonlySet<string> = new Set(['https://proappstore.online', 'https://console.proappstore.online']);

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface RelyingParty {
  /** `rp.name` in registration options: `ProAppStore` for the shared RP id, else the app slug. */
  name: string;
  /** The credential RP id: the rpIdHash authenticatorData must carry and a credential's `rp_id`. */
  id: string;
  /** The surface's step-up audience: the `step_up_rp_id` a step-up here mints. */
  audience: string;
  /** The exact `clientDataJSON.origin` a ceremony must carry. */
  origin: string;
}

/** The credential RP id for an app hostname: the shared one on the platform zone, else the hostname itself. */
function appCredentialRpId(hostname: string): string {
  return hostname.endsWith(`.${PLATFORM_RP_ID}`) ? PLATFORM_RP_ID : hostname;
}

/**
 * The app hostname the host mediated this request from, or undefined: the
 * app's step-up audience. Only
 * HostApi can supply the header, so a direct bearer request cannot claim an app
 * relying party to replay a step-up from another surface. A hostname the
 * Console's relying party covers is never an app's: the host serves no app
 * there and custom domains under the platform zone are refused, and refusing it
 * here too keeps an app step-up from ever minting the Console's audience.
 */
export function mediatedRelyingParty(c: Context<{ Bindings: Env }>): string | undefined {
  const rpId = c.req.header(APP_HOST_HEADER)?.toLowerCase();
  if (!rpId || !HOSTNAME.test(rpId) || rpId === CONSOLE_STEP_UP_AUDIENCE || CONSOLE_ORIGINS.has(`https://${rpId}`)) return undefined;
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
    return { name: 'ProAppStore', id: PLATFORM_RP_ID, audience: CONSOLE_STEP_UP_AUDIENCE, origin };
  }
  const host = mediatedRelyingParty(c);
  if (!appId || !host) throw new HttpError('passkeys are only available on an app origin or the console', 400);
  const id = appCredentialRpId(host);
  return { name: id === PLATFORM_RP_ID ? 'ProAppStore' : appId, id, audience: host, origin: `https://${host}` };
}
