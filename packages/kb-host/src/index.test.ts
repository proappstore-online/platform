import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./github-oidc.js", () => ({ verifyGithubOidc: vi.fn() }));

import { keyForPath } from "./index.js";
import worker from "./index.js";
import { verifyGithubOidc } from "./github-oidc.js";

const mockVerify = verifyGithubOidc as unknown as ReturnType<typeof vi.fn>;

describe("keyForPath", () => {
  it("maps app KB paths by slug on the KB host", () => {
    expect(keyForPath("/interns/", "kb.proappstore.online")).toBe("interns/index.html");
    expect(keyForPath("/interns/setup/", "kb.proappstore.online")).toBe("interns/setup/index.html");
    expect(keyForPath("/interns/assets/app.css", "kb.proappstore.online")).toBe("interns/assets/app.css");
  });

  it("maps the docs host root to the platform docs prefix", () => {
    expect(keyForPath("/", "docs.proappstore.online")).toBe("platform/index.html");
    expect(keyForPath("/ui/", "docs.proappstore.online")).toBe("platform/ui/index.html");
    expect(keyForPath("/mcp-app-tools/", "docs.proappstore.online")).toBe("platform/mcp-app-tools/index.html");
  });

  it("rejects traversal attempts", () => {
    expect(keyForPath("/../secret", "kb.proappstore.online")).toBeNull();
    expect(keyForPath("/../secret", "docs.proappstore.online")).toBeNull();
  });
});

describe("_ingest authorization (#57)", () => {
  const put = vi.fn();
  const env = { KB_R2: { put, get: vi.fn() } } as never;

  beforeEach(() => {
    put.mockReset().mockResolvedValue(undefined);
    mockVerify.mockReset();
  });

  const ingest = (key: string, headers: Record<string, string>) =>
    worker.fetch(
      new Request(`https://kb.proappstore.online/_ingest/${key}`, { method: "PUT", headers, body: "x" }),
      env,
    );

  it("the retired shared x-internal-token is refused for EVERY prefix (#57 step 4)", async () => {
    // The shared CI secret used to be accepted for any app prefix. It never
    // proved which app was calling, so this must stay a 403 even for a value
    // that would once have matched — there is no token to match any more.
    expect((await ingest("interns/index.html", { "x-internal-token": "shared-secret" })).status).toBe(403);
    expect((await ingest("platform/index.html", { "x-internal-token": "shared-secret" })).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it("an absent credential is rejected", async () => {
    expect((await ingest("interns/x.html", {})).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });

  it("OIDC may write only its own app prefix", async () => {
    mockVerify.mockResolvedValue({ repository: "proappstore-online/interns" });
    expect((await ingest("interns/x.html", { authorization: "Bearer tok" })).status).toBe(200);

    mockVerify.mockResolvedValue({ repository: "proappstore-online/evil" });
    expect((await ingest("interns/x.html", { authorization: "Bearer tok" })).status).toBe(403);
  });

  it("OIDC platform/ writes require the docs repo", async () => {
    mockVerify.mockResolvedValue({ repository: "proappstore-online/platform" });
    expect((await ingest("platform/x.html", { authorization: "Bearer tok" })).status).toBe(200);

    mockVerify.mockResolvedValue({ repository: "proappstore-online/interns" });
    expect((await ingest("platform/x.html", { authorization: "Bearer tok" })).status).toBe(403);
  });

  it("an invalid OIDC token is rejected", async () => {
    mockVerify.mockRejectedValue(new Error("bad audience"));
    expect((await ingest("interns/x.html", { authorization: "Bearer tok" })).status).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });
});
