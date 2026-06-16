// PAS build orchestrator Worker (ADR-006, Phase 2).
//
// fetch():  GitHub App `push` webhook → verify signature → enqueue a BuildJob.
// queue():  consume jobs → mint a repo-scoped installation token → dispatch the
//           build to the CF Container.
//
// The container dispatch is the ONE thing that needs CF Containers enabled
// (Phase 3); it is clearly isolated in dispatchBuild() below. Everything else —
// signature verification, push filtering, enqueue, token minting — is real and
// unit-tested.

import { verifySignature, parsePush, shouldBuild, buildJobFrom, type BuildJob } from './webhook.ts';
import { mintInstallationToken } from './github-app.ts';

export interface Env {
  BUILD_QUEUE: Queue<BuildJob>;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  // R2 S3 creds passed through to the build container.
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  // Phase 3: BUILD_CONTAINER binding (Cloudflare Containers) — not yet bound.
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true });
    if (request.method !== 'POST' || url.pathname !== '/webhook') return json({ error: 'not found' }, 404);

    const event = request.headers.get('X-GitHub-Event');
    const raw = await request.text();

    // Verify EVERY POST before trusting a byte of the body.
    const ok = await verifySignature(raw, request.headers.get('X-Hub-Signature-256'), env.GITHUB_WEBHOOK_SECRET);
    if (!ok) return json({ error: 'invalid signature' }, 401);

    if (event === 'ping') return json({ ok: true, pong: true });
    if (event !== 'push') return json({ ok: true, ignored: event }, 202);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json({ error: 'invalid json' }, 400);
    }

    const parsed = parsePush(payload);
    if (!parsed) return json({ error: 'unrecognized push payload' }, 400);
    if (!shouldBuild(parsed)) return json({ ok: true, skipped: { ref: parsed.ref } }, 202);

    const jobMsg = buildJobFrom(parsed);
    await env.BUILD_QUEUE.send(jobMsg);
    return json({ ok: true, queued: { repo: jobMsg.repo, sha: jobMsg.sha.slice(0, 7), appId: jobMsg.appId } }, 202);
  },

  async queue(batch: MessageBatch<BuildJob>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body;
      try {
        if (job.installationId == null) throw new Error('job has no installationId');
        const nowSec = Math.floor(Date.now() / 1000);
        const token = await mintInstallationToken(
          { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY },
          job.installationId,
          job.appId,
          nowSec,
        );
        await dispatchBuild(job, token, env);
        msg.ack();
      } catch (err) {
        console.error(`[orchestrator] build failed for ${job.repo}@${job.sha.slice(0, 7)}: ${err instanceof Error ? err.message : err}`);
        msg.retry();
      }
    }
  },
};

/**
 * Hand the job to the build container. PHASE 3 WIRING POINT.
 *
 * Until Cloudflare Containers is enabled and a BUILD_CONTAINER binding exists,
 * this throws so the job retries (visible, not silently dropped) rather than
 * pretending to build. When wired, this starts a one-shot container with the
 * BUILD_* env (see packages/builder) and streams its logs to the build record.
 */
async function dispatchBuild(job: BuildJob, _token: string, _env: Env): Promise<void> {
  throw new Error(
    `NOT_WIRED: container dispatch pending CF Containers (ADR-006 Phase 3). ` +
      `Job ready: ${job.repo}@${job.sha.slice(0, 7)} → apps/${job.appId}`,
  );
}
