import { describe, expect, it } from "vitest";
import { keyForPath } from "./index.js";

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
