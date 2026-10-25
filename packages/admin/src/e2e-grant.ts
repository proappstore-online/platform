import type { Step } from "@proappstore/build-core";
import type { Env } from "./env.js";

/**
 * Keyless e2e login for every new app (#462). The deploy pipeline's e2e job
 * trades its GitHub OIDC token at `POST /v1/auth/exchange/oidc` for a session of
 * a designated test account; that exchange only works for a repository with an
 * oidc-session grant. Provisioning creates the grant, so a new app needs no
 * manual admin step and no stored `PAS_E2E_SESSION_TOKEN`.
 */

/** The managed test principal (platform #432) auto-created grants target, unless `E2E_TEST_PRINCIPAL` overrides it. */
export const DEFAULT_E2E_TEST_PRINCIPAL = "e2e-tester";
/** The one workflow and ref that may mint: the canonical deploy workflow on main. */
export const E2E_GRANT_WORKFLOW = ".github/workflows/deploy.yml";
export const E2E_GRANT_REF = "refs/heads/main";
const STEP = "OIDC test login";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

/** A loud, non-fatal failure: provisioning goes on, but the step is red and the log says why. */
function failed(detail: string): Step {
  console.error(`[e2e-grant] ${detail}`);
  return { name: STEP, status: "fail", detail };
}

/**
 * Ensure `<org>/<app>` can mint a test session from `.github/workflows/deploy.yml` on `main`.
 * Idempotent, and it never replaces a grant someone already made for that repo/workflow/ref.
 *
 * The target is a managed test principal chosen by the `E2E_TEST_PRINCIPAL` setting
 * (default `e2e-tester`: no real data, no billing, no sensitive access). There is NO
 * fallback account: if the principal does not exist or is disabled, no grant is made and
 * the step fails loudly, naming it. It never throws — a missing test account must not
 * block provisioning an app.
 */
export async function ensureOidcTestGrant(env: Env, appId: string): Promise<Step> {
  const slug = (env.E2E_TEST_PRINCIPAL ?? DEFAULT_E2E_TEST_PRINCIPAL).trim();
  const repository = `${env.PUBLISHERS_ORG}/${appId}`;
  if (!SLUG_RE.test(slug)) {
    return failed(`E2E_TEST_PRINCIPAL "${slug}" is not a valid test-principal slug; no oidc-session grant was created for ${repository}`);
  }
  try {
    const principal = await env.DB.prepare("SELECT id, user_id, status FROM test_principals WHERE slug = ?")
      .bind(slug).first<{ id: string; user_id: string; status: string }>();
    if (!principal) {
      return failed(`test account "${slug}" does not exist; no oidc-session grant was created for ${repository}. Its e2e job will fail until an admin creates the account and a grant (no fallback account is used)`);
    }
    if (principal.status !== "active") {
      return failed(`test account "${slug}" is ${principal.status}; no oidc-session grant was created for ${repository}`);
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    // One statement, so two concurrent provisions cannot both insert.
    const inserted = await env.DB.prepare(
      `INSERT INTO oidc_session_grants (id, repository, workflow, ref, user_id, label, created_by, created_at, principal_id, scope)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'system:provision', ?7, ?8, 'user'
       WHERE NOT EXISTS (SELECT 1 FROM oidc_session_grants WHERE repository = ?2 AND workflow = ?3 AND ref = ?4 AND revoked_at IS NULL)`,
    ).bind(id, repository, E2E_GRANT_WORKFLOW, E2E_GRANT_REF, principal.user_id, `auto: e2e login for ${appId}`, now, principal.id).run();

    if (!inserted.meta?.changes) {
      return { name: STEP, status: "skip", detail: `${repository} already has an oidc-session grant for ${E2E_GRANT_WORKFLOW} @ ${E2E_GRANT_REF}` };
    }
    await env.DB.prepare(
      "INSERT INTO test_principal_events (principal_id, grant_id, action, actor, detail, at, request_id, reason) VALUES (?, ?, 'grant.create', 'system:provision', ?, ?, ?, ?)",
    ).bind(
      principal.id, id,
      JSON.stringify({ after: { repository, workflow: E2E_GRANT_WORKFLOW, ref: E2E_GRANT_REF, scope: "user" } }),
      now, `provision:${appId}`, "automatic grant when the app was provisioned (#462)",
    ).run();
    return { name: STEP, status: "ok", detail: `${repository} may mint a "${slug}" test session from ${E2E_GRANT_WORKFLOW} on main` };
  } catch (e) {
    return failed(`could not create the oidc-session grant for ${repository}: ${(e as Error).message}`);
  }
}
