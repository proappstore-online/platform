/**
 * Cloudflare Workflow shell for durable publish provisioning (spike).
 *
 * Thin adapter only: the actual step sequence lives in runProvisionSteps()
 * (publish.ts) so it stays testable under the Node runner. This file is the one
 * place that imports the workerd-only `cloudflare:workers` / `cloudflare:workflows`
 * virtual modules, so it is never pulled into the Node test graph — it is loaded
 * only by the Worker bundle (referenced by class_name in wrangler.toml and
 * re-exported from index.ts).
 *
 * Refs proappstore-online/platform#24.
 */

import type { Step } from "@proappstore/build-core";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./env.js";
import {
  type CiGateResult,
  type ProvisionParams,
  ProvisionValidationError,
  runProvisionSteps,
} from "./publish.js";

export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(
    event: WorkflowEvent<ProvisionParams>,
    step: WorkflowStep,
  ): Promise<{ steps: Step[]; repoUrl: string; commitSha?: string }> {
    try {
      // Drive the shared sequence with the durable step runner: each step is
      // persisted + retried independently; completed steps are never re-run. The
      // agent path also waits (billed $0) for the app's CI verdict, delivered by
      // handleDeployStatus → instance.sendEvent("ci-result").
      return await runProvisionSteps(
        event.payload,
        this.env,
        (name, cb) => step.do(name, cb),
        async () => {
          const ev = await step.waitForEvent<CiGateResult>("ci-gate", {
            type: "ci-result",
            timeout: "15 minutes",
          });
          return ev.payload as CiGateResult;
        },
      );
    } catch (e) {
      // A bad id/name is deterministic — tell the engine not to retry it.
      if (e instanceof ProvisionValidationError) throw new NonRetryableError(e.message);
      throw e;
    }
  }
}
