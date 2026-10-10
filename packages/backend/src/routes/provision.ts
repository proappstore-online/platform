import { Hono } from 'hono';
import { runChecksFromFiles } from '@proappstore/compliance';
import {
  internalTokenOk,
  type Step,
  checkProvisionQuota,
  d1ProvisionAdmissionStore,
  d1ProvisionAttemptStore,
} from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireUser, TEAM_ROLES, type TeamRole } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { provisionData } from '../lib/provision-data.js';
import {
  beginProvisionOperation,
  getProvisionOperation,
  hashProvisionAdmissionOperation,
  hashProvisionIntent,
  isLegacyProvisionOperation,
  operationIsExhausted,
  updateProvisionOperation,
  type ProvisionOperation,
  type ProvisionOperationStatus,
  type ProvisionOperationStep,
} from '../lib/provision-operation.js';
import { selectTemplate, TEMPLATE_REV_RE } from '@proappstore/build-core';
import { fetchRepoFiles, type RepoLocation } from '../lib/github-fetch.js';

/**
 * PAS app provisioning — fully self-contained.
 *
 * What it does (in order):
 *   1. Compliance check — fetches repo from GitHub, runs checks (optional)
 *   2. R2 route — inserts into the host Worker's D1 routes table
 *   3. D1 database — creates pas-data-<id>
 *   4. Data Worker — deploys to data-<id>.proappstore.online
 *   5. App record — inserts into the platform apps table
 *
 * Hosting: R2 + host Worker at *.proappstore.online (no CF Pages).
 * Apps deploy via GitHub Actions → R2 upload. The host Worker serves.
 *
 * Idempotent — re-running skips already-provisioned resources.
 */
const ORG = 'proappstore-online';
const DOMAIN = 'proappstore.online';

interface ProvisionBody {
  appId: string;
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  iconBg?: string;
  proFeatures?: string[];
  skipCompliance?: boolean;
  skipPublish?: boolean;
  repoOwner?: string;
  repoName?: string;
  ref?: string;
  /** #178: catalogue id of the template the repo was created from (default: template-app). */
  template?: string;
  /** #178: exact source commit that was copied (7–40 hex). */
  templateRev?: string;
  /** #178: platform admins only — proceed with a template outside the approved catalogue. */
  allowUnapprovedTemplate?: boolean;
  /** Durable receipt context supplied only by the MCP worker that owns the active attempt. */
  provisionReceipt?: string;
  provisionAttemptId?: string;
}

export const provisionRoutes = new Hono<{ Bindings: Env }>();

function validAppId(appId: unknown): appId is string {
  return typeof appId === 'string' && /^[a-z][a-z0-9-]*$/.test(appId) && appId.length <= 58;
}

/** Do not expose the platform account id in a receipt response. */
function operationResponse(operation: ProvisionOperation, joined?: boolean) {
  const status = isLegacyProvisionOperation(operation)
    ? 'legacy_unreconciled'
    : operationIsExhausted(operation) ? 'exhausted' : operation.status;
  return {
    receipt: operation.receiptId,
    appId: operation.appId,
    // `exhausted` is an API display state: 0083's CHECK constraint deliberately
    // keeps the persisted history as pending/failed, while callers must not be
    // told that an expired fifth attempt is still making progress.
    status,
    steps: operation.steps,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    completedAt: operation.completedAt,
    attemptCount: operation.attemptCount,
    leaseExpiresAt: operation.leaseExpiresAt,
    attemptId: operation.attemptId,
    ...(operation.result ? { result: operation.result } : {}),
    ...(joined === undefined ? {} : { joined }),
  };
}

function redactStepDetail(detail: string): string {
  return detail
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{12,}/g, '[redacted]')
    .slice(0, 1_000);
}

/**
 * The receipt binds the effective request parameters, never its bearer-like
 * receipt fields. This is deliberately server-side: a caller cannot present a
 * stored hash for one template/options set and execute another request.
 */
function provisionRequestIntent(body: ProvisionBody): Record<string, unknown> {
  const intent: Record<string, unknown> = { appId: body.appId };
  for (const key of ['name', 'description', 'category', 'icon', 'iconBg', 'repoOwner', 'repoName', 'ref', 'template', 'templateRev'] as const) {
    if (typeof body[key] === 'string') intent[key] = body[key];
  }
  if (Array.isArray(body.proFeatures) && body.proFeatures.every((feature) => typeof feature === 'string')) {
    intent.proFeatures = body.proFeatures;
  }
  for (const key of ['skipCompliance', 'skipPublish', 'allowUnapprovedTemplate'] as const) {
    if (typeof body[key] === 'boolean') intent[key] = body[key];
  }
  return intent;
}

/** Reject invalid consequential types rather than silently canonicalising them away. */
function validateProvisionRequest(body: ProvisionBody): string | null {
  for (const key of ['name', 'description', 'category', 'icon', 'iconBg', 'repoOwner', 'repoName', 'ref', 'template', 'templateRev'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'string') return `${key} must be a string`;
  }
  for (const key of ['skipCompliance', 'skipPublish', 'allowUnapprovedTemplate'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return `${key} must be a boolean`;
  }
  if (body.proFeatures !== undefined && (!Array.isArray(body.proFeatures) || !body.proFeatures.every((feature) => typeof feature === 'string'))) {
    return 'proFeatures must be an array of strings';
  }
  return null;
}

async function admissionIdFor(operation: ProvisionOperation): Promise<string | null> {
  if (!operation.attemptId || operation.leaseExpiresAt === null) return null;
  return hashProvisionAdmissionOperation({
    creatorId: operation.creatorId,
    appId: operation.appId,
    intentHash: operation.intentHash,
    attemptId: operation.attemptId,
  });
}

async function operationAccess(c: Parameters<typeof requireUser>[0], appId: string) {
  const user = await requireUser(c);
  const operation = await getProvisionOperation(c.env.DB, appId);
  if (!operation) return { user, operation: null, response: null };
  if (operation.creatorId !== user.id && !user.roles.includes('admin')) {
    return { user, operation, response: c.json({ error: 'provisioning operation belongs to another user' }, 403) };
  }
  return { user, operation, response: null };
}

/**
 * #358: acquire a durable receipt before MCP calls GitHub. A second request for
 * the same app joins the existing receipt; it must never manufacture a second
 * repository bootstrap while the first request is still running.
 */
provisionRoutes.post('/provision-operations', wrap(async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<{ appId?: unknown; intent?: unknown; bootstrapIntent?: unknown }>();
  if (!validAppId(body.appId)) return c.text('Invalid app ID', 400);
  if (!body.intent || typeof body.intent !== 'object' || Array.isArray(body.intent)) {
    return c.text('Provisioning intent is required', 400);
  }
  if (!body.bootstrapIntent || typeof body.bootstrapIntent !== 'object' || Array.isArray(body.bootstrapIntent)) {
    return c.text('Provisioning bootstrap intent is required', 400);
  }
  let intentHash: string;
  let bootstrapIntentHash: string;
  try {
    intentHash = await hashProvisionIntent(body.intent);
    bootstrapIntentHash = await hashProvisionIntent(body.bootstrapIntent);
  } catch (error) {
    return c.text(`Invalid provisioning intent: ${(error as Error).message}`, 400);
  }

  // Ownership always precedes quota/reservation, so an attacker cannot reserve
  // or spend quota against another owner's app id.
  const claimed = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
    .bind(body.appId).first<{ creator_id: string }>();
  if (claimed && claimed.creator_id !== user.id && !user.roles.includes('admin')) {
    return c.json({ error: 'appId already claimed by another user' }, 403);
  }
  const existing = await getProvisionOperation(c.env.DB, body.appId);
  if (existing && existing.creatorId !== user.id && !user.roles.includes('admin')) {
    return c.json({ error: 'provisioning operation belongs to another user' }, 403);
  }
  if (existing && isLegacyProvisionOperation(existing)) {
    // 0083 rows have no trustworthy intent fingerprint. The apps table can
    // prove only that an app record is absent; it cannot prove that the org repo
    // is unused or who created it. Preserve the receipt read-only rather than
    // attaching a new caller's intent or treating owner-writable steps as proof.
    return c.json({
      ...operationResponse(existing, true),
      error: 'legacy provisioning receipt has no verified intent; it remains read-only until independent server-verified app and repository provenance can reconcile it. Choose a different app id or contact platform support.',
      reconciliation: 'legacy_unreconciled',
    }, 409);
  }
  if (existing && existing.bootstrapIntentHash !== bootstrapIntentHash) {
    return c.json({ error: 'a provisioning receipt already exists for this app with different bootstrap intent' }, 409);
  }

  const now = Date.now();
  // `beginProvisionOperation` is the atomic app-id/intent gate. Do it before
  // consuming quota so simultaneous identical receipt requests yield exactly
  // one created/recovered attempt; all other callers join it without spending.
  const begun = await beginProvisionOperation(c.env.DB, { creatorId: user.id, appId: body.appId, intentHash, bootstrapIntentHash, now });
  if (begun.kind === 'owner_conflict') {
    return c.json({ error: 'provisioning operation belongs to another user' }, 403);
  }
  if (begun.kind === 'intent_conflict') {
    return c.json({ error: 'a provisioning receipt already exists for this app with different bootstrap intent' }, 409);
  }
  if (begun.kind === 'legacy_unreconciled') {
    return c.json({
      ...operationResponse(begun.operation, true),
      error: 'legacy provisioning receipt has no verified intent; it remains read-only until independent server-verified app and repository provenance can reconcile it. Choose a different app id or contact platform support.',
      reconciliation: 'legacy_unreconciled',
    }, 409);
  }
  if (begun.kind === 'created' || begun.kind === 'recovered') {
    const { operation } = begun;
    const operationId = await admissionIdFor(operation);
    const attemptId = operation.attemptId;
    const leaseExpiresAt = operation.leaseExpiresAt;
    if (!operationId || !attemptId || leaseExpiresAt === null) {
      return c.text('provisioning receipt did not grant an active attempt lease', 503, { 'Retry-After': '60' });
    }
    const admissions = d1ProvisionAdmissionStore(c.env.DB);
    try {
      // The durable row is intentionally non-executable while quota is being
      // checked. A concurrent GET/join followed by /provision can observe it,
      // but claim() accepts only a later admitted state.
      if (!(await admissions.stage({
        operationId,
        creatorId: operation.creatorId,
        appId: operation.appId,
        intentHash: operation.intentHash,
        attemptId,
        leaseExpiresAt,
        createdAt: now,
      }))) {
        return c.text('provisioning rate limit is temporarily unavailable — retry later', 503, { 'Retry-After': '60' });
      }
    } catch (error) {
      console.warn(`provision admission staging unavailable, refusing reservation: ${(error as Error).message}`);
      return c.text('provisioning rate limit is temporarily unavailable — retry later', 503, { 'Retry-After': '60' });
    }
    try {
      const quota = await checkProvisionQuota(d1ProvisionAttemptStore(c.env.DB), {
        userKey: user.id,
        ip: c.req.header('CF-Connecting-IP'),
        nowMs: now,
      });
      if (!quota.allowed) {
        await admissions.fail(operationId, 'denied', now);
        return c.text(
          `provisioning rate limit reached (${quota.scope}) — retry later`,
          429,
          quota.retryAfterSeconds ? { 'Retry-After': String(quota.retryAfterSeconds) } : undefined,
        );
      }
      if (!(await admissions.admit(operationId, now))) {
        // Do not repair this by deleting/recreating state: evidence of the
        // failed hand-off remains inspectable and cannot be executed.
        await admissions.fail(operationId, 'unavailable', now).catch(() => undefined);
        return c.text('provisioning admission could not be activated — retry later', 503, { 'Retry-After': '60' });
      }
    } catch (error) {
      await admissions.fail(operationId, 'unavailable', now).catch(() => undefined);
      console.warn(`provision operation rate limit unavailable, refusing reservation: ${(error as Error).message}`);
      return c.text('provisioning rate limit is temporarily unavailable — retry later', 503, { 'Retry-After': '60' });
    }
  }
  if (begun.kind === 'joined' && begun.operation.status === 'pending') {
    const operationId = await admissionIdFor(begun.operation);
    const admission = operationId ? await d1ProvisionAdmissionStore(c.env.DB).read(operationId) : null;
    if (!admission || admission.status === 'unavailable') {
      return c.text('provisioning admission is not executable yet — retry later', 503, { 'Retry-After': '60' });
    }
    if (admission.status === 'denied') {
      return c.text('provisioning rate limit reached for this receipt — retry later', 429, { 'Retry-After': '60' });
    }
  }
  const joined = begun.kind === 'joined' || begun.kind === 'exhausted';
  return c.json(operationResponse(begun.operation, joined), begun.kind === 'created' ? 201 : 200);
}));

/** Read-only, owner-gated status for a provisioning receipt. */
provisionRoutes.get('/provision-operations/:appId', wrap(async (c) => {
  const appId = c.req.param('appId');
  if (!validAppId(appId)) return c.text('Invalid app ID', 400);
  const access = await operationAccess(c, appId);
  if (access.response) return access.response;
  if (!access.operation) return c.json({ error: 'provisioning operation not found' }, 404);
  return c.json(operationResponse(access.operation));
}));

/** Owner-gated evidence updates used by the MCP worker as each remote step settles. */
provisionRoutes.patch('/provision-operations/:appId', wrap(async (c) => {
  const appId = c.req.param('appId');
  if (!validAppId(appId)) return c.text('Invalid app ID', 400);
  const user = await requireUser(c);
  const operation = await getProvisionOperation(c.env.DB, appId);
  if (!operation) return c.json({ error: 'provisioning operation not found' }, 404);
  // Evidence is written by the operation's worker session only. Admins may
  // inspect receipts, but may not impersonate a creator's active attempt.
  if (operation.creatorId !== user.id) return c.json({ error: 'provisioning operation belongs to another user' }, 403);
  const body = await c.req.json<{
    status?: unknown;
    steps?: unknown;
    result?: unknown;
    attemptId?: unknown;
  }>();
  if (typeof body.attemptId !== 'string' || !body.attemptId) return c.text('attemptId is required', 400);
  if (body.status !== undefined && body.status !== 'completed' && body.status !== 'failed') {
    return c.text('Invalid provisioning operation status', 400);
  }
  if (body.steps !== undefined && (!Array.isArray(body.steps) || body.steps.length > 12 || !body.steps.every((step) => (
    step && typeof step === 'object'
    && typeof (step as Record<string, unknown>).name === 'string'
    && typeof (step as Record<string, unknown>).detail === 'string'
    && ['ok', 'skip', 'fail', 'pending'].includes(String((step as Record<string, unknown>).status))
  )))) return c.text('Invalid provisioning operation steps', 400);
  if (body.result !== undefined && (body.result === null || typeof body.result !== 'object' || Array.isArray(body.result))) {
    return c.text('Invalid provisioning operation result', 400);
  }
  const now = Date.now();
  const steps = (body.steps as Array<Omit<ProvisionOperationStep, 'completedAt' | 'attemptId'>> | undefined)?.map((step) => ({
    name: step.name.slice(0, 80),
    status: step.status,
    detail: redactStepDetail(step.detail),
  }));
  const updated = await updateProvisionOperation(c.env.DB, operation.receiptId, {
    attemptId: body.attemptId,
    ...(body.status ? { status: body.status as Extract<ProvisionOperationStatus, 'completed' | 'failed'> } : {}),
    ...(steps ? { steps } : {}),
    ...(body.result !== undefined ? { result: body.result as Record<string, unknown> } : {}),
    now,
  });
  if (updated.kind !== 'updated') {
    return c.json({ error: updated.kind === 'terminal' ? 'provisioning operation is terminal' : 'stale or expired provisioning attempt' }, 409);
  }
  return c.json(operationResponse(updated.operation));
}));

provisionRoutes.post('/provision', wrap(async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<ProvisionBody>();

  if (!body.appId || !/^[a-z][a-z0-9-]*$/.test(body.appId) || body.appId.length > 58) {
    return c.text('Invalid app ID', 400);
  }
  const requestError = validateProvisionRequest(body);
  if (requestError) return c.text(`Invalid provisioning request: ${requestError}`, 400);

  const appId = body.appId;

  // SECURITY (#82): appId arrives in the body and used to be format-checked
  // only — nothing tied it to the caller. Any signed-in user could name a live
  // app and drive its whole data-plane provision: D1 lookup, worker redeploy,
  // and (before the fix in lib/deploy-worker.ts) seizure of the app's
  // `data-<appId>` custom domain.
  //
  // The compliance gate did not stop this. For a non-admin it pins the repo to
  // `<ORG>/<appId>` — the VICTIM's own repo — which, being a published app, is
  // exactly the repo that passes. The guard that stops a caller pointing
  // compliance at an arbitrary repo is what made the victim's repo the one
  // checked.
  //
  // An unclaimed appId still provisions normally: this is a "not yours" check,
  // not a "must exist" one. Platform admins pass for support/re-provision,
  // matching requireAppAccess.
  const claimed = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ creator_id: string }>();
  if (claimed && claimed.creator_id !== user.id && !user.roles.includes('admin')) {
    return c.text('appId already claimed by another user', 403);
  }

  const receiptSupplied = body.provisionReceipt !== undefined || body.provisionAttemptId !== undefined;
  let admittedReceipt = false;
  if (receiptSupplied) {
    if (typeof body.provisionReceipt !== 'string' || !body.provisionReceipt
      || typeof body.provisionAttemptId !== 'string' || !body.provisionAttemptId) {
      return c.text('provision receipt and attempt id must be supplied together', 400);
    }
    const now = Date.now();
    const operation = await getProvisionOperation(c.env.DB, appId);
    let actualIntentHash: string;
    try {
      actualIntentHash = await hashProvisionIntent(provisionRequestIntent(body));
    } catch (error) {
      return c.text(`Invalid provisioning request intent: ${(error as Error).message}`, 400);
    }
    // Receipt fields are only a reference. All owner, app, intent and active
    // lease facts are read back from D1, never trusted from the request body.
    if (!operation || operation.receiptId !== body.provisionReceipt || operation.creatorId !== user.id
      || operation.appId !== appId || isLegacyProvisionOperation(operation)
      || operation.status !== 'pending' || operation.attemptId !== body.provisionAttemptId
      || operation.leaseExpiresAt === null || operation.leaseExpiresAt <= now) {
      return c.text('provision receipt is stale, forged, or does not belong to this active attempt', 409);
    }
    if (operation.intentHash !== actualIntentHash) {
      return c.text('provision request does not match the receipt-bound intent', 409);
    }
    const operationId = await hashProvisionAdmissionOperation({
      creatorId: operation.creatorId,
      appId: operation.appId,
      intentHash: actualIntentHash,
      attemptId: operation.attemptId,
    });
    const admissions = d1ProvisionAdmissionStore(c.env.DB);
    try {
      const admission = await admissions.read(operationId);
      if (!admission || admission.creatorId !== operation.creatorId || admission.appId !== operation.appId
        || admission.intentHash !== actualIntentHash || admission.attemptId !== operation.attemptId
        || admission.leaseExpiresAt !== operation.leaseExpiresAt || admission.leaseExpiresAt <= now
        || admission.status !== 'admitted') {
        return c.text('provision receipt has no valid quota admission', 409);
      }
      // Only one request can flip claimed_at from NULL. A replay must not run
      // side effects concurrently and cannot buy another admission by retrying.
      if (!(await admissions.claim(operationId, now))) {
        return c.text('provision receipt is already being executed or has expired', 409);
      }
      admittedReceipt = true;
    } catch (error) {
      console.warn(`provision admission unavailable, refusing execution: ${(error as Error).message}`);
      return c.text('provisioning admission is temporarily unavailable — retry later', 503, { 'Retry-After': '60' });
    }
  }

  // SECURITY (#83): direct calls have no durable receipt admission and are
  // charged here. Receipt-backed calls have already paid exactly once at the
  // atomic receipt admission above. The limiter is fail-closed on either path.
  if (!admittedReceipt) {
    try {
      const quota = await checkProvisionQuota(d1ProvisionAttemptStore(c.env.DB), {
        userKey: user.id,
        ip: c.req.header('CF-Connecting-IP'),
        nowMs: Date.now(),
      });
      if (!quota.allowed) {
        return c.text(
          `provisioning rate limit reached (${quota.scope}) — retry later`,
          429,
          quota.retryAfterSeconds ? { 'Retry-After': String(quota.retryAfterSeconds) } : undefined,
        );
      }
    } catch (error) {
      console.warn(`provision rate limit unavailable, refusing: ${(error as Error).message}`);
      return c.text('provisioning rate limit is temporarily unavailable — retry later', 503, { 'Retry-After': '60' });
    }
  }

  // #178: the template selection contract. Unknown or withdrawn templates are
  // refused before any Cloudflare call; deprecated ones proceed with a recorded
  // warning; omitting the template means the default. Admins may override an
  // unknown template explicitly, and the override is recorded on the app row.
  if (body.templateRev !== undefined && !TEMPLATE_REV_RE.test(String(body.templateRev))) {
    return c.text('templateRev must be a git object id (7–40 hex chars)', 400);
  }
  const selection = selectTemplate(body.template, { allowUnapproved: body.allowUnapprovedTemplate === true && user.roles.includes('admin') });
  if (!selection.ok) return c.text(`template: ${selection.reason}`, 400);
  const templateId = selection.template?.id ?? body.template;
  const templateRev = body.templateRev;

  const cfToken = c.env.CF_API_TOKEN;
  const cfAccount = c.env.CF_ACCOUNT_ID;
  const steps: Step[] = [];
  if (selection.warnings.length > 0) {
    steps.push({ name: 'template', status: 'ok', detail: `warning: ${selection.warnings.join('; ')}` });
  }

  if (!cfToken || !cfAccount) {
    return c.text('Platform provisioning not configured (missing CF credentials)', 503);
  }

  // 0. Compliance check — skipCompliance is admin-only (used by `pas create` bootstrap)
  const canSkipCompliance = body.skipCompliance && user.roles.includes('admin');
  if (!canSkipCompliance) {
    // SECURITY: repoOwner/repoName/ref are read with the platform GITHUB_TOKEN,
    // which can read private org repos. A non-admin must not point compliance
    // at an arbitrary repo (confused-deputy private-repo read) or inject path
    // segments via `ref`. Non-admins are pinned to the org + their own appId;
    // only admins may override owner/repo (used by tooling). `ref` is always
    // format-validated and must not contain path traversal.
    const isAdmin = user.roles.includes('admin');
    const refCandidate = body.ref || 'main';
    if (!/^[a-zA-Z0-9._/-]+$/.test(refCandidate) || refCandidate.includes('..')) {
      return c.text('Invalid ref', 400);
    }
    const loc: RepoLocation = {
      owner: isAdmin && body.repoOwner ? body.repoOwner : ORG,
      repo: isAdmin && body.repoName ? body.repoName : appId,
      ref: refCandidate,
    };
    try {
      const fetched = await fetchRepoFiles(loc, c.env.GITHUB_TOKEN);
      const results = await runChecksFromFiles(fetched.files);
      const hardFails = results.filter((r) => r.status === 'fail');
      const warnings = results.filter((r) => r.status === 'warn');
      if (hardFails.length > 0) {
        // #166: cite the public standard clause each failure breaches, and hand
        // the structured results back so CI can act on ids rather than prose.
        const detail = hardFails
          .map((r) => `${r.name}: ${r.detail}${r.citations?.length ? ` (see ${r.citations.map((x) => x.url).join(', ')})` : ''}`)
          .join('; ');
        steps.push({ name: 'compliance', status: 'fail', detail: `${hardFails.length} rule(s) failed — ${detail}` });
        return c.json({ appId, steps, dataWorkerUrl: '', appUrl: '', success: false, compliance: hardFails }, 412);
      }
      steps.push({
        name: 'compliance',
        status: 'ok',
        detail: `${results.length - warnings.length} rules passed${warnings.length ? ` (${warnings.length} warnings)` : ''}`,
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (/\(404\)/.test(msg)) {
        steps.push({ name: 'compliance', status: 'skip', detail: 'Repo not found — first publish; compliance runs via CI on push' });
      } else {
        steps.push({ name: 'compliance', status: 'fail', detail: `Compliance check error: ${msg}` });
        return c.json({ appId, steps, dataWorkerUrl: '', appUrl: '', success: false }, 412);
      }
    }
  } else {
    steps.push({ name: 'compliance', status: 'skip', detail: 'skipCompliance=true (admin bootstrap)' });
  }

  // 1. R2 route — register the app in the host Worker's routes table so
  //    <appId>.proappstore.online resolves to R2. Idempotent (INSERT OR IGNORE).
  if (!body.skipPublish) {
    try {
      await c.env.DB
        .prepare(
          `INSERT OR IGNORE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
           VALUES (?, ?, ?, 'pas', 'r2', ?, ?)`,
        )
        .bind(appId, DOMAIN, `apps/${appId}`, Date.now(), Date.now())
        .run();
      steps.push({ name: 'route', status: 'ok', detail: `${appId}.${DOMAIN} → apps/${appId}/` });
    } catch (e) {
      steps.push({ name: 'route', status: 'fail', detail: `Route insert failed: ${(e as Error).message}` });
    }
  }

  // 2–4. Data plane (D1 + data worker + app record) — shared with the agent
  //      deploy stage via /v1/provision-data so both paths get the same layer.
  const data = await provisionData({
    appId,
    creatorId: user.id,
    creatorLabel: user.login,
    cfToken,
    cfAccount,
    db: c.env.DB,
    sessionSigningKey: c.env.SESSION_SIGNING_KEY,
    internalToken: c.env.INTERNAL_TOKEN ?? '',
    dataWorkerHost: c.env.DATA_WORKER_HOST,
    ...(templateId ? { templateId } : {}),
    ...(templateRev ? { templateRev } : {}),
  });
  steps.push(...data.steps);
  const dataWorkerUrl = data.dataWorkerUrl;

  const success = !steps.some((s) => s.status === 'fail');
  return c.json({ appId, steps, dataWorkerUrl, appUrl: `https://${appId}.${DOMAIN}`, success }, success ? 200 : 207);
}));

/**
 * Internal (service-to-service): provision ONLY an app's data plane (D1 + data
 * worker + app record). Called by the Agent Teams deploy stage over the
 * PAS_BACKEND service binding so agent-built apps get the same data layer a
 * CLI-published app gets from /v1/provision. Auth is the shared INTERNAL_TOKEN,
 * not a user session — the agent flow has no session and supplies the owner as
 * `creatorId`. Idempotent; safe to retry.
 */
provisionRoutes.post('/provision-data', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json<{ appId?: string; creatorId?: string }>();
  if (!body.appId || !/^[a-z][a-z0-9-]*$/.test(body.appId) || body.appId.length > 58) {
    return c.text('Invalid app ID', 400);
  }
  if (!body.creatorId) return c.text('creatorId required', 400);
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    return c.text('Platform provisioning not configured (missing CF credentials)', 503);
  }
  if (!c.env.SESSION_SIGNING_KEY) {
    return c.text('Platform provisioning not configured (missing SESSION_SIGNING_KEY)', 503);
  }

  // SECURITY (#82): the same "not yours" check /v1/provision makes, for the
  // same reason. appId here is an Agent Teams project slug, and slugs are only
  // unique among agent projects — nothing stops a user naming theirs after
  // someone else's published app. Without this, their deploy stage would drive
  // a redeploy of that app's data worker on the owner's behalf. The internal
  // token authenticates agent-teams, not the user it is acting for.
  //
  // Team developers pass: running Agent Teams on an app you build for its
  // creator is legitimate. Before any Cloudflare call, like the user path.
  const claimed = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
    .bind(body.appId)
    .first<{ creator_id: string }>();
  if (claimed && claimed.creator_id !== body.creatorId) {
    const member = await c.env.DB.prepare('SELECT role FROM team_members WHERE app_id = ? AND user_id = ?')
      .bind(body.appId, body.creatorId)
      .first<{ role: string }>();
    if (!member || TEAM_ROLES.indexOf(member.role as TeamRole) < TEAM_ROLES.indexOf('developer')) {
      return c.text('appId already claimed by another user', 403);
    }
  }

  const data = await provisionData({
    appId: body.appId,
    creatorId: body.creatorId,
    cfToken: c.env.CF_API_TOKEN,
    cfAccount: c.env.CF_ACCOUNT_ID,
    db: c.env.DB,
    sessionSigningKey: c.env.SESSION_SIGNING_KEY,
    internalToken: c.env.INTERNAL_TOKEN ?? '',
    dataWorkerHost: c.env.DATA_WORKER_HOST,
  });
  const success = !data.steps.some((s) => s.status === 'fail');
  return c.json({ appId: body.appId, steps: data.steps, dataWorkerUrl: data.dataWorkerUrl, success }, success ? 200 : 207);
});

// deploy-credentials endpoint REMOVED — was leaking the platform-wide CF_API_TOKEN
// to any app owner. With R2 hosting, deploy workflows use org-level R2_* secrets
// (set via Doppler → GitHub org). Data-worker provisioning happens server-side
// via /v1/provision — no client-side CF token needed.

