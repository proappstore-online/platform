/**
 * Personal-account backfill tooling (#534 T02, design §9 Phase A).
 *
 * NOT run by any migration and not wired to any route: the deploy lint refuses UPDATE, and a
 * production backfill is a separate reviewed operation (dry run first, compare the report hash with the
 * applied run). Nothing here is executed against production by this milestone.
 *
 * Per distinct owning user it creates one personal account (a deterministic id, so concurrent or
 * repeated runs cannot create two), maps their apps and draft projects to it, and turns each existing
 * app collaborator into an app-scoped GUEST of that personal account with a compatibility grant. It
 * never changes users.id, app ids, URLs, purchases or sessions, and never merges users by email.
 * Anomalies (orphan owners, ambiguous provider subjects, owner mismatches, unknown roles) are
 * QUARANTINED into account_backfill_exceptions and skipped, never guessed.
 *
 * Resumable: users are visited in id order from a cursor; every write is idempotent
 * (INSERT OR IGNORE / `WHERE owner_account_id IS NULL`), so a run interrupted anywhere can be repeated.
 */
import { LEGACY_TEAM_ROLE_TO_APP_ROLE, type LegacyGrantReason } from './contract.js';
import { canonicalJson, newId, sha256Hex } from './operations.js';

export interface BackfillOptions {
  /** Report only. The same plan is computed; nothing is written. */
  dryRun: boolean;
  runId?: string;
  /** Users per call. The report's `cursor` continues where it stopped. */
  limit?: number;
  cursor?: string | null;
  now?: number;
}

interface BackfillException { kind: string; subject: string; detail: Record<string, unknown> }

export interface BackfillReport {
  run_id: string;
  dry_run: boolean;
  cursor: string | null;
  done: boolean;
  users_visited: number;
  personal_accounts: number;
  apps_mapped: number;
  projects_mapped: number;
  guest_memberships: number;
  grants: { total: number; legacy_developer_data_access: number };
  exceptions: BackfillException[];
  /** Identical for a dry run and the run that applies the same state: compare them before applying. */
  plan_hash: string;
}

export async function personalAccountId(userId: string): Promise<{ id: string; slug: string }> {
  const h = await sha256Hex(`pas-personal-account:${userId}`);
  return { id: `acct_p_${h.slice(0, 32)}`, slug: `p-${h.slice(0, 24)}` };
}

const GRANT_REASON: Readonly<Record<string, LegacyGrantReason>> = {
  owner: 'legacy_app_owner',
  developer: 'legacy_developer_data_access',
};

interface OwnerRow { owner: string }

export async function runPersonalBackfill(db: D1Database, opts: BackfillOptions): Promise<BackfillReport> {
  const runId = opts.runId ?? newId('bf');
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const now = opts.now ?? Date.now();
  const cursor = opts.cursor ?? '';

  // Distinct owning users, in id order: app creators and draft-project owners.
  const { results } = await db.prepare(
    `SELECT owner FROM (SELECT creator_id AS owner FROM apps UNION SELECT owner_id AS owner FROM agent_projects)
      WHERE owner > ?1 ORDER BY owner LIMIT ?2`,
  ).bind(cursor, limit + 1).all<OwnerRow>();
  const page = results ?? [];
  const owners = page.slice(0, limit).map((r) => r.owner);
  const done = page.length <= limit;

  const report: BackfillReport = {
    run_id: runId, dry_run: opts.dryRun, cursor: owners.length ? owners[owners.length - 1]! : opts.cursor ?? null, done,
    users_visited: owners.length, personal_accounts: 0, apps_mapped: 0, projects_mapped: 0, guest_memberships: 0,
    grants: { total: 0, legacy_developer_data_access: 0 }, exceptions: [], plan_hash: '',
  };
  const plan: unknown[] = [];

  for (const owner of owners) {
    const mine: BackfillException[] = [];
    const quarantine = (kind: string, subject: string, detail: Record<string, unknown> = {}) => { const e = { kind, subject, detail }; report.exceptions.push(e); mine.push(e); };
    const persist = (): D1PreparedStatement[] => mine.map((e) => db.prepare(`INSERT OR IGNORE INTO account_backfill_exceptions (kind, subject, detail, run_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(e.kind, e.subject, JSON.stringify(e.detail), runId, now));

    const user = await db.prepare('SELECT id, provider, provider_id, credential_app_id FROM users WHERE id = ?').bind(owner).first<{ id: string; provider: string; provider_id: string; credential_app_id: string | null }>();
    if (!user) { quarantine('orphan_owner', owner, { reason: 'no users row' }); if (!opts.dryRun) await db.batch(persist()); continue; }
    const dup = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE provider = ?1 AND provider_id = ?2 AND id <> ?3').bind(user.provider, user.provider_id, user.id).first<{ n: number }>();
    if ((dup?.n ?? 0) > 0) { quarantine('ambiguous_provider_subject', owner, { provider: user.provider }); if (!opts.dryRun) await db.batch(persist()); continue; }

    const { id: acct, slug } = await personalAccountId(owner);
    const apps = (await db.prepare('SELECT id, owner_account_id FROM apps WHERE creator_id = ?').bind(owner).all<{ id: string; owner_account_id: string | null }>()).results ?? [];
    const toMap = apps.filter((a) => a.owner_account_id === null);
    for (const a of apps) {
      if (a.owner_account_id !== null && a.owner_account_id !== acct) quarantine('app_owner_account_mismatch', a.id, { has: a.owner_account_id, expected: acct });
    }

    const projects = (await db.prepare('SELECT slug, owner_account_id FROM agent_projects WHERE owner_id = ?').bind(owner).all<{ slug: string; owner_account_id: string | null }>()).results ?? [];
    const projectsToMap: string[] = [];
    for (const pr of projects) {
      const app = await db.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(pr.slug).first<{ creator_id: string }>();
      if (app && app.creator_id !== owner) { quarantine('project_owner_mismatch', pr.slug, { project_owner: owner, app_creator: app.creator_id }); continue; }
      if (pr.owner_account_id === null) projectsToMap.push(pr.slug);
    }

    const collaborators: { app_id: string; user_id: string; role: string }[] = [];
    for (const a of apps) {
      const rows = (await db.prepare('SELECT user_id, role FROM team_members WHERE app_id = ? AND user_id <> ?').bind(a.id, owner).all<{ user_id: string; role: string }>()).results ?? [];
      for (const r of rows) {
        if (!(r.role in LEGACY_TEAM_ROLE_TO_APP_ROLE)) { quarantine('unknown_team_role', `${a.id}:${r.user_id}`, { role: r.role }); continue; }
        collaborators.push({ app_id: a.id, user_id: r.user_id, role: r.role });
      }
    }
    const guests = new Set(collaborators.map((x) => x.user_id));

    report.personal_accounts += 1;
    report.apps_mapped += toMap.length;
    report.projects_mapped += projectsToMap.length;
    report.guest_memberships += guests.size;
    report.grants.total += collaborators.length;
    report.grants.legacy_developer_data_access += collaborators.filter((x) => x.role === 'developer').length;
    plan.push({ owner, acct, apps: toMap.map((a) => a.id).sort(), projects: projectsToMap.sort(), collaborators: collaborators.map((x) => `${x.app_id}:${x.user_id}:${x.role}`).sort() });
    if (opts.dryRun) continue;

    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT OR IGNORE INTO accounts (id, kind, name, slug, status, personal_user_id, created_by, created_at, updated_at) VALUES (?1, 'personal', 'Personal', ?2, 'provisioning', ?3, ?3, ?4, ?4)`).bind(acct, slug, owner, now),
      db.prepare(`INSERT OR IGNORE INTO account_memberships (account_id, user_id, role, status, generation, created_by, created_at, updated_at) VALUES (?1, ?2, 'owner', 'active', 1, ?2, ?3, ?3)`).bind(acct, owner, now),
      db.prepare(`UPDATE accounts SET status = 'active', authz_version = authz_version + 1, updated_at = ?2 WHERE id = ?1 AND status = 'provisioning'`).bind(acct, now),
      db.prepare(`UPDATE apps SET owner_account_id = ?1 WHERE creator_id = ?2 AND owner_account_id IS NULL`).bind(acct, owner),
      db.prepare(`UPDATE agent_projects SET owner_account_id = ?1 WHERE owner_id = ?2 AND owner_account_id IS NULL AND slug IN (${projectsToMap.map(() => '?').join(',') || "''"})`).bind(acct, owner, ...projectsToMap),
    ];
    for (const g of guests) {
      stmts.push(db.prepare(`INSERT OR IGNORE INTO account_memberships (account_id, user_id, role, status, generation, created_by, created_at, updated_at) VALUES (?1, ?2, 'guest', 'active', 1, ?3, ?4, ?4)`).bind(acct, g, owner, now));
    }
    for (const x of collaborators) {
      const role = LEGACY_TEAM_ROLE_TO_APP_ROLE[x.role]!;
      stmts.push(db.prepare(
        `INSERT OR IGNORE INTO app_access_grants (id, app_id, account_id, user_id, role, extra_permissions, reason, membership_generation, granted_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, 1, ?7, ?8, ?8)`,
      ).bind(newId('grant'), x.app_id, acct, x.user_id, role, GRANT_REASON[x.role] ?? 'legacy_app_collaborator', owner, now));
    }
    stmts.push(db.prepare(`INSERT OR IGNORE INTO account_backfill_receipts (user_id, account_id, run_id, apps_mapped, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(owner, acct, runId, toMap.length, now));
    stmts.push(...persist());
    await db.batch(stmts);
  }

  report.plan_hash = await sha256Hex(canonicalJson({ plan, exceptions: report.exceptions.map((e) => [e.kind, e.subject]).sort() }));
  return report;
}
