/**
 * The PAS app-provisioning workflow (#367), shared by the `provision_pas_app`
 * MCP tool and the Creator Console's preview/confirm API.
 *
 *   planProvision   read-only: decides create / reuse / adopt / refused, the
 *                   exact template + revision, the changes, and the blockers.
 *   executePlan     performs a plan under a durable receipt (#358): GitHub copy
 *                   or reuse, placeholder commit, /v1/provision, verification.
 *   confirmPlan     the Console path: re-plans, refuses a plan whose bound facts
 *                   changed, then executes it.
 *
 * The Console reaches this through the API worker's MCP service binding
 * (`/internal/provisioning/{plan,execute}`, `handleInternalProvisioning`): this
 * worker holds the org GitHub credential, the browser never does.
 *
 * Provenance: a revision is recorded only when it is proven. For a new repo it
 * is the template head read just before the copy; for an existing scaffold it is
 * the template commit whose tree equals the scaffold's initial commit tree. A
 * reused repo is never credited with today's template head.
 */

import {
  makeGitHub,
  selectTemplate,
  verifyAppOwnership,
  verifySession,
  TEMPLATE_REV_RE,
  type GitHub,
  type TemplateStatus,
} from "@proappstore/build-core";

// ── Shared types ──────────────────────────────────────────────

export interface ProvisionStep {
  name: string;
  status: string;
  detail: string;
}

export interface ProvisionResult {
  appId?: string;
  steps?: ProvisionStep[];
  dataWorkerUrl?: string;
  appUrl?: string;
  success?: boolean;
  error?: string;
}

export type ProvisionOperationStatus = "pending" | "completed" | "failed";
type ProvisionOperationDisplayStatus = ProvisionOperationStatus | "exhausted" | "legacy_unreconciled";

export interface ProvisionOperationReceipt {
  receipt: string;
  appId: string;
  status: ProvisionOperationDisplayStatus;
  steps: ProvisionStep[];
  updatedAt?: number;
  completedAt?: number | null;
  attemptCount?: number;
  leaseExpiresAt?: number | null;
  attemptId?: string | null;
  result?: Record<string, unknown>;
  joined?: boolean;
  /** #369/#374: the server-established failure classification, when one was recorded. */
  failureCode?: string;
}

export interface ProvisionOpts {
  skipCompliance?: boolean;
  template?: string;
  templateRev?: string;
  allowUnapprovedTemplate?: boolean;
  receipt?: string;
  attemptId?: string;
}

export interface WorkflowEnv {
  GITHUB_ORG: string;
  API_BASE: string;
  /** Service bindings — same-zone subrequests bypass route-mapped Workers. */
  API: Fetcher;
  HOST: Fetcher;
  /** #369: lets the workflow record a server-established failure classification on a receipt. */
  INTERNAL_TOKEN?: string;
}

/** #369/#374: the receipt failure classifications only this workflow may establish (INTERNAL_TOKEN). */
export type ProvisionFailureCode = "template_copy_mismatch" | "template_copy_unverified" | "provision_incomplete";

export interface WorkflowUser {
  userId: string | null;
  token: string;
  roles: string[];
}

export type PlanAction = "create" | "reuse_owned" | "reuse_admin" | "adopt_untouched" | "refused";
export type RevisionSource = "template_head" | "scaffold_tree_match" | "unknown";
export type AppRecordState = "owner" | "other" | "none" | "unknown";

export interface PlanBlocker {
  code:
    | "repository_unavailable"
    | "repository_exists"
    | "owned_by_another_account"
    | "app_record_unavailable"
    | "repository_edited"
    | "revision_unresolved"
    | "revision_not_current"
    | "revision_mismatch"
    | "revision_unverified";
  message: string;
}

export interface PlanInput {
  appId: string;
  name: string;
  description: string;
  /** Approved catalogue id (#178). Required on the Console path. */
  template?: string;
  /** Exact template commit the caller expects; proven or refused, never ignored. */
  templateRev?: string;
  /** Required on the Console path: exactly https://github.com/<org>/<appId>. */
  repoUrl?: string;
}

export interface PlanOptions {
  mode: "mcp" | "console";
  /** MCP only, platform admins only. */
  allowUnapprovedTemplate?: boolean;
  /** MCP only. Defaults to true. */
  reuseExistingRepo?: boolean;
  /** Visibility of a repository this plan CREATES. Defaults to true. An existing repo keeps its own. */
  privateRepo?: boolean;
  /** MCP only; honoured by /v1/provision for platform admins alone. */
  skipCompliance?: boolean;
}

export interface ProvisionPlan {
  version: 1;
  appId: string;
  name: string;
  description: string;
  action: PlanAction;
  repository: {
    owner: string;
    name: string;
    url: string;
    exists: boolean | null;
    /** Present only when the caller may act on the repo: the visibility it has, or will be created with. */
    private?: boolean | null;
    headSha?: string | null;
    untouchedScaffold?: boolean;
  };
  appRecord: AppRecordState;
  template: {
    id: string;
    repo: string;
    ref: string;
    status: TemplateStatus | "unapproved";
    reviewedCommit: string | null;
    requestedRevision: string | null;
    revision: string | null;
    revisionSource: RevisionSource;
    /** #369: the tree of `revision`. A new copy is accepted only when its initial tree equals it. */
    revisionTree: string | null;
  };
  changes: string[];
  compliance: { required: boolean };
  blockers: PlanBlocker[];
  warnings: string[];
}

export type PlanOutcome = { ok: true; plan: ProvisionPlan } | { ok: false; error: string };

export type ExecuteOutcome =
  | { kind: "joined"; receipt: ProvisionOperationReceipt }
  | { kind: "error"; error: string; receipt?: ProvisionOperationReceipt; status?: number; retryAfter?: string }
  | {
    kind: "done";
    receipt: ProvisionOperationReceipt;
    repoAction: "created" | "reused" | "adopted";
    lines: string[];
    provision: ProvisionResult;
    succeeded: boolean;
  };

export type ConfirmOutcome =
  | { kind: "plan_changed"; plan: ProvisionPlan }
  | { kind: "plan_blocked"; plan: ProvisionPlan }
  | { kind: "invalid"; error: string }
  | ExecuteOutcome;

const APP_ID_RE = /^[a-z][a-z0-9-]*$/;
const OWNERSHIP_CACHE_TTL_MS = 60_000;
/** #369: how long to wait for GitHub to finish a template copy before its tree counts as unreadable. */
const COPY_TREE_ATTEMPTS = 5;
const COPY_TREE_RETRY_MS = 1_000;

const stepIcon = (status: string) => status === "ok" ? "+" : status === "skip" ? "~" : "!";
const formatSteps = (steps: ProvisionStep[] = []) =>
  steps.map((s) => `${stepIcon(s.status)} ${s.name}: ${s.detail}`).join("\n");

/** Only facts a confirmation is bound to. Anything here changing means the reviewed plan is stale. */
export function planBinding(plan: ProvisionPlan): string {
  return JSON.stringify([
    plan.appId, plan.name, plan.description, plan.action,
    plan.repository.exists, plan.repository.private ?? null, plan.repository.headSha ?? null,
    plan.appRecord,
    plan.template.id, plan.template.requestedRevision, plan.template.revision, plan.template.revisionSource,
    plan.compliance.required,
    plan.blockers.map((b) => b.code),
  ]);
}

// ── Workflow ──────────────────────────────────────────────────

export function createProvisioningWorkflow(env: WorkflowEnv, gh: GitHub) {
  const { GITHUB_ORG: org, API_BASE: apiBase } = env;
  const ownershipCache = new Map<string, { ok: boolean; expiresAt: number }>();

  /** Cached `verifyAppOwnership` (60 s per user and app). */
  async function ownsApp(appId: string, user: Pick<WorkflowUser, "userId" | "token">): Promise<boolean> {
    const cacheKey = `${user.userId ?? user.token}:${appId}`;
    const now = Date.now();
    const cached = ownershipCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.ok;
    // #374: over the API service binding: a same-zone fetch never reaches the API worker.
    const ok = await verifyAppOwnership(apiBase, user.token, appId, (url, init) => env.API.fetch(url, init));
    ownershipCache.set(cacheKey, { ok, expiresAt: now + OWNERSHIP_CACHE_TTL_MS });
    return ok;
  }

  /**
   * Whether a PAS app record exists for `appId`, and whose it is (#144, #370):
   * `owner`, `other`, `none`, or `unknown` when it could not be read. `none` is
   * the orphan case — a repo whose provisioning died before the app-record step.
   * Asked of the backend's side-effect-free record-state read, which answers
   * from the apps table itself; an admin-authorised read (the listing route
   * answers a platform admin 200 for any id) is not evidence of existence or
   * ownership. Over the API service binding, never a same-zone fetch.
   */
  async function appRecordState(appId: string, token: string): Promise<AppRecordState> {
    try {
      const res = await env.API.fetch(`${apiBase}/v1/apps/${encodeURIComponent(appId)}/record-state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) return "unknown";
      const state = ((await res.json()) as { state?: unknown } | null)?.state;
      return state === "owner" || state === "other" || state === "none" ? state : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * The app repo's newest two commits. Exactly one commit (the template-generate "Initial commit") is the untouched
   * scaffold: adopting an orphan is only allowed in that state, since anything
   * with real commits could be someone's work-in-progress and stays admin-only.
   * Its tree is the provenance proof. `baseTree` is the initial commit's tree
   * when there are exactly two: the head's only parent is the second commit,
   * and that one is the root (no parents) (#374).
   */
  async function repoCommits(appId: string): Promise<{ untouched: boolean; headSha: string | null; initialTree: string | null; baseTree: string | null; count: number | null }> {
    try {
      const r = await gh.api(`/repos/${org}/${appId}/commits?per_page=2`);
      const list = r && r.ok && Array.isArray(r.data)
        ? r.data as { sha?: unknown; parents?: { sha?: unknown }[]; commit?: { tree?: { sha?: unknown } } }[]
        : null;
      if (!list) return { untouched: false, headSha: null, initialTree: null, baseTree: null, count: null };
      const head = list[0];
      const headSha = typeof head?.sha === "string" ? head.sha : null;
      const untouched = list.length === 1;
      const tree = untouched ? head?.commit?.tree?.sha : undefined;
      const root = list[1];
      const base = list.length === 2 && head?.parents?.length === 1 && head.parents[0]?.sha === root?.sha
        && Array.isArray(root?.parents) && root.parents.length === 0 ? root.commit?.tree?.sha : undefined;
      return { untouched, headSha, initialTree: typeof tree === "string" ? tree : null, baseTree: typeof base === "string" ? base : null, count: list.length };
    } catch {
      return { untouched: false, headSha: null, initialTree: null, baseTree: null, count: null };
    }
  }

  /**
   * #374: a repo whose only commit beyond the scaffold is this platform's own
   * placeholder commit, left by an attempt whose /v1/provision failed before
   * any app record was written. Proven by the caller's own receipt: the
   * platform classified it `provision_incomplete` (INTERNAL_TOKEN only) and
   * recorded that exact commit in the same server-authenticated update. Returns
   * the initial commit's tree (the provenance proof), or null.
   */
  async function platformPlaceholderOnly(appId: string, token: string, commits: Awaited<ReturnType<typeof repoCommits>>): Promise<string | null> {
    if (commits.count !== 2 || !commits.headSha || !commits.baseTree) return null;
    const receipt = await readProvisionOperation(appId, token);
    if (!receipt || receipt.status !== "failed" || receipt.failureCode !== "provision_incomplete") return null;
    return receipt.result?.placeholderCommit === commits.headSha ? commits.baseTree : null;
  }

  /**
   * #369: the tree GitHub actually copied into a new repo — its single initial
   * commit's. The template-generate API takes no ref and returns no revision,
   * and it fills the repo asynchronously, so poll a bounded number of times
   * while the repo is still empty or unreadable. Null when it cannot be read,
   * or when the repo already holds more than the copy (nothing to prove).
   */
  async function copiedTree(appId: string, attempts = COPY_TREE_ATTEMPTS, delayMs = COPY_TREE_RETRY_MS): Promise<string | null> {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const commits = await repoCommits(appId);
      if (commits.count !== null && commits.count > 1) return null;
      if (commits.count === 1 && commits.initialTree) return commits.initialTree;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
    return null;
  }

  /** A template commit and its tree, or null when GitHub cannot show it. */
  async function templateCommit(repoName: string, ref: string): Promise<{ sha: string; tree: string | null } | null> {
    try {
      const r = await gh.api(`/repos/${org}/${repoName}/commits/${ref}`);
      const data = r && r.ok ? r.data as { sha?: unknown; commit?: { tree?: { sha?: unknown } } } | undefined : undefined;
      const sha = data?.sha;
      if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
      const tree = data?.commit?.tree?.sha;
      return { sha, tree: typeof tree === "string" ? tree : null };
    } catch {
      return null;
    }
  }

  /**
   * #178: the exact template revision GitHub copies. The template-generate API
   * does not return it, so read the template's branch head right before the
   * copy. Best-effort: an unresolved revision is recorded as unknown, never
   * invented.
   */
  async function resolveTemplateRev(repoName: string, ref: string): Promise<string | null> {
    return (await templateCommit(repoName, ref))?.sha ?? null;
  }

  async function operationRequest(
    path: string,
    token: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; data: Partial<ProvisionOperationReceipt> & { error?: string }; retryAfter?: string }> {
    try {
      const res = await env.API.fetch(`${apiBase}/v1/provision-operations${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
      });
      const raw = await res.text();
      let data: Partial<ProvisionOperationReceipt> & { error?: string };
      try { data = raw ? JSON.parse(raw) as typeof data : {}; } catch { data = { error: raw || `HTTP ${res.status}` }; }
      if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
      const retryAfter = res.headers?.get?.("Retry-After") ?? null;
      return { ok: res.ok, status: res.status, data, ...(retryAfter ? { retryAfter } : {}) };
    } catch (e) {
      return { ok: false, status: 0, data: { error: e instanceof Error ? e.message : "unknown error" } };
    }
  }

  /** Acquire before GitHub work; pending retries join rather than duplicate it (#358). */
  async function beginProvisionOperation(appId: string, token: string, intent: Record<string, unknown>, bootstrapIntent: Record<string, unknown>): Promise<{ receipt?: ProvisionOperationReceipt; error?: string; status?: number; retryAfter?: string }> {
    const started = await operationRequest("", token, { method: "POST", body: JSON.stringify({ appId, intent, bootstrapIntent }) });
    if (!started.ok || typeof started.data.receipt !== "string" || started.data.status === undefined || !Array.isArray(started.data.steps)) {
      // #374: keep the refusal's status (403 owner, 409 intent/legacy, 429 quota) so the caller can tell it from an outage.
      return {
        error: started.data.error ?? "provisioning receipt service returned an invalid response",
        ...(started.status ? { status: started.status } : {}),
        ...(started.retryAfter ? { retryAfter: started.retryAfter } : {}),
      };
    }
    return { receipt: started.data as ProvisionOperationReceipt };
  }

  async function updateProvisionOperation(
    appId: string,
    token: string,
    body: { attemptId: string; status?: ProvisionOperationStatus; steps?: ProvisionStep[]; result?: Record<string, unknown>; failureCode?: ProvisionFailureCode },
  ): Promise<void> {
    // A failure classification is the platform's word, not the session's: it
    // travels with INTERNAL_TOKEN, and without one it is simply not recorded.
    const { failureCode, ...rest } = body;
    const classified = failureCode && env.INTERNAL_TOKEN ? { ...rest, failureCode } : rest;
    const updated = await operationRequest(`/${encodeURIComponent(appId)}`, token, {
      method: "PATCH",
      body: JSON.stringify(classified),
      ...("failureCode" in classified ? { headers: { "X-Internal-Token": env.INTERNAL_TOKEN! } } : {}),
    });
    // A network hiccup leaves the durable lease intact and must not trigger a
    // duplicate bootstrap. A 409 is different: another attempt owns the lease,
    // so this worker must stop before doing more remote work.
    if (updated.status === 409) throw new Error(updated.data.error ?? "provisioning attempt is stale");
  }

  async function readProvisionOperation(appId: string, token: string): Promise<ProvisionOperationReceipt | null> {
    const response = await operationRequest(`/${encodeURIComponent(appId)}`, token);
    if (!response.ok || typeof response.data.receipt !== "string" || response.data.status === undefined || !Array.isArray(response.data.steps)) return null;
    return response.data as ProvisionOperationReceipt;
  }

  function formatProvisionOperation(receipt: ProvisionOperationReceipt): string {
    return [
      `Provisioning status: ${receipt.status}`,
      `Receipt: ${receipt.receipt}`,
      `App: ${receipt.appId}`,
      receipt.status === "legacy_unreconciled"
        ? "Reconciliation: legacy receipt has no verified intent and is read-only; use a different app id or contact platform support."
        : "",
      formatSteps(receipt.steps),
    ].filter(Boolean).join("\n");
  }

  /** The exact request semantics bound into a durable receipt (never its receipt tokens). */
  function provisionRequestIntent(appId: string, opts?: ProvisionOpts): Record<string, unknown> {
    const request: Record<string, unknown> = {
      appId,
      repoOwner: org,
      repoName: appId,
      skipCompliance: opts?.skipCompliance ?? true,
    };
    if (opts?.template) request.template = opts.template;
    if (opts?.templateRev) request.templateRev = opts.templateRev;
    if (opts?.allowUnapprovedTemplate === true) request.allowUnapprovedTemplate = true;
    return request;
  }

  /** Call /v1/provision and format the step results. */
  async function provisionDetailed(appId: string, token: string, opts?: ProvisionOpts): Promise<{ ok: boolean; status: number; data: ProvisionResult; text: string }> {
    try {
      const res = await env.API.fetch(`${apiBase}/v1/provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...provisionRequestIntent(appId, opts),
          ...(opts?.receipt && opts?.attemptId ? { provisionReceipt: opts.receipt, provisionAttemptId: opts.attemptId } : {}),
        }),
      });
      let data: ProvisionResult;
      if (typeof res.text === "function") {
        const raw = await res.text();
        try {
          data = raw ? JSON.parse(raw) as ProvisionResult : {};
        } catch {
          data = { error: raw || `HTTP ${res.status}` };
        }
      } else {
        data = (await res.json()) as ProvisionResult;
      }
      if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
      const body = formatSteps(data.steps);
      return {
        ok: res.ok && data.success !== false,
        status: res.status,
        data,
        text: [
          data.error ? `! error: ${data.error}` : "",
          body,
        ].filter(Boolean).join("\n"),
      };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        data: {},
        text: `! provision error: ${e instanceof Error ? e.message : 'unknown'}`,
      };
    }
  }

  async function provision(appId: string, token: string, opts?: ProvisionOpts): Promise<string> {
    return (await provisionDetailed(appId, token, opts)).text;
  }

  /** Text files in the app repo that still contain the template's APPNAME placeholder. */
  async function filesWithPlaceholder(appId: string): Promise<{ files: Record<string, string>; error?: string }> {
    const pulled = await gh.pullText(appId);
    if (!pulled.ok || !pulled.files) return { files: {}, error: pulled.error ?? "could not read the repo" };
    if (pulled.truncated) return { files: {}, error: "the repo is too large to check every file" };
    return { files: Object.fromEntries(Object.entries(pulled.files).filter(([, content]) => content.includes("APPNAME"))) };
  }

  /**
   * Replace APPNAME in EVERY text file of the new repo, as `pas create` does, then
   * re-read the repo and fail if any survived (#205). A hard-coded file list went
   * stale the moment the template grew a placeholder elsewhere (compliance.yml).
   */
  async function patchTemplatePlaceholders(appId: string): Promise<{ ok: boolean; lines: string[]; commitSha?: string }> {
    const found = await filesWithPlaceholder(appId);
    if (found.error) return { ok: false, lines: [`! Template placeholders: ${found.error}`] };
    const files = Object.entries(found.files).map(([path, content]) => ({ path, content: content.replaceAll("APPNAME", appId) }));
    if (files.length === 0) return { ok: true, lines: ["~ Template placeholders: no APPNAME placeholders found"] };

    const res = await gh.pushFiles(appId, files, `chore: configure ${appId} template`, { initIfEmpty: false });
    if (!res.ok) return { ok: false, lines: [`! Template placeholders: ${res.error ?? "failed to commit replacements"}`] };
    const lines = [`+ Template placeholders: replaced APPNAME in ${files.length} file(s)${res.commitSha ? ` (${res.commitSha.slice(0, 7)})` : ""}`];

    const after = await filesWithPlaceholder(appId);
    const remaining = Object.keys(after.files);
    if (after.error) return { ok: false, lines: [...lines, `! Template placeholders: could not verify the replacement (${after.error})`] };
    if (remaining.length > 0) {
      return { ok: false, lines: [...lines, `! Template placeholders: APPNAME is still present in ${remaining.join(", ")} — re-run provision_pas_app to re-patch`] };
    }
    return { ok: true, lines, ...(res.commitSha ? { commitSha: res.commitSha } : {}) };
  }

  async function verifyProvision(appId: string, provisionResult: ProvisionResult): Promise<{ lines: string[]; host: ProvisionStep }> {
    const lines: string[] = [];
    let host: ProvisionStep = { name: "host", status: "pending", detail: "host verification has not run" };
    lines.push(await gh.repoExists(appId)
      ? `+ Verify repo: https://github.com/${org}/${appId} exists`
      : `! Verify repo: https://github.com/${org}/${appId} was not reachable`);

    if (provisionResult.success === true) {
      lines.push("+ Verify provision: backend reported success");
    } else if (provisionResult.success === false) {
      lines.push("! Verify provision: backend reported failure");
    } else {
      lines.push("~ Verify provision: backend did not return a success flag");
    }

    const runs = await gh.getDeployStatus(appId, 1).catch(() => ({ ok: false, status: 0, data: {} as unknown }));
    if (runs.ok) {
      const latest = ((runs.data as { workflow_runs?: { name: string; status: string; conclusion: string | null; updated_at: string }[] }).workflow_runs ?? [])[0];
      if (latest) {
        lines.push(`~ Verify deploy: ${latest.name} is ${latest.conclusion ?? latest.status} (${latest.updated_at})`);
      } else {
        lines.push("~ Verify deploy: no GitHub Actions run yet; first deploy may start after the template commit");
      }
    } else {
      lines.push("~ Verify deploy: GitHub Actions status unavailable");
    }

    const appUrl = provisionResult.appUrl ?? `https://${appId}.proappstore.online`;
    try {
      const res = await env.HOST.fetch(appUrl, { method: "HEAD" });
      host = {
        name: "host",
        status: res.ok ? "ok" : "pending",
        detail: res.ok ? `${appUrl} responds ${res.status}` : `${appUrl} returned ${res.status}; deploy may still be pending`,
      };
      lines.push(res.ok
        ? `+ Verify host: ${appUrl} responds ${res.status}`
        : `~ Verify host: ${appUrl} returned ${res.status}; deploy may still be pending`);
    } catch (e) {
      const detail = `${e instanceof Error ? e.message : "unreachable"}; deploy may still be pending`;
      host = { name: "host", status: "pending", detail };
      lines.push(`~ Verify host: ${detail}`);
    }

    return { lines, host };
  }

  // ── Plan ────────────────────────────────────────────────────

  /**
   * Decide what provisioning `input` would do. Read-only: GitHub and backend
   * GETs only — no repository, app, infrastructure, receipt or access change.
   * Input errors (bad id, repository URL, template or revision format) return
   * `{ ok: false }`; everything that depends on live state is a blocker.
   */
  async function planProvision(user: WorkflowUser, input: PlanInput, opts: PlanOptions): Promise<PlanOutcome> {
    const { appId } = input;
    if (typeof appId !== "string" || !APP_ID_RE.test(appId) || appId.length > 57 || appId.startsWith("about-")) return { ok: false, error: "Invalid app ID" };
    const url = `https://github.com/${org}/${appId}`;
    const isAdmin = user.roles.includes("admin");
    const consoleMode = opts.mode === "console";
    if (consoleMode) {
      if (input.repoUrl !== url) return { ok: false, error: `repoUrl must be ${url}` };
      if (typeof input.template !== "string" || !input.template.trim()) return { ok: false, error: "template is required" };
    }
    const requested = input.templateRev;
    if (requested !== undefined && (typeof requested !== "string" || !TEMPLATE_REV_RE.test(requested))) {
      return { ok: false, error: "templateRev must be a git object id (7–40 hex chars)" };
    }

    // #178: selection contract — before any GitHub call. No override on the Console path.
    const selection = selectTemplate(input.template, { allowUnapproved: !consoleMode && opts.allowUnapprovedTemplate === true && isAdmin });
    if (!selection.ok) {
      return { ok: false, error: `${selection.reason}${opts.allowUnapprovedTemplate && !isAdmin ? " allow_unapproved_template requires a platform admin session." : ""}` };
    }
    const templateId = selection.template?.id ?? input.template!;
    const templateRepo = selection.template ? selection.template.repo.split("/")[1]! : input.template!;
    const templateRef = selection.template?.ref ?? "main";
    const reviewedCommit = selection.template?.release.source_commit ?? null;
    const warnings = [...selection.warnings];
    const blockers: PlanBlocker[] = [];

    const plan: ProvisionPlan = {
      version: 1,
      appId,
      name: input.name,
      description: input.description,
      action: "refused",
      repository: { owner: org, name: appId, url, exists: null },
      appRecord: "unknown",
      template: {
        id: templateId,
        repo: `${org}/${templateRepo}`,
        ref: templateRef,
        status: selection.template?.status ?? "unapproved",
        reviewedCommit,
        requestedRevision: requested ?? null,
        revision: null,
        revisionSource: "unknown",
        revisionTree: null,
      },
      changes: [],
      compliance: { required: !(opts.skipCompliance === true && isAdmin) },
      blockers,
      warnings,
    };

    // Repository state. The Console path reads the repo itself (visibility is
    // reported, never changed); a GitHub outage is a blocker, not "absent".
    let exists: boolean | null;
    let visibility: boolean | null = null;
    if (consoleMode) {
      const r = await gh.api(`/repos/${org}/${appId}`).catch(() => null);
      if (r && r.status === 404) exists = false;
      else if (r && r.ok && (r.data as { id?: unknown } | null)?.id) {
        exists = true;
        visibility = (r.data as { private?: unknown }).private === true;
      } else exists = null;
    } else {
      exists = await gh.repoExists(appId);
    }
    plan.repository.exists = exists;

    if (exists === null) {
      blockers.push({ code: "repository_unavailable", message: `${org}/${appId} could not be read from GitHub; retry the preview.` });
      return { ok: true, plan };
    }

    if (!exists) {
      plan.action = "create";
      plan.appRecord = "none";
      plan.repository.private = opts.privateRepo !== false;
      const head = await templateCommit(templateRepo, templateRef);
      if (head) {
        plan.template.revision = head.sha;
        plan.template.revisionSource = "template_head";
        plan.template.revisionTree = head.tree;
        if (reviewedCommit && head.sha !== reviewedCommit) {
          warnings.push(`template head ${head.sha.slice(0, 7)} is not the reviewed commit ${reviewedCommit.slice(0, 7)}; GitHub copies the head`);
        }
      }
      if (requested) {
        if (!head) blockers.push({ code: "revision_unresolved", message: `the head of ${org}/${templateRepo}@${templateRef} could not be read, so revision ${requested} cannot be proven.` });
        else if (!head.sha.startsWith(requested)) {
          blockers.push({ code: "revision_not_current", message: `GitHub copies the template's current head ${head.sha.slice(0, 12)}; the requested revision ${requested} cannot be honoured.` });
        }
      } else if (!head && consoleMode) {
        blockers.push({ code: "revision_unresolved", message: `the head of ${org}/${templateRepo}@${templateRef} could not be read, so the copied revision cannot be recorded.` });
      }
    } else {
      if (!consoleMode && opts.reuseExistingRepo === false) {
        blockers.push({ code: "repository_exists", message: `${org}/${appId} already exists and reuse_existing_repo is false.` });
        return { ok: true, plan };
      }
      let commits: Awaited<ReturnType<typeof repoCommits>> | null = null;
      let recoveredTree: string | null = null;
      if (await ownsApp(appId, user)) {
        plan.action = "reuse_owned";
        plan.appRecord = "owner";
      } else if (isAdmin) {
        // Admin support may operate the app; whose record it is is a separate fact.
        plan.action = "reuse_admin";
        plan.appRecord = await appRecordState(appId, user.token);
      } else {
        // #144: "not owned by this account" is two different situations.
        // Someone else's app stays refused. A repo with NO app record at all is
        // a half-provisioned orphan, adoptable only as the untouched scaffold.
        // Receipt steps are progress evidence, never proof of who owns a repo.
        const state = await appRecordState(appId, user.token);
        plan.appRecord = state;
        if (state === "owner") {
          // #374: the ownership read fails closed on any error; the app record
          // itself says this caller owns it, so it is theirs to reuse.
          plan.action = "reuse_owned";
        } else if (state === "other") {
          blockers.push({ code: "owned_by_another_account", message: `${org}/${appId} already exists and its PAS app record is owned by another account.` });
          return { ok: true, plan };
        } else if (state === "unknown") {
          blockers.push({ code: "app_record_unavailable", message: `${org}/${appId} already exists and its PAS app record could not be checked.` });
          return { ok: true, plan };
        } else {
          commits = await repoCommits(appId);
          if (!commits.untouched) {
            recoveredTree = await platformPlaceholderOnly(appId, user.token, commits);
            if (!recoveredTree) {
              blockers.push({ code: "repository_edited", message: `${org}/${appId} already exists with no PAS app record, but it has commits beyond the template scaffold.` });
              return { ok: true, plan };
            }
            warnings.push(`${org}/${appId}'s only commit beyond the scaffold is this platform's placeholder commit from your earlier attempt, which stopped before the app record was written; it is adopted as is`);
          }
          plan.action = "adopt_untouched";
        }
      }

      // The caller may act on this repo: report what it is, change none of it.
      commits ??= await repoCommits(appId);
      plan.repository.headSha = commits.headSha;
      plan.repository.untouchedScaffold = commits.untouched;
      if (consoleMode) plan.repository.private = visibility;

      // Provenance: only a scaffold still at its initial commit can be proven,
      // by its tree. A requested revision is checked against that proof alone.
      const candidates = requested
        ? [requested]
        : [templateRef, ...(reviewedCommit ? [reviewedCommit] : [])];
      let proven: string | null = null;
      const scaffoldTree = commits.initialTree ?? recoveredTree;
      if (scaffoldTree) {
        for (const ref of candidates) {
          const commit = await templateCommit(templateRepo, ref);
          if (commit?.tree && commit.tree === scaffoldTree) { proven = commit.sha; plan.template.revisionTree = commit.tree; break; }
        }
      }
      if (proven) {
        plan.template.revision = proven;
        plan.template.revisionSource = "scaffold_tree_match";
      } else if (requested) {
        blockers.push({ code: "revision_mismatch", message: `${org}/${appId} is not provably a copy of ${templateId}@${requested}; the requested revision cannot be honoured.` });
      } else if (consoleMode && plan.action === "adopt_untouched") {
        blockers.push({ code: "revision_unverified", message: `the scaffold in ${org}/${appId} does not match a known ${templateId} commit, so its copied revision cannot be verified.` });
      }
    }

    // Someone else's or an edited repo: no details past existence (returned above).
    plan.changes = planChanges(plan);
    return { ok: true, plan };
  }

  function planChanges(plan: ProvisionPlan): string[] {
    const repo = `${org}/${plan.appId}`;
    const rev = plan.template.revision ? `@${plan.template.revision.slice(0, 12)}` : " (revision unknown)";
    const changes: string[] = [];
    if (plan.action === "create") {
      changes.push(`create ${plan.repository.private ? "private" : "public"} GitHub repository ${repo} from ${plan.template.repo}${rev}`);
    } else if (plan.action === "adopt_untouched") {
      changes.push(`adopt the existing untouched scaffold ${repo} (no PAS app record yet); its visibility is not changed`);
    } else {
      changes.push(`reuse the existing repository ${repo}; its visibility is not changed`);
    }
    if (plan.action === "create" || plan.action === "adopt_untouched") changes.push("commit the APPNAME placeholder replacements to main");
    else changes.push("commit APPNAME placeholder replacements to main, if any remain");
    changes.push(plan.compliance.required
      ? "run the required compliance checks; a failure stops before any infrastructure"
      : "skip compliance (platform admin request)");
    changes.push(`provision the R2 route, D1 database pas-data-${plan.appId}, data worker and PAS app record (template ${plan.template.id}${rev})`);
    changes.push("verify the repository, provisioning result, deploy status and host");
    return changes;
  }

  // ── Execute ─────────────────────────────────────────────────

  /**
   * Perform `plan` under a durable receipt. The plan must have no blockers.
   * Only the receipt acquisition precedes GitHub work, so a retry joins rather
   * than starting a second bootstrap (#358).
   */
  async function executePlan(
    user: WorkflowUser,
    plan: ProvisionPlan,
    opts: { privateRepo: boolean; reuseExistingRepo: boolean; skipCompliance: boolean; verify: boolean; allowUnapprovedTemplate: boolean },
  ): Promise<ExecuteOutcome> {
    if (plan.blockers.length > 0 || plan.action === "refused") return { kind: "error", error: `Error: ${plan.blockers[0]?.message ?? "the provisioning plan is refused"}` };
    const appId = plan.appId;
    const templateRepoName = plan.template.repo.split("/")[1]!;
    const templateRev = plan.template.revision;
    const provisionOptions: ProvisionOpts = {
      skipCompliance: opts.skipCompliance,
      template: plan.template.id,
      ...(templateRev ? { templateRev } : {}),
      ...(opts.allowUnapprovedTemplate && plan.template.status === "unapproved" ? { allowUnapprovedTemplate: true } : {}),
    };
    const bootstrapIntent = {
      templateId: plan.template.id,
      templateRepo: templateRepoName,
      templateRef: plan.template.ref,
      name: plan.name,
      description: plan.description,
      privateRepo: opts.privateRepo,
      reuseExistingRepo: opts.reuseExistingRepo,
      skipCompliance: opts.skipCompliance,
      verify: opts.verify,
      allowUnapprovedTemplate: opts.allowUnapprovedTemplate,
    };
    const acquired = await beginProvisionOperation(appId, user.token, provisionRequestIntent(appId, provisionOptions), bootstrapIntent);
    if (!acquired.receipt) {
      return {
        kind: "error",
        error: `Error: could not start durable provisioning receipt for ${appId}: ${acquired.error}`,
        ...(acquired.status ? { status: acquired.status } : {}),
        ...(acquired.retryAfter ? { retryAfter: acquired.retryAfter } : {}),
      };
    }
    const receipt = acquired.receipt;
    if (receipt.joined) return { kind: "joined", receipt };
    if (!receipt.attemptId) return { kind: "error", error: `Error: provisioning receipt for ${appId} did not grant an active attempt lease.`, receipt };
    const recordEvidence = async (steps: ProvisionStep[], status?: ProvisionOperationStatus, result?: Record<string, unknown>, failureCode?: ProvisionFailureCode) => {
      await updateProvisionOperation(appId, user.token, {
        attemptId: receipt.attemptId!, steps,
        ...(status ? { status } : {}), ...(result ? { result } : {}), ...(failureCode ? { failureCode } : {}),
      });
    };
    const fail = async (detail: string, error: string): Promise<ExecuteOutcome> => {
      await recordEvidence([{ name: "bootstrap", status: "fail", detail }], "failed", { error: detail });
      return { kind: "error", error, receipt };
    };

    const lines: string[] = [];
    let repoAction: "created" | "reused" | "adopted";
    if (plan.action === "create") {
      let createRes: Awaited<ReturnType<GitHub["createRepoFromTemplate"]>>;
      try {
        createRes = await gh.createRepoFromTemplate(appId, { template: templateRepoName, description: plan.description, private: opts.privateRepo });
      } catch (e) {
        const detail = `GitHub template creation request failed: ${e instanceof Error ? e.message : "unknown error"}`;
        return fail(detail, `Error creating repo: ${detail}`);
      }
      if (createRes.ok) {
        repoAction = "created";
        lines.push(`+ GitHub repo: created ${org}/${appId} from ${org}/${templateRepoName}`);
        for (const w of plan.warnings) lines.push(`! template: ${w}`);
        await recordEvidence([{ name: "repo_created", status: "ok", detail: `${org}/${appId} created from ${org}/${templateRepoName}` }]);
        await new Promise((r) => setTimeout(r, 4000));
        // #369: GitHub copies whatever the template head is at this moment, so
        // the planned revision is claimed only if the copy is provably it.
        // Otherwise stop before any further write; the repo is kept as created.
        if (templateRev) {
          const copied = await copiedTree(appId);
          const expected = plan.template.revisionTree;
          if (!copied || !expected || copied !== expected) {
            const code = copied && expected ? "revision_mismatch" : "revision_unverified";
            const what = code === "revision_mismatch"
              ? `its initial tree ${copied!.slice(0, 12)} is not the tree ${expected!.slice(0, 12)} of ${plan.template.id}@${templateRev.slice(0, 12)} (the template changed during the copy)`
              : `its initial tree could not be compared with ${plan.template.id}@${templateRev.slice(0, 12)}`;
            const detail = `${code}: ${org}/${appId} was created, but ${what}; nothing further was changed`;
            // The classification (not the step text) is what lets a fresh plan
            // retry this receipt under a different revision.
            await recordEvidence([{ name: "template_revision", status: "fail", detail }], "failed", {
              error: detail, code, partial: true, repositoryCreated: true, repository: `https://github.com/${org}/${appId}`,
            }, code === "revision_mismatch" ? "template_copy_mismatch" : "template_copy_unverified");
            return {
              kind: "error",
              receipt,
              error: `Error: ${detail}. The repository is kept as created. Preview again: a fresh plan can adopt it at the revision it actually holds.`,
            };
          }
          lines.push(`+ Template copy: ${org}/${appId}'s initial tree matches ${plan.template.id}@${templateRev.slice(0, 12)}`);
        }
      } else if (createRes.status === 422) {
        // The repo appeared after the plan was made: whose it is was never
        // checked, so nothing proceeds on it.
        return fail("repository appeared after the provisioning plan was made", `Error: ${org}/${appId} was created by someone else after the provisioning check. Re-run to re-check it.`);
      } else if (createRes.status === 404) {
        return fail(
          `template repo ${org}/${templateRepoName} is not available as a GitHub template`,
          `Error creating repo: GitHub returned 404 from the template-generate API. The source template repo "${org}/${templateRepoName}" must exist and be marked as a GitHub template.`,
        );
      } else {
        return fail(`GitHub template creation failed: ${JSON.stringify(createRes.data)}`, `Error creating repo: ${JSON.stringify(createRes.data)}`);
      }
    } else if (plan.action === "adopt_untouched") {
      repoAction = "adopted";
      lines.push(`~ GitHub repo: ${org}/${appId} already existed with no PAS app record (untouched template scaffold) — adopting it (#144)`);
      await recordEvidence([{ name: "repo_created", status: "skip", detail: `${org}/${appId} is an untouched template orphan adopted by this operation` }]);
    } else {
      repoAction = "reused";
      lines.push(`~ GitHub repo: ${org}/${appId} already exists`);
      await recordEvidence([{ name: "repo_created", status: "skip", detail: `${org}/${appId} already existed and is authorized for reuse` }]);
    }

    let placeholders: Awaited<ReturnType<typeof patchTemplatePlaceholders>>;
    try {
      placeholders = await patchTemplatePlaceholders(appId);
    } catch (e) {
      const detail = `template configuration failed: ${e instanceof Error ? e.message : "unknown error"}`;
      return fail(detail, `Error configuring repo: ${detail}`);
    }
    lines.push(...placeholders.lines);
    await recordEvidence([{ name: "config_committed", status: placeholders.ok ? "ok" : "fail", detail: placeholders.lines.join("; ") }]);

    // #178/#367: record only a proven revision — the head read just before a
    // copy, or a scaffold tree match. Otherwise it is recorded as unknown.
    lines.push(templateRev
      ? `+ Template revision: ${plan.template.id}@${templateRev.slice(0, 12)}${plan.template.revisionSource === "scaffold_tree_match" ? " (proven by the scaffold's tree)" : ""}`
      : repoAction === "created"
        ? `~ Template revision: could not resolve ${plan.template.repo}@${plan.template.ref} — recorded as unknown`
        : `~ Template revision: ${org}/${appId} is not provably an unmodified copy of a known ${plan.template.id} commit — recorded as unknown`);
    const prov = await provisionDetailed(appId, user.token, { ...provisionOptions, receipt: receipt.receipt, attemptId: receipt.attemptId });
    if (prov.text) lines.push(prov.text);
    await recordEvidence((prov.data.steps ?? []).map((step) => ({
      name: step.name === "route" ? "r2_deploy" : step.name,
      status: step.status,
      detail: step.detail,
    })));

    if (opts.verify) {
      try {
        const verification = await verifyProvision(appId, prov.data);
        lines.push(...verification.lines);
        await recordEvidence([verification.host]);
      } catch (e) {
        const detail = `verification error: ${e instanceof Error ? e.message : "unknown error"}`;
        lines.push(`~ Verify host: ${detail}`);
        await recordEvidence([{ name: "host", status: "pending", detail }]);
      }
    } else {
      await recordEvidence([{ name: "host", status: "skip", detail: "host verification was not requested" }]);
    }

    const succeeded = prov.ok && placeholders.ok;
    // #374: /v1/provision failed (compliance 412, a transient error…) before
    // writing any app record, on a repo whose only change is this platform's
    // placeholder commit. Classify it, with that commit, so the next plan can
    // adopt the repo instead of refusing it as edited. An adopted repo that had
    // no placeholders left keeps the commit it was adopted at.
    const recordWritten = (prov.data.steps ?? []).some((step) => step.name === "record_app" && step.status === "ok");
    const placeholderCommit = placeholders.commitSha
      ?? (plan.action === "adopt_untouched" && plan.repository.untouchedScaffold === false ? plan.repository.headSha ?? undefined : undefined);
    const incomplete = !prov.ok && placeholders.ok && !recordWritten && repoAction !== "reused" && placeholderCommit !== undefined;
    await recordEvidence([], succeeded ? "completed" : "failed", {
      success: succeeded,
      appUrl: prov.data.appUrl ?? `https://${appId}.proappstore.online`,
      dataWorkerUrl: prov.data.dataWorkerUrl ?? `https://data-${appId}.proappstore.online`,
      ...(incomplete ? { placeholderCommit } : {}),
    }, incomplete ? "provision_incomplete" : undefined);
    return { kind: "done", receipt, repoAction, lines, provision: prov.data, succeeded };
  }

  /** The Console's fixed execution options: normal compliance, no override, private new repos, verification on. */
  const CONSOLE_EXECUTION = { privateRepo: true, reuseExistingRepo: true, skipCompliance: false, verify: true, allowUnapprovedTemplate: false } as const;

  /**
   * #367: execute a reviewed plan only if re-planning now yields the same bound
   * facts. A changed plan returns the fresh one and changes nothing.
   */
  async function confirmPlan(user: WorkflowUser, reviewed: ProvisionPlan): Promise<ConfirmOutcome> {
    const input: PlanInput = {
      appId: reviewed.appId,
      name: reviewed.name,
      description: reviewed.description,
      template: reviewed.template.id,
      repoUrl: reviewed.repository.url,
      ...(reviewed.template.requestedRevision ? { templateRev: reviewed.template.requestedRevision } : {}),
    };
    const fresh = await planProvision(user, input, { mode: "console", privateRepo: true });
    if (!fresh.ok) return { kind: "invalid", error: fresh.error };
    if (planBinding(fresh.plan) !== planBinding(reviewed)) return { kind: "plan_changed", plan: fresh.plan };
    if (fresh.plan.blockers.length > 0) return { kind: "plan_blocked", plan: fresh.plan };
    return executePlan(user, fresh.plan, CONSOLE_EXECUTION);
  }

  return {
    ownsApp,
    appRecordState,
    resolveTemplateRev,
    templateCommit,
    copiedTree,
    operationRequest,
    readProvisionOperation,
    formatProvisionOperation,
    provision,
    provisionDetailed,
    patchTemplatePlaceholders,
    verifyProvision,
    planProvision,
    executePlan,
    confirmPlan,
  };
}

// ── Internal HTTP surface (API worker → MCP service binding) ───

export interface InternalProvisioningEnv extends WorkflowEnv {
  GITHUB_TOKEN: string;
  INTERNAL_TOKEN?: string;
  SESSION_SIGNING_KEY?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/**
 * `POST /internal/provisioning/plan` `{ input }` → `{ plan }` and
 * `POST /internal/provisioning/execute` `{ plan }` → the execution outcome.
 * Reachable only with the platform INTERNAL_TOKEN (the API worker's service
 * binding); the caller is the PAS session in `X-PAS-Session`, verified here
 * again. Returns null for any other path.
 */
export async function handleInternalProvisioning(
  request: Request,
  env: InternalProvisioningEnv,
  makeGh: (token: string, org: string) => GitHub = makeGitHub,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (pathname !== "/internal/provisioning/plan" && pathname !== "/internal/provisioning/execute") return null;
  if (!env.INTERNAL_TOKEN || request.headers.get("X-Internal-Token") !== env.INTERNAL_TOKEN) return new Response("not found", { status: 404 });
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const session = request.headers.get("X-PAS-Session");
  const claims = session && env.SESSION_SIGNING_KEY ? await verifySession(session, env.SESSION_SIGNING_KEY) : null;
  if (!session || !claims) return json({ error: "a valid PAS session is required" }, 401);
  const user: WorkflowUser = { userId: claims.uid, token: session, roles: claims.roles ?? [] };
  const body = await request.json().catch(() => null) as { input?: unknown; plan?: unknown } | null;
  const workflow = createProvisioningWorkflow(env, makeGh(env.GITHUB_TOKEN, env.GITHUB_ORG));

  if (pathname === "/internal/provisioning/plan") {
    const input = body?.input as PlanInput | undefined;
    if (!input || typeof input !== "object" || typeof input.name !== "string" || typeof input.description !== "string") {
      return json({ error: "input with appId, name, description, template and repoUrl is required" }, 400);
    }
    const planned = await workflow.planProvision(user, input, { mode: "console", privateRepo: true });
    return planned.ok ? json({ plan: planned.plan }) : json({ error: planned.error }, 400);
  }

  const plan = body?.plan as ProvisionPlan | undefined;
  if (!plan || typeof plan !== "object" || plan.version !== 1 || typeof plan.appId !== "string"
    || !plan.repository || !plan.template || !Array.isArray(plan.blockers)) {
    return json({ error: "a reviewed plan is required" }, 400);
  }
  const outcome = await workflow.confirmPlan(user, plan);
  switch (outcome.kind) {
    case "invalid": return json({ error: outcome.error }, 400);
    case "plan_changed": return json({ error: "plan_changed", plan: outcome.plan }, 409);
    case "plan_blocked": return json({ error: "plan_blocked", plan: outcome.plan }, 422);
    case "joined": return json({ joined: true, receipt: outcome.receipt.receipt, status: outcome.receipt.status });
    case "error":
      if (outcome.receipt) return json({ joined: false, receipt: outcome.receipt.receipt, error: outcome.error });
      // #374: a refusal keeps its status; only an outage (or no status) is 503.
      return outcome.status === 403 || outcome.status === 409 || outcome.status === 429
        ? json({ error: outcome.error, ...(outcome.retryAfter ? { retryAfter: outcome.retryAfter } : {}) }, outcome.status)
        : json({ error: outcome.error }, 503);
    case "done":
      return json({ joined: false, receipt: outcome.receipt.receipt, repoAction: outcome.repoAction, succeeded: outcome.succeeded, lines: outcome.lines });
  }
}
