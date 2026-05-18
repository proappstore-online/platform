/**
 * Deploy a data worker via Cloudflare API.
 *
 * Uses the Workers Script Upload API with ES modules format.
 * The bundled worker script is fetched from the platform's GitHub repo.
 */

const BUNDLE_URL =
  'https://raw.githubusercontent.com/proappstore-online/platform/main/packages/data-worker/dist/worker.js';

interface DeployResult {
  ok: boolean;
  url: string;
  detail: string;
}

export async function deployDataWorker(
  appId: string,
  dbId: string,
  cfToken: string,
  cfAccount: string,
): Promise<DeployResult> {
  const workerName = `pas-data-${appId}`;
  const workerUrl = `https://${workerName}.serge-the-dev.workers.dev`;

  // 1. Fetch the bundled worker script
  const bundleRes = await fetch(BUNDLE_URL);
  if (!bundleRes.ok) {
    return { ok: false, url: workerUrl, detail: `Failed to fetch worker bundle: ${bundleRes.status}` };
  }
  const workerScript = await bundleRes.text();

  // 2. Build the metadata (bindings, compatibility settings)
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2026-01-01',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { type: 'plain_text', name: 'APP_ID', text: appId },
      { type: 'plain_text', name: 'FAS_API_BASE', text: 'https://api.freeappstore.online' },
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
    return { ok: false, url: workerUrl, detail: err };
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

  return { ok: true, url: workerUrl, detail: `Deployed ${workerName} with D1 ${dbId}` };
}
