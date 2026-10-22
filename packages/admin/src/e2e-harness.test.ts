import { describe, expect, it } from "vitest";
import ts from "typescript";
import { e2eHarnessFiles } from "./e2e-harness.js";

// The harness is injected into every agent-built app as strings, so a syntax slip
// would only surface in someone's CI. These checks pin the #463 contract.
describe("e2e harness (#463)", () => {
  const files = e2eHarnessFiles();

  it("ships TypeScript that parses", () => {
    for (const path of ["e2e/fixtures.ts", "e2e/specs/smoke.spec.ts", "e2e/playwright.config.ts"]) {
      const out = ts.transpileModule(files[path]!, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
      expect(out.diagnostics, path).toEqual([]);
    }
  });

  it("mints the signed-in session from the OIDC exchange, with no stored credential", () => {
    const fixtures = files["e2e/fixtures.ts"]!;
    expect(fixtures).toContain("/v1/auth/exchange/oidc");
    expect(fixtures).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(fixtures).toContain("#pas_session=");
    for (const content of Object.values(files)) {
      expect(content).not.toMatch(/credentials\/login|secrets\.|E2E_TEST_(USERNAME|PASSWORD)/);
      expect(content).not.toContain("PAS_E2E_SESSION_TOKEN");
    }
  });

  it("smoke covers the anonymous 2xx + clean console check and the signed-in check", () => {
    const smoke = files["e2e/specs/smoke.spec.ts"]!;
    expect(smoke).toContain("anonApp");
    expect(smoke).toContain("toBeLessThan(300)");
    expect(smoke).toContain("consoleErrors");
    expect(smoke).toContain("signedInApp");
  });
});
