/**
 * Headless QA executor (#38). Picks up queued `app_test_runs` and executes
 * them against the LIVE app in Cloudflare Browser Rendering. Step semantics
 * come from the SAME qa-spec DOM-runner bundle the observable runner page
 * uses — injected into the page via evaluate — so a flow can never pass in
 * one executor and fail in the other due to resolver drift. Puppeteer
 * orchestrates only navigation, injection, and screenshots.
 *
 * Trigger paths: backend service-binding nudge after POST /qa/runs, and a
 * 15-minute cron as the safety net. Runs execute serially (Browser Rendering
 * concurrency is a scarce resource).
 */
import puppeteer, { type Browser, type BrowserContext, type Page } from '@cloudflare/puppeteer';
import { DOM_RUNNER_BUNDLE } from '@proappstore/qa-spec/browser-bundle';
import { PW_VIEWPORT, type Step, type StepResult, type TestFlow } from '@proappstore/qa-spec';

interface Env {
  BROWSER: Fetcher;
  DB: D1Database;
  STORAGE: R2Bucket;
}

interface RunRow {
  run_id: string;
  app_id: string;
  flow_id: string;
}

const APP_BASE = (appId: string) => `https://${appId}.proappstore.online`;
const STEP_TIMEOUT_MS = 10_000;
const MAX_RUNS_PER_INVOCATION = 10;
// A run is claimed queued→running, then finished within ~a minute. If an
// executor invocation dies mid-run (edge eviction, cancellation), the row is
// left 'running' forever — processQueued only picks 'queued', so it never
// recovers. Reclaim runs stuck 'running' well past any realistic batch.
const STALE_RUN_MS = 600_000; // 10 min

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/execute' && request.method === 'POST') {
      const appId = url.searchParams.get('app');
      ctx.waitUntil(processQueued(env, appId));
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true, worker: 'proappstore-qa-worker' });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processQueued(env, null));
  },
};

async function processQueued(env: Env, appId: string | null): Promise<void> {
  // Recover runs abandoned in 'running' by a dead executor invocation.
  await env.DB.prepare(
    `UPDATE app_test_runs SET status = 'error', error = 'executor did not finish (timed out)', finished_at = ?1
     WHERE status = 'running' AND started_at < ?2`,
  ).bind(Date.now(), Date.now() - STALE_RUN_MS).run();

  const queued = appId
    ? await env.DB.prepare(
        "SELECT run_id, app_id, flow_id FROM app_test_runs WHERE status = 'queued' AND trigger_kind != 'browser' AND app_id = ?1 ORDER BY started_at LIMIT ?2",
      ).bind(appId, MAX_RUNS_PER_INVOCATION).all<RunRow>()
    : await env.DB.prepare(
        "SELECT run_id, app_id, flow_id FROM app_test_runs WHERE status = 'queued' AND trigger_kind != 'browser' ORDER BY started_at LIMIT ?1",
      ).bind(MAX_RUNS_PER_INVOCATION).all<RunRow>();
  if (queued.results.length === 0) return;

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    for (const run of queued.results) {
      // Claim: queued → running (skip if another invocation grabbed it).
      const claim = await env.DB.prepare(
        "UPDATE app_test_runs SET status = 'running' WHERE run_id = ?1 AND status = 'queued'",
      ).bind(run.run_id).run();
      if (claim.meta.changes === 0) continue;
      await executeRun(env, browser, run);
    }
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function executeRun(env: Env, browser: Browser, run: RunRow): Promise<void> {
  const artifactsPrefix = `qa/${run.app_id}/${run.run_id}`;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    const flowRow = await env.DB.prepare(
      'SELECT spec FROM app_test_flows WHERE app_id = ?1 AND flow_id = ?2',
    ).bind(run.app_id, run.flow_id).first<{ spec: string }>();
    if (!flowRow) {
      await finishRun(env, run.run_id, { status: 'error', error: 'flow no longer exists' });
      return;
    }
    const flow = JSON.parse(flowRow.spec) as TestFlow;

    // Isolated storage per run: a sign-in flow writes a session to the app's
    // localStorage — a shared browser context would leak it into the next
    // flow's page, so a "signed-out" flow would load already signed in (flaky
    // "sign-in button not found"). Each run gets its own incognito context.
    context = await browser.createBrowserContext();
    page = await context.newPage();
    await page.setViewport(PW_VIEWPORT);
    // Cache-bust: post-deploy runs race the host worker's 60s edge cache.
    await gotoApp(page, run.app_id, flow.startPath ?? '/');

    const results: StepResult[] = [];
    let failedStep: number | null = null;
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      const result = await executeStep(env, page, run, artifactsPrefix, step, i);
      results.push(result);
      if (!result.ok) {
        failedStep = i;
        break;
      }
    }

    if (failedStep !== null) {
      await screenshotToR2(env, page, `${artifactsPrefix}/failed-step-${failedStep + 1}.png`);
      const failed = results[failedStep]!;
      await finishRun(env, run.run_id, {
        status: 'failed',
        stepsTotal: flow.steps.length,
        stepsPassed: results.filter((r) => r.ok).length,
        failedStep,
        error: failed.error ?? null,
        artifactsPrefix,
      });
    } else {
      await screenshotToR2(env, page, `${artifactsPrefix}/final.png`);
      await finishRun(env, run.run_id, {
        status: 'passed',
        stepsTotal: flow.steps.length,
        stepsPassed: results.length,
        artifactsPrefix,
      });
    }
  } catch (err) {
    await finishRun(env, run.run_id, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      artifactsPrefix,
    });
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  }
}

async function executeStep(
  env: Env,
  page: Page,
  run: RunRow,
  artifactsPrefix: string,
  step: Step,
  index: number,
): Promise<StepResult> {
  const started = Date.now();
  try {
    if (step.op === 'goto') {
      await gotoApp(page, run.app_id, step.path);
      return { index, op: step.op, ok: true, ms: Date.now() - started };
    }
    if (step.op === 'screenshot') {
      await screenshotToR2(env, page, `${artifactsPrefix}/${step.name ?? `step-${index + 1}`}.png`);
      return { index, op: step.op, ok: true, ms: Date.now() - started };
    }

    // Everything else runs IN-PAGE via the shared DOM runner (single-step
    // flow → single source of step semantics). SPA route changes triggered by
    // clicks keep the JS context, so the bundle stays loaded. The callback is
    // typed opaquely: it executes in the page (DOM), but this worker compiles
    // against workers-types (no DOM lib — the two conflict).
    const result = (await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (s: any, timeoutMs: number) => {
        const g = globalThis as any;
        const res = await g.__pasQaRunner.runFlow(
          { id: 'step', name: 'step', steps: [s] },
          { getDocument: () => g.document, navigate: async () => {}, timeoutMs },
        );
        return res.results[0];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
      step,
      STEP_TIMEOUT_MS,
    )) as { ok: boolean; error?: string } | undefined;

    return {
      index,
      op: step.op,
      ok: result?.ok ?? false,
      ms: Date.now() - started,
      ...(result?.ok ? {} : { error: result?.error ?? 'step did not report a result' }),
    };
  } catch (err) {
    return {
      index,
      op: step.op,
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function gotoApp(page: Page, appId: string, path: string): Promise<void> {
  const url = new URL(path, APP_BASE(appId));
  url.searchParams.set('__qa_bust', String(Date.now()));
  await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 30_000 });
  await page.evaluate(DOM_RUNNER_BUNDLE);
}

async function screenshotToR2(env: Env, page: Page, key: string): Promise<void> {
  try {
    const shot = (await page.screenshot({ type: 'png' })) as unknown;
    // @cloudflare/puppeteer's return type varies by version (Buffer | Uint8Array
    // | base64 string). Normalize to bytes so R2 never stores an empty/garbled
    // object. A raw string is treated as base64 (its screenshot encoding).
    const body =
      typeof shot === 'string'
        ? decodeBase64(shot)
        : shot instanceof ArrayBuffer
          ? new Uint8Array(shot)
          : (shot as Uint8Array);
    await env.STORAGE.put(key, body, { httpMetadata: { contentType: 'image/png' } });
  } catch (err) {
    // Best-effort — never fail a run over a screenshot. Persist the reason to R2
    // (a sibling .error.txt) so a silent regression is diagnosable without tail.
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await env.STORAGE.put(`${key}.error.txt`, msg).catch(() => {});
  }
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function finishRun(
  env: Env,
  runId: string,
  outcome: {
    status: 'passed' | 'failed' | 'error';
    stepsTotal?: number;
    stepsPassed?: number;
    failedStep?: number | null;
    error?: string | null;
    artifactsPrefix?: string;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE app_test_runs
     SET status = ?2, steps_total = ?3, steps_passed = ?4, failed_step = ?5, error = ?6,
         artifacts_prefix = ?7, finished_at = ?8
     WHERE run_id = ?1`,
  ).bind(
    runId,
    outcome.status,
    outcome.stepsTotal ?? null,
    outcome.stepsPassed ?? null,
    outcome.failedStep ?? null,
    outcome.error ?? null,
    outcome.artifactsPrefix ?? null,
    Date.now(),
  ).run();
}
