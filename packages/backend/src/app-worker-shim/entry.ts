/**
 * `__pas_entry.js` — the platform-owned entry module of every app worker
 * (ADR-009 §1). It is always the worker's main module; the app's own code is the
 * module `app.js` beside it, imported only after the request's event envelope
 * signature verifies. A request that fails gets 401 and no app module is
 * evaluated, not even its top-level code.
 *
 * Built to a single module at backend build time (scripts/embed-app-worker-shim.mjs)
 * and shipped with every invocation; apps cannot replace it (a bundle part named
 * `__pas_entry.js` is refused at deploy).
 *
 * The app module's contract is a default export with `fetch(request, env, ctx)`;
 * `defineAppWorker` in the SDK (#254) produces it. The request it receives is the
 * verified envelope: `POST /` with the JSON body unchanged.
 *
 * For an `http` event (#260) the shim wraps the app's Response so it survives
 * the JSON hop back to the platform: `{ v: 1, status, headers, body, body_encoding }`
 * with the app's own status, so the invocation record reflects it.
 */
import { SIGNATURE_HEADER, verifySignature } from './signature.js';
import { encodeEnvelopeBody } from './body.js';

export interface AppWorkerModule {
  default: { fetch(request: Request, env: unknown, ctx: unknown): Response | Promise<Response> };
}

/** The shim's own view of the env the platform builds (ADR-009 §2). */
interface ShimEnv {
  PAS_EVENT_KEY?: string;
}

/** The shim, with how the app module is loaded injected (tests pass a spy). */
export function createShim(loadApp: () => Promise<AppWorkerModule>, now: () => number = () => Date.now()) {
  return {
    async fetch(request: Request, env: ShimEnv, ctx: unknown): Promise<Response> {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      const body = await request.text();
      const ok = await verifySignature(request.headers.get(SIGNATURE_HEADER), body, env.PAS_EVENT_KEY ?? '', now() / 1000);
      if (!ok) return new Response('unauthorized', { status: 401 });
      const app = await loadApp();
      const response = await app.default.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body }), env, ctx);
      if (!isHttpEvent(body)) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => { headers[name] = value; });
      // 204/205/304 cannot carry a body: the wrapper answers 200, the real status travels inside.
      return Response.json(
        { v: 1, status: response.status, headers, ...encodeEnvelopeBody(bytes, response.headers.get('content-type')) },
        { status: [101, 204, 205, 304].includes(response.status) ? 200 : response.status },
      );
    },
  };
}

function isHttpEvent(body: string): boolean {
  try {
    return (JSON.parse(body) as { type?: unknown }).type === 'http';
  } catch {
    return false;
  }
}

// A non-literal specifier: the bundler leaves the import for the runtime to
// resolve against the app's uploaded `app.js`.
const APP_MODULE = './app.js';
export default createShim(() => import(APP_MODULE) as Promise<AppWorkerModule>);
