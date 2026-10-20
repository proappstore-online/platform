import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";
import { handlePlatformMediation, TRACE_ID_HEADER } from "./platform-mediation.js";

// #394: browser data-plane calls never touch the API, so the host is the one hop
// that sees their 5xx. It reports each over the private HostApi binding, after
// the response, with the trace every hop past it shares — and nothing else.

const route = { slug: "chess-academy" } as unknown as Route;
const ORIGIN = "https://chess-academy.proappstore.online";
const VALID = `00-${"ab".repeat(16)}-${"cd".repeat(8)}-01`;

function setup(upstream: () => Promise<Response>) {
  const reports: Request[] = [];
  const API = {
    fetch: vi.fn(async (req: Request) => {
      reports.push(req);
      return new Response(null, { status: 204 });
    }),
  };
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      waits.push(p);
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  const dataFetch = vi.fn(async (_req: Request) => upstream());
  vi.stubGlobal("fetch", dataFetch);
  return { env: { API, DATA_WORKER_HOST: "acct.workers.dev" } as unknown as Env, ctx, reports, waits, dataFetch };
}

function dataRequest(headers: Record<string, string> = {}, path = "/.pas/data/query?debug=secret") {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=cookie-token`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ sql: "select secret from t" }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("data-plane failure reporting (#394)", () => {
  it("a data-worker 5xx is reported over HostApi with status, fault, endpoint and the forwarded trace — no URL, SQL or credential", async () => {
    const { env, ctx, reports, waits, dataFetch } = setup(async () =>
      Response.json(
        { error: "internal server error" },
        { status: 500, headers: { "X-PAS-Fault": "platform", "cf-ray": "8f1e2d3c4b5a6978-LHR" } },
      ),
    );

    const res = await handlePlatformMediation(dataRequest({ traceparent: VALID }), env, route, ctx);
    await Promise.all(waits);

    expect(res!.status).toBe(500);
    expect(res!.headers.get(TRACE_ID_HEADER)).toBe("ab".repeat(16));
    expect(dataFetch.mock.calls[0]![0].headers.get("traceparent")).toBe(VALID);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.url).toBe("https://api.proappstore.online/v1/internal/data-plane-failures");
    expect(report.headers.get("X-PAS-App")).toBe("chess-academy");
    expect(report.headers.get("X-PAS-Data-Plane-Failure")).toBe("1");
    expect(report.headers.get("traceparent")).toBe(VALID);
    expect(report.headers.get("Authorization")).toBeNull();
    const body = await report.text();
    expect(JSON.parse(body)).toEqual({
      status: 500,
      fault: "platform",
      endpoint: "query",
      cfRay: "8f1e2d3c4b5a6978-LHR",
    });
    expect(body).not.toContain("secret");
    expect(body).not.toContain("cookie-token");
  });

  it("without a page traceparent the host mints one; the data worker and the report share it", async () => {
    const { env, ctx, reports, waits, dataFetch } = setup(
      async () => new Response("boom", { status: 503 }),
    );
    const res = await handlePlatformMediation(dataRequest(), env, route, ctx);
    await Promise.all(waits);

    const forwarded = dataFetch.mock.calls[0]![0].headers.get("traceparent")!;
    expect(forwarded).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(reports[0]!.headers.get("traceparent")).toBe(forwarded);
    expect(res!.headers.get(TRACE_ID_HEADER)).toBe(forwarded.slice(3, 35));
    // A pre-#394 data worker sends no verdict: reported as such, not guessed.
    expect(JSON.parse(await reports[0]!.text())).toMatchObject({ status: 503, fault: null });
  });

  it("an unreachable data worker is a 502 platform fault with a trace id, not an unhandled exception", async () => {
    const { env, ctx, reports, waits } = setup(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const res = await handlePlatformMediation(dataRequest({ traceparent: VALID }), env, route, ctx);
    await Promise.all(waits);

    expect(res!.status).toBe(502);
    expect(res!.headers.get(TRACE_ID_HEADER)).toBe("ab".repeat(16));
    expect(JSON.parse(await reports[0]!.text())).toMatchObject({ status: 502, fault: "platform" });
  });

  it.each([
    200, 400, 401, 403, 422,
  ])("a %i is not a data-plane failure: nothing is reported", async (status) => {
    const { env, ctx, reports } = setup(async () => new Response("{}", { status }));
    const res = await handlePlatformMediation(dataRequest(), env, route, ctx);
    expect(res!.status).toBe(status);
    expect(res!.headers.get(TRACE_ID_HEADER)).toBeNull();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(reports).toHaveLength(0);
  });

  it("the report never holds up or changes the browser's answer when HostApi fails", async () => {
    const { ctx, waits } = setup(async () => new Response("x", { status: 500 }));
    const env = {
      DATA_WORKER_HOST: "acct.workers.dev",
      API: {
        fetch: vi.fn(async () => {
          throw new Error("binding down");
        }),
      },
    } as unknown as Env;
    const res = await handlePlatformMediation(dataRequest(), env, route, ctx);
    await expect(Promise.all(waits)).resolves.toBeDefined();
    expect(res!.status).toBe(500);
  });

  it("a page cannot forge the host-only failure marker upstream", async () => {
    const { env, ctx, dataFetch } = setup(async () => new Response("{}", { status: 200 }));
    await handlePlatformMediation(
      dataRequest({ "X-PAS-Data-Plane-Failure": "1" }),
      env,
      route,
      ctx,
    );
    expect(dataFetch.mock.calls[0]![0].headers.get("X-PAS-Data-Plane-Failure")).toBeNull();
  });

  // #429: X-PAS-Country is host-asserted (from cf) and trusted by the backend on
  // HostApi requests; a page's copy passed through and could set any visitor country.
  it("a page cannot forge the host-only visitor country upstream", async () => {
    const { env, ctx, dataFetch } = setup(async () => new Response("{}", { status: 200 }));
    await handlePlatformMediation(dataRequest({ "X-PAS-Country": "KP" }), env, route, ctx);
    expect(dataFetch.mock.calls[0]![0].headers.get("X-PAS-Country")).toBeNull();
  });
});
