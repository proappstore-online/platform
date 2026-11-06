// PAS adaptation of HeartFull's upload + fresh-edit verification release client.
// No dependencies or credentials on disk. Google Play acceptance is not review approval.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PACKAGE = 'online.proappstore.companion';
const API = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}`;
const UPLOAD = `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE}`;
const TOKEN = 'https://oauth2.googleapis.com/token';
const MAX_CODE = 2_100_000_000;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const code = value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CODE) throw new Error('Invalid Android version code.');
  return n;
};

export class PlayRelease {
  constructor(credentials, { fetcher = fetch } = {}) {
    if (!credentials?.client_email || !credentials.private_key || (credentials.token_uri && credentials.token_uri !== TOKEN)) {
      throw new Error('Invalid Google Play service-account credential.');
    }
    this.credentials = credentials;
    this.fetcher = fetcher;
  }
  async token() {
    const now = Math.floor(Date.now() / 1000);
    const assertion = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: this.credentials.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher', aud: TOKEN, iat: now, exp: now + 3600 })}`;
    const signature = createSign('RSA-SHA256').update(assertion).end().sign(this.credentials.private_key, 'base64url');
    const response = await this.fetcher(TOKEN, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${assertion}.${signature}` }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== 'string') throw new Error(`Google Play authentication failed (HTTP ${response.status}).`);
    return body.access_token;
  }
  async request(token, method, path, body, binary = false) {
    const response = await this.fetcher(`${binary ? UPLOAD : API}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(binary ? 300_000 : 60_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': binary ? 'application/octet-stream' : 'application/json' },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
    if (!response.ok) {
      // API error bodies can echo supplied data. Report the operation/status, never raw bodies or tokens.
      throw new Error(`Google Play ${method} ${path} failed (HTTP ${response.status}). Check app setup and publisher permissions.`);
    }
    return response.status === 204 ? {} : response.json();
  }
  async edit(token, action) {
    const edit = await this.request(token, 'POST', '/edits', {});
    if (!/^[a-zA-Z0-9_-]+$/.test(edit.id ?? '')) throw new Error('Google Play did not return a valid edit.');
    try { return await action(edit.id); }
    finally { await this.request(token, 'DELETE', `/edits/${edit.id}`).catch(() => {}); }
  }
  async nextCode(minimum = 1) {
    code(minimum);
    const token = await this.token();
    return this.edit(token, async id => {
      const [tracks, bundles, apks] = await Promise.all([
        this.request(token, 'GET', `/edits/${id}/tracks`),
        this.request(token, 'GET', `/edits/${id}/bundles`),
        this.request(token, 'GET', `/edits/${id}/apks`),
      ]);
      const used = [...(tracks.tracks ?? []).flatMap(t => (t.releases ?? []).flatMap(r => r.versionCodes ?? [])), ...(bundles.bundles ?? []).map(b => b.versionCode), ...(apks.apks ?? []).map(a => a.versionCode)].map(code);
      return code(Math.max(minimum, Math.max(0, ...used) + 1));
    });
  }
  async publish(aab, expectedCode, track, status) {
    code(expectedCode);
    if (!['internal', 'production'].includes(track) || !['draft', 'completed'].includes(status)) throw new Error('Unsupported release track or status.');
    if (!(aab instanceof Uint8Array) || !aab.length) throw new Error('An AAB is required.');
    const token = await this.token();
    await this.edit(token, async id => {
      const current = await this.request(token, 'GET', `/edits/${id}/tracks/${track}`);
      if ((current.releases ?? []).some(r => ['inProgress', 'halted'].includes(r.status))) throw new Error('Resolve the existing staged rollout before replacing this track.');
      const bundle = await this.request(token, 'POST', `/edits/${id}/bundles?uploadType=media`, aab, true);
      if (code(bundle.versionCode) !== expectedCode) throw new Error('Uploaded AAB version differs from the expected version.');
      await this.request(token, 'PUT', `/edits/${id}/tracks/${track}`, { releases: [{ versionCodes: [String(expectedCode)], status }] });
      await this.request(token, 'POST', `/edits/${id}:validate`, {});
      await this.request(token, 'POST', `/edits/${id}:commit`, {});
    });
    await this.edit(token, async id => {
      const actual = await this.request(token, 'GET', `/edits/${id}/tracks/${track}`);
      if (!(actual.releases ?? []).some(r => r.status === status && (r.versionCodes ?? []).includes(String(expectedCode)))) {
        throw new Error('Google Play track verification failed after commit.');
      }
    });
    return { packageName: PACKAGE, versionCode: expectedCode, track, status, verified: true };
  }
}

async function main() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ?? ''); }
  catch { throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing or invalid.'); }
  const client = new PlayRelease(credentials);
  const [command, ...args] = process.argv.slice(2);
  if (command === 'next-code') console.log(await client.nextCode(code(args[0] ?? 1)));
  else if (command === 'publish' && args.length === 4) {
    console.log(JSON.stringify(await client.publish(readFileSync(args[0]), code(args[1]), args[2], args[3])));
  } else throw new Error('Usage: next-code [minimum] | publish <aab> <versionCode> <internal|production> <draft|completed>');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
