import { describe, expect, it, vi } from "vitest";
import worker from "./index.js";
import type { Env } from "./env.js";

/**
 * Route-level tests for the agent provisioning Workflow endpoints. The point of
 * record here is the #24 regression fix: the agent route must create the Workflow
 * instance with a CF-AUTO-GENERATED id (no explicit `id`), so an app can deploy
 * repeatedly without the `create({id: slug})` 409 on the 2nd deploy.
 */

const TOKEN = "internal-secret";

/** A mock Workflow binding that records create()/get() calls. */
function mockWorkflow(instanceId = "wf-auto-1") {
  const created: unknown[] = [];
  const instance = {
    id: instanceId,
    status: async () => ({ status: "queued", error: null, output: null }),
  };
  return {
    created,
    binding: {
      create: vi.fn(async (opts: unknown) => {
        created.push(opts);
        return instance;
      }),
      get: vi.fn(async (id: string) => ({
        id,
        status: async () => ({ status: "running", error: null, output: null }),
      })),
    } as unknown as Workflow,
  };
}

function envWith(workflow: Workflow): Env {
  return { INTERNAL_TOKEN: TOKEN, PROVISION_WORKFLOW: workflow } as unknown as Env;
}

function agentReq(headers: Record<string, string>, body: unknown): Request {
  return new Request("https://admin.proappstore.online/api/provision-workflow/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const ctx = {} as ExecutionContext;
const VALID_BODY = {
  id: "myapp",
  name: "My App",
  description: "d",
  category: "tools",
  icon: "X",
  iconBg: "#000",
  files: { "index.html": "<html></html>" },
};

describe("POST /api/provision-workflow/agent", () => {
  it("403s without a valid internal token", async () => {
    const { binding, created } = mockWorkflow();
    const res = await worker.fetch(agentReq({}, VALID_BODY), envWith(binding), ctx);
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0); // never touched the Workflow
  });

  it("400s when id or name is missing", async () => {
    const { binding } = mockWorkflow();
    const res = await worker.fetch(
      agentReq({ "X-Internal-Token": TOKEN }, { name: "no id" }),
      envWith(binding),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("creates the instance with a CF-AUTO id (NO explicit id) and returns 202", async () => {
    const { binding, created } = mockWorkflow("wf-auto-xyz");
    const res = await worker.fetch(
      agentReq({ "X-Internal-Token": TOKEN }, VALID_BODY),
      envWith(binding),
      ctx,
    );
    expect(res.status).toBe(202);
    expect(created).toHaveLength(1);

    const arg = created[0] as { id?: string; params: { req: { id: string }; files: unknown; addRegistry: boolean } };
    // THE regression lock: no explicit id → CF auto-generates → no 409 on redeploy.
    expect("id" in arg).toBe(false);
    expect(arg.params.req.id).toBe("myapp");
    expect(arg.params.files).toEqual(VALID_BODY.files);
    expect(arg.params.addRegistry).toBe(false);

    const json = (await res.json()) as { id: string; status: { status: string } };
    expect(json.id).toBe("wf-auto-xyz"); // returns the instance id for the caller to poll
    expect(json.status.status).toBe("queued");
  });

  it("two deploys of the SAME slug both succeed (no 409) with distinct instances", async () => {
    // The old code did create({ id: slug }) and 409'd here. Auto-id never collides.
    const w1 = mockWorkflow("inst-1");
    const w2 = mockWorkflow("inst-2");
    const r1 = await worker.fetch(agentReq({ "X-Internal-Token": TOKEN }, VALID_BODY), envWith(w1.binding), ctx);
    const r2 = await worker.fetch(agentReq({ "X-Internal-Token": TOKEN }, VALID_BODY), envWith(w2.binding), ctx);
    expect(r1.status).toBe(202);
    expect(r2.status).toBe(202);
    expect((await r1.json() as { id: string }).id).toBe("inst-1");
    expect((await r2.json() as { id: string }).id).toBe("inst-2");
  });
});

describe("GET /api/provision-workflow/status", () => {
  it("403s without a valid internal token", async () => {
    const { binding } = mockWorkflow();
    const res = await worker.fetch(
      new Request("https://admin.proappstore.online/api/provision-workflow/status?id=inst-1"),
      envWith(binding),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("400s when id is missing", async () => {
    const { binding } = mockWorkflow();
    const res = await worker.fetch(
      new Request("https://admin.proappstore.online/api/provision-workflow/status", {
        headers: { "X-Internal-Token": TOKEN },
      }),
      envWith(binding),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns the instance status for a valid id", async () => {
    const { binding } = mockWorkflow();
    const res = await worker.fetch(
      new Request("https://admin.proappstore.online/api/provision-workflow/status?id=inst-1", {
        headers: { "X-Internal-Token": TOKEN },
      }),
      envWith(binding),
      ctx,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; status: { status: string } };
    expect(json.id).toBe("inst-1");
    expect(json.status.status).toBe("running");
  });
});
