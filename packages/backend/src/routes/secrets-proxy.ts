/**
 * The proxy itself. Extracted verbatim from secrets.ts.
 */
import type { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import { openSecret, type SealedSecret } from '../lib/encryption.js';
import { AllowlistError, injectSecret, pickRule } from '../lib/proxy-allowlist.js';
import { checkAndBump, d1UsageStore } from '../lib/proxy-rate-limit.js';
import { getOAuth2Token } from '../lib/proxy-oauth2.js';
import type { Env } from '../types.js';
import { type AllowlistRow, rowToRule } from './secrets-allowlist-row.js';
import {
  DAILY_PROXY_REQUESTS,
  MAX_REQUEST_BODY_BYTES,
  MAX_RESPONSE_BODY_BYTES,
  requireKek,
  toUint8,
} from './secrets-shared.js';

const PROXY_FORWARD_SKIP_HEADERS = new Set([
  // Strip auth + cookies — they were addressed to *us*, not the upstream,
  // and forwarding them would leak the user's platform session to a
  // third-party API the developer chose. We inject upstream auth via
  // the rule's inject_kind/inject_name.
  'authorization',
  'cookie',
  // Hop-by-hop headers per RFC 7230. The runtime sets these for us.
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Cloudflare-injected request headers — leaking client IP / geo to
  // arbitrary upstream APIs is also undesirable.
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-real-ip',
]);

const PROXY_RESPONSE_SKIP_HEADERS = new Set([
  // Set-Cookie from upstream is meaningless to the browser (different origin)
  // and risks leaking upstream session state. Drop it.
  'set-cookie',
  'connection',
  'keep-alive',
  'transfer-encoding',
  // The Workers runtime auto-decompresses gzip/br responses before
  // arrayBuffer() returns. If we passed the original content-encoding header
  // through, the browser would try to decode already-decoded bytes and get
  // garbage. content-length goes too — auto-decompression also changes it.
  'content-encoding',
  'content-length',
]);

export function registerProxyRoute(secretsRoutes: Hono<{ Bindings: Env }>) {
  secretsRoutes.all('/apps/:appId/proxy/:host/*', async (c) => {
    try {
      // Auth: any valid platform session can call the proxy. The app's owner
      // pays the quota, not the caller. (See spec: free tier, per-app quota.)
      const user = await requireUser(c);
      const kek = requireKek(c);
      const appId = c.req.param('appId')!;
      const host = c.req.param('host')!;

      // Reconstruct upstream URL: /v1/apps/:appId/proxy/<host>/<rest...>
      const prefix = `/v1/apps/${appId}/proxy/${host}/`;
      if (!c.req.path.startsWith(prefix)) {
        return c.json({ error: 'malformed proxy path' }, 400);
      }
      const restPath = c.req.path.slice(prefix.length);
      const incomingUrl = new URL(c.req.url);
      const upstreamUrl = `https://${host}/${restPath}${incomingUrl.search}`;

      // Look up rules for the app, then pick the best match.
      const ruleRows = await c.env.DB.prepare(
        `SELECT pattern, inject_kind, inject_name, secret_name, secret_name_2, token_url, methods, created_at
         FROM app_proxy_allowlist WHERE app_id = ?`,
      )
        .bind(appId)
        .all<AllowlistRow>();
      const rules = (ruleRows.results ?? []).map(rowToRule);
      const rule = pickRule(rules, upstreamUrl, c.req.method);

      let plaintext: string;
      let injectedUrl: string;
      let injectedHeaders: Headers;

      if (!rule) {
        return c.json({ error: `no allowlist match for ${c.req.method} ${upstreamUrl}` }, 403);
      }

      {
        // Daily cap (only for app-level secrets, not user keys).
        const usage = await checkAndBump(d1UsageStore(c.env.DB), {
          appId,
          dailyLimit: DAILY_PROXY_REQUESTS,
          nowMs: Date.now(),
        });
        if (!usage.allowed) {
          return c.json(
            { error: `app daily quota exceeded (${DAILY_PROXY_REQUESTS} requests/day)` },
            429,
          );
        }

        // Look up + decrypt the app secret.
        const secretRow = await c.env.DB.prepare(
          `SELECT key_ciphertext, dek_wrapped, iv FROM app_secrets
           WHERE app_id = ? AND name = ?`,
        )
          .bind(appId, rule.secretName)
          .first<{ key_ciphertext: unknown; dek_wrapped: unknown; iv: unknown }>();
        if (!secretRow) {
          return c.json({ error: `secret '${rule.secretName}' not found` }, 500);
        }
        const sealed: SealedSecret = {
          keyCiphertext: toUint8(secretRow.key_ciphertext),
          dekWrapped: toUint8(secretRow.dek_wrapped),
          iv: toUint8(secretRow.iv),
        };
        plaintext = await openSecret(sealed, kek);

        // Build forward request: filter inbound headers, then inject secret.
        const forwardHeaders = new Headers();
        for (const [k, v] of c.req.raw.headers.entries()) {
          if (!PROXY_FORWARD_SKIP_HEADERS.has(k.toLowerCase())) {
            forwardHeaders.set(k, v);
          }
        }

        if (rule.injectKind === 'oauth2_cc') {
          // OAuth2 client_credentials: plaintext is client_id, decrypt secret2 for client_secret
          const secret2Row = await c.env.DB.prepare(
            `SELECT key_ciphertext, dek_wrapped, iv FROM app_secrets
             WHERE app_id = ? AND name = ?`,
          )
            .bind(appId, rule.secretName2)
            .first<{ key_ciphertext: unknown; dek_wrapped: unknown; iv: unknown }>();
          if (!secret2Row) {
            return c.json({ error: `secret '${rule.secretName2}' not found` }, 500);
          }
          const clientSecret = await openSecret({
            keyCiphertext: toUint8(secret2Row.key_ciphertext),
            dekWrapped: toUint8(secret2Row.dek_wrapped),
            iv: toUint8(secret2Row.iv),
          }, kek);

          // Get cached or fresh OAuth2 bearer token
          const cacheKey = `${appId}:${rule.secretName}`;
          const bearerToken = await getOAuth2Token({
            cacheKey,
            tokenUrl: rule.tokenUrl,
            clientId: plaintext,
            clientSecret,
          });
          forwardHeaders.set('Authorization', `Bearer ${bearerToken}`);
          injectedUrl = upstreamUrl;
          injectedHeaders = forwardHeaders;
        } else {
          const injected = injectSecret(rule, upstreamUrl, forwardHeaders, plaintext);
          injectedUrl = injected.url;
          injectedHeaders = injected.headers;
        }
      }

      // Body: cap at 100 KB. Pull into memory once so we can both measure
      // and forward without re-streaming a hostile body.
      let forwardBody: BodyInit | null = null;
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        const buf = await c.req.arrayBuffer();
        if (buf.byteLength > MAX_REQUEST_BODY_BYTES) {
          return c.json(
            { error: `request body too large (max ${MAX_REQUEST_BODY_BYTES} bytes)` },
            413,
          );
        }
        forwardBody = buf;
      }

      const upstreamRes = await fetch(injectedUrl, {
        method: c.req.method,
        headers: injectedHeaders,
        body: forwardBody,
      });

      // Cap response size by reading bytes ourselves; a streaming passthrough
      // would let a hostile upstream chew our CPU minutes.
      const respBuf = await upstreamRes.arrayBuffer();
      if (respBuf.byteLength > MAX_RESPONSE_BODY_BYTES) {
        return c.json({ error: 'upstream response too large' }, 502);
      }

      // Update last_used_at probabilistically (1 in 10) to save D1 writes.
      if (rule && Math.random() < 0.1) {
        const update = c.env.DB.prepare(
          'UPDATE app_secrets SET last_used_at = ? WHERE app_id = ? AND name = ?',
        )
          .bind(Date.now(), appId, rule.secretName)
          .run();
        try {
          c.executionCtx.waitUntil(update);
        } catch {
          update.catch(() => {});
        }
      }

      const respHeaders = new Headers();
      for (const [k, v] of upstreamRes.headers.entries()) {
        if (!PROXY_RESPONSE_SKIP_HEADERS.has(k.toLowerCase())) {
          // append, not set: preserves multi-value headers like Vary and Link.
          // entries() yields one entry per occurrence, so set() would only keep
          // the last.
          respHeaders.append(k, v);
        }
      }
      return new Response(respBuf, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 401);
      if (err instanceof AllowlistError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
}
