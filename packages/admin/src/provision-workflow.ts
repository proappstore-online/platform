/**
 * Cloudflare Workflow shell for durable publish/agent provisioning.
 *
 * Thin adapter only: the actual step sequence lives in runProvisionSteps()
 * (publish.ts) and the CI poll loop in pollCiToVerdict(), so both stay testable
 * under the Node runner. This file is the one place that imports the workerd-only
 * `cloudflare:workers` / `cloudflare:workflows` virtual modules, so it is never
 * pulled into the Node test graph — it is loaded only by the Worker bundle
 * (referenced by class_name in wrangler.toml and re-exported from index.ts).
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
  pollCiToVerdict,
  type ProvisionParams,
  ProvisionValidationError,
  runProvisionSteps,
} from "./publish.js";

export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(
    event: WorkflowEvent<ProvisionParams>,
    step: WorkflowStep,
  ): Promise<{ steps: Step[]; repoUrl: string; commitSha?: string }> {
    const env = this.env;
    const appId = event.payload.req.id;
    const gh = makeGitHub(env.GITHUB_TOKEN, env.PUBLISHERS_ORG);

    // CI waiter: poll the exact pushed commit to a terminal verdict via the
    // Node-tested loop, backed by durable step.do + step.sleep primitives.
    const waitForCi = (sha: string | undefined) =>
      pollCiToVerdict({
        check: () => gh.deployResult(appId, { waitMs: 0, ...(sha ? { sha } : {}) }),
        doStep: (name, cb) => step.do(name, cb),
        // CI_POLL_INTERVAL is a valid duration literal; cast to CF's branded type.
        sleep: (name, duration) => step.sleep(name, duration as Parameters<typeof step.sleep>[1]),
      });

    try {
      return await runProvisionSteps(event.payload, env, (name, cb) => step.do(name, cb), waitForCi);
    } catch (e) {
      // A bad id/name is deterministic — tell the engine not to retry it.
      if (e instanceof ProvisionValidationError) throw new NonRetryableError(e.message);
      throw e;
    }
  }
}
