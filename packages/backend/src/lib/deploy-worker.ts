/**
 * Deploy a data worker via Cloudflare API.
 *
 * Uses the Workers Script Upload API with ES modules format.
 * The bundled worker script is fetched from the platform's GitHub repo.
 */

const BUNDLE_URL =
  'https://raw.githubusercontent.com/proappstore-online/platform/main/packages/data-worker/dist/worker.js';

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

export async function deployDataWorker(
  appId: string,
  dbId: string,
  cfToken: string,
  cfAccount: string,
  sessionSigningKey: string,
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

  // 1. Fetch the bundled worker script
  const bundleRes = await fetch(BUNDLE_URL);
  if (!bundleRes.ok) {
    return {
      ok: false,
      url: workersDevUrl,
      workersDevUrl,
      detail: `Failed to fetch worker bundle: ${bundleRes.status}`,
    };
  }
  const workerScript = await bundleRes.text();

  // 2. Build the metadata (bindings, compatibility settings)
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'plain_text', name: 'APP_ID', text: appId },
      { type: 'secret_text' as const, name: 'SESSION_SIGNING_KEY', text: sessionSigningKey },
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
          }),
        },
      );
      const domainData = (await domainRes.json()) as {
        success: boolean;
        errors?: { message: string }[];
      };
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
