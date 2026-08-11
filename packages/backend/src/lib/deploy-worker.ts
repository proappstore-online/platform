/**
 * Deploy a data worker via Cloudflare API.
 *
 * Uses the Workers Script Upload API with ES modules format.
 * The bundled worker script is embedded at backend build time (see
 * scripts/embed-data-worker.mjs) so it ships versioned with the backend — no
 * runtime GitHub fetch.
 */

import { DATA_WORKER_BUNDLE } from '../generated/data-worker-bundle.js';

// PAS Worker custom domains all live under proappstore.online. The platform
// is single-zone; if that ever changes, lift this to env.
const ZONE_NAME = 'proappstore.online';

interface DeployResult {
  ok: boolean;
  /** Primary URL apps should hit. Must be the canonical custom domain on success. */
  url: string;
  detail: string;
  /** workers.dev URL kept only for diagnostics; apps should not depend on it. */
  workersDevUrl: string;
  /** Custom domain attached at data-<appId>.proappstore.online. */
  customDomain?: string;
}

export interface DeployDataWorkerOptions {
  /**
   * Re-point `data-<appId>.proappstore.online` even when it is currently bound
   * to a DIFFERENT worker (#82).
   *
   * Off by default, and it should stay off for anything a user can reach. This
   * exists for admin re-provision — notably migrating a hostname off the
   * pre-rename `data-<app>` scripts, which is what the unconditional override
   * was originally added for.
   */
  forceRepoint?: boolean;
}

export async function deployDataWorker(
  appId: string,
  dbId: string,
  cfToken: string,
  cfAccount: string,
  sessionSigningKey: string,
  internalToken = '',
  opts: DeployDataWorkerOptions = {},
): Promise<DeployResult> {
  const workerName = `pas-data-${appId}`;
  const workersDevUrl = `https://${workerName}.serge-the-dev.workers.dev`;
  if (!sessionSigningKey) {
    return {
      ok: false,
      url: workersDevUrl,
      workersDevUrl,
      detail: 'SESSION_SIGNING_KEY is required to deploy data workers',
    };
  }

  // 1. Use the embedded worker script (built into the backend at deploy time).
  const workerScript = DATA_WORKER_BUNDLE;
  if (!workerScript) {
    return {
      ok: false,
      url: workersDevUrl,
      workersDevUrl,
      detail: 'Embedded data-worker bundle is empty — build codegen did not run',
    };
  }

  // 2. Build the metadata (bindings, compatibility settings)
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'plain_text', name: 'APP_ID', text: appId },
      // API_BASE lets the data-worker authorize callers against APP_ID via the
      // platform /v1/apps endpoint (a valid session alone must NOT grant SQL
      // access to another app's DB).
      { type: 'plain_text', name: 'API_BASE', text: 'https://api.proappstore.online' },
      // The auth call MUST go over a service binding: api.proappstore.online is
      // a route, and same-zone Worker subrequests bypass route-mapped Workers,
      // so a plain fetch() fails and the fail-closed check 403s every caller.
      { type: 'service', name: 'API', service: 'proappstore-api', environment: 'production' },
      { type: 'secret_text' as const, name: 'SESSION_SIGNING_KEY', text: sessionSigningKey },
      // Lets the data-worker trust the platform actions-executor (prepared,
      // role-checked SQL). Omitted when empty so the worker still boots — the
      // internal path stays inert (fail-closed) until the secret is present.
      ...(internalToken
        ? [{ type: 'secret_text' as const, name: 'INTERNAL_TOKEN', text: internalToken }]
        : []),
      { type: 'd1', name: 'DB', id: dbId },
    ],
  };

  // 3. Upload via CF API (multipart form)
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([workerScript], { type: 'application/javascript+module' }), 'worker.js');

  const uploadRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/scripts/${workerName}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${cfToken}` },
      body: form,
    },
  );

  const uploadData = (await uploadRes.json()) as {
    success: boolean;
    errors?: { message: string }[];
  };

  if (!uploadData.success) {
    const err = uploadData.errors?.[0]?.message || 'unknown upload error';
    return { ok: false, url: workersDevUrl, workersDevUrl, detail: err };
  }

  // 4. Enable workers.dev subdomain
  try {
    await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/scripts/${workerName}/subdomain`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
  } catch {
    // Non-fatal — workers_dev might already be enabled
  }

  // 5. Attach data-<appId>.proappstore.online as a Worker custom domain.
  // Worker custom domains create the DNS record + provision a TLS cert in
  // one API call. This is required for the platform-cookie architecture:
  // the host worker mediates `/.pas/data/*` to the canonical data domain.
  const hostname = `data-${appId}.${ZONE_NAME}`;
  try {
    const zoneRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}`,
      { headers: { Authorization: `Bearer ${cfToken}` } },
    );
    const zoneData = (await zoneRes.json()) as {
      success: boolean;
      result?: { id: string }[];
      errors?: { message: string }[];
    };
    const zoneId = zoneData.result?.[0]?.id;
    if (!zoneData.success || !zoneId) {
      const err = zoneData.errors?.[0]?.message || 'zone lookup returned no results';
      return {
        ok: false,
        url: workersDevUrl,
        workersDevUrl,
        detail: `custom domain required but zone lookup failed: ${err}`,
      };
    } else {
      // SECURITY (#82): find out who owns this hostname BEFORE attaching.
      //
      // This used to send `override_existing_origin: true` unconditionally,
      // which re-points the hostname no matter what it is currently bound to.
      // That bypassed the fail-safe the Pages path has in `alreadyExists()`
      // (build-core/src/cloudflare.ts), which deliberately refuses to treat
      // "belongs to / in use by another" as idempotent. The result was that a
      // provision for `victimapp` would silently seize
      // `data-victimapp.proappstore.online` from whatever already held it.
      //
      // Ask Cloudflare which service holds the hostname rather than parsing an
      // error string: the answer is unambiguous, and a wrong guess here means
      // either a broken re-provision or a cross-tenant seizure.
      const ownerRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/domains`
          + `?zone_id=${encodeURIComponent(zoneId)}&hostname=${encodeURIComponent(hostname)}`,
        { headers: { Authorization: `Bearer ${cfToken}` } },
      );
      const ownerData = (await ownerRes.json()) as {
        success: boolean;
        result?: { hostname: string; service: string }[];
        errors?: { message: string }[];
      };
      // Filter client-side too: the hostname query param is a filter, not a
      // guarantee, and acting on a near-match would re-point the wrong host.
      //
      // If the lookup fails or answers in a shape we don't recognise, `bound`
      // stays undefined and we fall through to an attach WITHOUT the override.
      // That fails closed: Cloudflare rejects the attach if the hostname is
      // taken, so an unreadable answer costs a failed provision, never a
      // silent seizure.
      const bound = Array.isArray(ownerData.result)
        ? ownerData.result.find((d) => d.hostname === hostname)
        : undefined;

      if (bound && bound.service !== workerName && !opts.forceRepoint) {
        return {
          ok: false,
          url: workersDevUrl,
          workersDevUrl,
          detail:
            `custom domain ${hostname} is already bound to worker "${bound.service}", not "${workerName}" — `
            + 'refusing to re-point. Re-provision with forceRepoint if this is an intentional admin migration.',
        };
      }

      const domainRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/workers/domains`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            environment: 'production',
            hostname,
            service: workerName,
            zone_id: zoneId,
            // Only ever set for an explicit admin re-provision. Re-pointing a
            // hostname off a stale worker (e.g. the pre-rename `data-<app>`
            // scripts) is the legitimate case this exists for.
            ...(opts.forceRepoint ? { override_existing_origin: true } : {}),
          }),
        },
      );
      const domainData = (await domainRes.json()) as {
        success: boolean;
        errors?: { message: string }[];
      };
      // Already ours: Cloudflare may answer either way for a no-op re-attach,
      // and a hostname already pointing at this exact worker is the outcome we
      // wanted. Treat it as success so re-provision stays idempotent.
      if (!domainData.success && bound && bound.service === workerName) {
        return {
          ok: true,
          url: `https://${hostname}`,
          workersDevUrl,
          customDomain: hostname,
          detail: `Deployed ${workerName} with D1 ${dbId} + ${hostname} (already attached)`,
        };
      }
      if (domainData.success) {
        return {
          ok: true,
          url: `https://${hostname}`,
          workersDevUrl,
          customDomain: hostname,
          detail: `Deployed ${workerName} with D1 ${dbId} + ${hostname}`,
        };
      } else {
        const err = domainData.errors?.[0]?.message || `HTTP ${domainRes.status}`;
        return {
          ok: false,
          url: workersDevUrl,
          workersDevUrl,
          detail: `custom domain required but attach failed: ${err}`,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      url: workersDevUrl,
      workersDevUrl,
      detail: `custom domain required but attach threw: ${e}`,
    };
  }
}
