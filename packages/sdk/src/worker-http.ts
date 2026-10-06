/**
 * `pro.worker.fetch(path, init)` — call the app's own worker (#260) from the
 * browser: `/.pas/worker/<path>` on the app origin, with the session cookie.
 * The platform resolves the signed-in user and the worker runs actions as them.
 * Same-origin only (the session cookie is the credential), so it needs the
 * cookie auth mode the platform host serves apps with.
 */
export class WorkerHttp {
  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return fetch(`/.pas/worker${suffix}`, { credentials: 'same-origin', ...init });
  }
}
