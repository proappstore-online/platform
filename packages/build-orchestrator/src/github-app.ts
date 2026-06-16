// GitHub App auth for the build orchestrator (ADR-006, Phase 2).
// Mints a short-lived, repo-scoped installation access token so the build
// container can clone WITHOUT any org-level secret — this is also the multi-org
// enabler (the App installs on any org; tokens are per-installation).
//
// Flow: App private key (RS256) → signed JWT (≤10 min) → POST
// /app/installations/:id/access_tokens → installation token (≤1h, repo-scoped).

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Strip PEM armor + decode base64 to the DER bytes for crypto.subtle import. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

/**
 * Build a GitHub App JWT signed RS256 with the App's PKCS8 private key.
 * `nowSec` is injected (not Date.now) so it's deterministically testable.
 */
export async function appJwt(appId: string, privateKeyPem: string, nowSec: number): Promise<string> {
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  // iat backdated 60s for clock skew; exp 9 min out (GitHub max is 10).
  const payload = b64url(
    enc.encode(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId })),
  );
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

export interface AppCreds {
  appId: string;
  privateKeyPem: string;
}

/**
 * Exchange the App JWT for an installation access token scoped to a single repo.
 * `fetchFn`/`nowSec` are injected for testability. Returns the token string.
 */
export async function mintInstallationToken(
  creds: AppCreds,
  installationId: number,
  repoName: string,
  nowSec: number,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const jwt = await appJwt(creds.appId, creds.privateKeyPem, nowSec);
  const res = await fetchFn(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'pas-build-orchestrator',
        'Content-Type': 'application/json',
      },
      // Scope the token to just this repo + the minimum permission (clone).
      body: JSON.stringify({ repositories: [repoName], permissions: { contents: 'read' } }),
    },
  );
  if (!res.ok) {
    throw new Error(`installation token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('installation token response had no token');
  return data.token;
}
