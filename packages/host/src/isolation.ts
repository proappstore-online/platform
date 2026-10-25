/**
 * Opt-in cross-origin isolation (#452). An app that declares `isolation` in its mcp.json
 * (validated at registration, backend lib/manifest/isolation.ts) gets the headers that make
 * `crossOriginIsolated` true, so `SharedArrayBuffer`, high-resolution timers and WebAssembly
 * threads work. Every other app is untouched.
 *
 * - documents (HTML): `Cross-Origin-Opener-Policy: same-origin` + the COEP below
 * - scripts: the COEP only. A Worker or service worker script must carry the embedder policy
 *   of the page that starts it, or the browser refuses to run it in an isolated page.
 * - nothing else changes (images, fonts and data files are same-origin, so COEP lets them through).
 *
 * `cross-origin` uses COEP `credentialless` (Chromium, Firefox); Safari does not support it, so
 * an app that must isolate there asks for `cross-origin-strict` (`require-corp`).
 */

export type IsolationMode = "cross-origin" | "cross-origin-strict";

const COEP: Record<IsolationMode, string> = {
  "cross-origin": "credentialless",
  "cross-origin-strict": "require-corp",
};

const isMode = (v: unknown): v is IsolationMode => v === "cross-origin" || v === "cross-origin-strict";

/** Whether an R2 key is a script a page or a worker may load. */
export function isScriptKey(key: string): boolean {
  return /\.(?:m?js)$/i.test(key);
}

/**
 * The app's declared mode, or null (the default) when it declares none. Never throws: a missing
 * table (migration not applied yet), an unreadable row or a database error all mean "not
 * isolated" rather than a failed page. Isolation only ever takes things away from a page, so
 * the safe failure is to leave the default behaviour.
 */
export async function getIsolationMode(db: D1Database, appId: string): Promise<IsolationMode | null> {
  try {
    const row = await db.prepare("SELECT mode FROM app_isolation WHERE app_id = ?1").bind(appId).first<{ mode: string }>();
    return row && isMode(row.mode) ? row.mode : null;
  } catch (e) {
    if (!/no such table/i.test(String((e as Error)?.message ?? e))) console.error(`[isolation] could not read the isolation mode for ${appId}: ${(e as Error)?.message ?? e}`);
    return null;
  }
}

/** Add the isolation headers for `mode` to a response's headers. No mode: no change. */
export function applyIsolation(headers: Headers, mode: IsolationMode | null, kind: { isHtml: boolean }): void {
  if (!mode) return;
  headers.set("Cross-Origin-Embedder-Policy", COEP[mode]);
  if (kind.isHtml) headers.set("Cross-Origin-Opener-Policy", "same-origin");
}
