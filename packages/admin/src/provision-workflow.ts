/**
 * Cloudflare Workflow shell for durable publish/agent provisioning.
 *
 * Thin adapter only: the actual step sequence lives in runProvisionSteps()
 * (publish.ts) so it stays testable under the Node runner. This file is the one
 * place that imports the workerd-only `cloudflare:workers` / `cloudflare:workflows`
 * virtual modules, so it is never pulled into the Node test graph — it is loaded
 * only by the Worker bundle (referenced by class_name in wrangler.toml and
 * re-exported from index.ts).
 *
 * CI gate: the agent path blocks on CI going green by POLLING GitHub for the
 * pushed commit's run, sleeping (billed $0) between checks via `step.sleep`. This
 * is self-contained — no external event sender — so the instance id no longer has
 * to equal the app slug. That removes the single-shot-per-app cap that an earlier
 * `waitForEvent`/`instance.sendEvent(slug)` design had (an app deploys many times;
 * `create({id: slug})` 409s on the 2nd deploy within the retention window).
 *
 * Refs proappstore-online/platform#24.
 */

import { makeGitHub, type Step } from "@proappstore/build-core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./env.js";
import {
  type CiGateResult,
  type ProvisionParams,
  ProvisionValidationError,
  runProvisionSteps,
} from "./publish.js";

// CI poll budget: each tick is one cheap GitHub check, then a durable sleep.
// 40 × 20s ≈ 13 min of build time before we declare the deploy timed out — well
// past a normal CI run, and the sleeps cost nothing.
const CI_POLL_MAX = 40;
const CI_POLL_INTERVAL = "20 seconds";

export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(
    event: WorkflowEvent<ProvisionParams>,
    step: WorkflowStep,
  ): Promise<{ steps: Step[]; repoUrl: string; commitSha?: string }> {
    const env = this.env;
    const appId = event.payload.req.id;
    const gh = makeGitHub(env.GITHUB_TOKEN, env.PUBLISHERS_ORG);

    // CI waiter: poll the exact pushed commit's run to a terminal verdict,
    // sleeping durably between checks. Each poll is its own step.do (persisted +
    // memoized), so a worker eviction mid-build resumes the loop, it doesn't
    // restart it.
    const waitForCi = async (sha: string | undefined): Promise<CiGateResult> => {
      for (let i = 0; i < CI_POLL_MAX; i++) {
        const verdict = await step.do(`ci-poll-${i}`, async (): Promise<CiGateResult | null> => {
          const r = await gh.deployResult(appId, { waitMs: 0, ...(sha ? { sha } : {}) });
          // 'pending' (no run yet) / 'in_progress' → keep waiting (null = not terminal).
          if (r.status !== "completed") return null;
          return {
            ok: r.ok,
            ...(r.conclusion ? { conclusion: r.conclusion } : {}),
            ...(r.url ? { url: r.url } : {}),
            ...(r.errorTail ? { errorTail: r.errorTail } : {}),
          };
        });
        if (verdict) return verdict;
        await step.sleep(`ci-wait-${i}`, CI_POLL_INTERVAL);
      }
      return { ok: false, conclusion: "timeout", errorTail: `CI did not finish within ${CI_POLL_MAX} polls` };
    };

    try {
      return await runProvisionSteps(event.payload, env, (name, cb) => step.do(name, cb), waitForCi);
    } catch (e) {
      // A bad id/name is deterministic — tell the engine not to retry it.
      if (e instanceof ProvisionValidationError) throw new NonRetryableError(e.message);
      throw e;
    }
  }
}
