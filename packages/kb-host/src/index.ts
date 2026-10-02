/**
 * proappstore-kb-host — serves every project's Knowledge Base site from ONE R2
 * bucket at kb.proappstore.online/<app>/…  (Path B: one Worker + one bucket, no
 * CF Pages project per KB). CI builds each KB to a Zensical static site and
 * uploads it to R2 under "<app>/*"; this Worker maps the request path to that
 * key. Official platform docs use the same generated site under the "platform"
 * prefix, exposed publicly at docs.proappstore.online/.
 *
 *   GET kb.proappstore.online/myapp/            → R2  myapp/index.html
 *   GET kb.proappstore.online/myapp/setup/      → R2  myapp/setup/index.html
 *   GET kb.proappstore.online/myapp/assets/x.css→ R2  myapp/assets/x.css
 *   GET docs.proappstore.online/ui/             → R2  platform/ui/index.html
 *
 * Dedicated subdomain, NOT a wildcard route — so it can't preempt sibling Worker
 * custom_domains on the zone.
 */

import { verifyGithubOidc } from "./github-oidc.js";

const ORG = "proappstore-online";
/** Audience the KB-ingest OIDC token must request (set in the workflow). */
const OIDC_AUDIENCE = "proappstore-kb-host";
/** Only this repo's CI may write the reserved `platform/` docs prefix. */
const DOCS_REPO = `${ORG}/platform`;

export interface Env {
  KB_R2: R2Bucket;
  DB: D1Database;
  /** Platform-only read credential; never accepted for ingest. */
  INTERNAL_TOKEN?: string;
}

/**
 * Authorize a KB ingest write to `<prefix>/…` (#57). One path, app-scoped: the
 * caller's GitHub Actions OIDC token carries `repository = proappstore-online/<app>`
 * and may only write its own app prefix. The reserved `platform/` prefix (the
 * official docs, served as HTML on docs.proappstore.online) requires the docs
 * repo. Anything else — including the retired shared `x-internal-token` — is a
 * 403: a secret handed to every app's CI cannot say which app is calling.
 */
async function authorizeIngest(
  request: Request,
  prefix: string,
): Promise<{ ok: true } | { ok: false; status: number; msg: string }> {
  const authz = request.headers.get("authorization");
  if (authz?.startsWith("Bearer ")) {
    let repo: string;
    try {
      const claims = await verifyGithubOidc(authz.slice(7), { audience: OIDC_AUDIENCE });
      repo = claims.repository;
    } catch (e) {
      return { ok: false, status: 403, msg: `invalid OIDC token: ${(e as Error).message}` };
    }
    if (prefix === "platform") {
      return repo === DOCS_REPO
        ? { ok: true }
        : { ok: false, status: 403, msg: `repository ${repo} may not write platform/` };
    }
    return repo === `${ORG}/${prefix}`
      ? { ok: true }
      : { ok: false, status: 403, msg: `repository ${repo} may not write ${prefix}/` };
  }
  return { ok: false, status: 403, msg: "forbidden: ingest requires a GitHub Actions OIDC token" };
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  eot: "application/vnd.ms-fontobject",
  xml: "application/xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  map: "application/json; charset=utf-8",
};

function contentType(key: string): string {
  const ext = key.includes(".") ? key.split(".").pop()!.toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const DOCS_HOSTS = new Set(["docs.proappstore.online"]);

function isDocsHost(hostname: string): boolean {
  return DOCS_HOSTS.has(hostname.toLowerCase());
}

/** Map a request path to an R2 key. Directory / extensionless paths -> index.html. */
export function keyForPath(pathname: string, hostname = "kb.proappstore.online"): string | null {
  let key = decodeURIComponent(pathname.replace(/^\/+/, ""));
  if (isDocsHost(hostname)) key = key ? `platform/${key}` : "platform/";
  if (key === "") return null; // bare KB host — no KB selected
  if (key.includes("..")) return null; // path traversal guard
  if (key.endsWith("/")) key += "index.html";
  else if (!key.split("/").pop()!.includes(".")) key += "/index.html"; // pretty URL -> dir index
  return key;
}

/** Compare without an early return on a differing byte. */
function equalToken(actual: string | null, expected: string): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "proappstore-kb-host", version: "0.1.0" });
    }

    // ── Ingest: CI uploads each built KB file here, written to R2 via the
    //    binding (no R2 API token needed → no token-scope 403). Authed by the
    //    caller's GitHub Actions OIDC token. PUT /_ingest/<app>/<path>, file as body.
    if (request.method === "PUT" && url.pathname.startsWith("/_ingest/")) {
      const key = decodeURIComponent(url.pathname.slice("/_ingest/".length));
      if (!key || key.includes("..") || key.endsWith("/")) return new Response("bad key", { status: 400 });
      // SECURITY (#57): authorize the write against the app prefix from the
      // OIDC `repository` claim — a shared token could not say which app was
      // calling, so any holder could overwrite any app's KB or the official docs.
      const prefix = key.split("/")[0]!;
      const authz = await authorizeIngest(request, prefix);
      if (!authz.ok) return new Response(authz.msg, { status: authz.status });
      await env.KB_R2.put(key, request.body);
      return new Response("ok\n");
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    if (isDocsHost(url.hostname) && (url.pathname === "/platform" || url.pathname.startsWith("/platform/"))) {
      url.pathname = url.pathname.replace(/^\/platform/, "") || "/";
      return Response.redirect(url.toString(), 301);
    }

    const key = keyForPath(url.pathname, url.hostname);
    if (key === null) {
      return new Response("ProAppStore Knowledge Base host - visit kb.proappstore.online/<app>/ or docs.proappstore.online", { status: 404 });
    }

    // Check before R2, custom 404 pages and conditional responses. Never guess
    // public on a lookup failure, and never cache private bytes in a browser.
    const app = key.split("/")[0]!;
    let privateApp = false;
    if (app !== "platform") {
      try {
        const row = await env.DB.prepare("SELECT mode FROM app_visibility WHERE app_id = ?")
          .bind(app).first<{ mode: string }>();
        privateApp = row?.mode === "private";
      } catch {
        return new Response("Knowledge base unavailable", { status: 503, headers: { "cache-control": "no-store" } });
      }
    }
    const privateHeaders: Record<string, string> = privateApp ? { "cache-control": "private, no-store" } : {};
    if (privateApp && !(env.INTERNAL_TOKEN && equalToken(request.headers.get("x-internal-token"), env.INTERNAL_TOKEN))) {
      return new Response("Not found", { status: 404, headers: privateHeaders });
    }

    const obj = await env.KB_R2.get(key);
    if (!obj) {
      // Serve the app's own 404 page if it has one (Zensical/Material ships one),
      // else a plain 404.
      const app = key.split("/")[0];
      const custom404 = app ? await env.KB_R2.get(`${app}/404.html`) : null;
      if (custom404) {
        return new Response(custom404.body, { status: 404, headers: { "content-type": "text/html; charset=utf-8", ...privateHeaders } });
      }
      return new Response("Not found", { status: 404, headers: privateHeaders });
    }

    const etag = obj.httpEtag;
    if (request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag, ...privateHeaders } });
    }

    const headers = new Headers();
    headers.set("content-type", contentType(key));
    headers.set("etag", etag);
    // HTML revalidates quickly (KB changes on each redeploy); fingerprinted
    // assets cache long.
    headers.set("cache-control", privateApp ? "private, no-store" : key.endsWith(".html") ? "public, max-age=60, must-revalidate" : "public, max-age=86400");
    headers.set("x-content-type-options", "nosniff");
    return new Response(request.method === "HEAD" ? null : obj.body, { headers });
  },
};
