import type { ProjectHost } from './project-host.ts';
import type { Project, Role, RoleConfig } from './types.ts';
import { seedFiles, type TemplateType } from './template-seed.ts';
import { json, rowToRoleConfig, uuid } from './store.ts';
import { deployStatusOf } from './deploy-stage.ts';
import { validateRoleConfig } from './role-config.ts';
import { buildAgentCatalog } from './agents-catalog.ts';
import { saveFiles } from './project-store.ts';
import { DEFAULT_PERSONAS } from './memory.ts';

export function getProject(h: ProjectHost): Response {
  const row = h.state.storage.sql
    .exec('SELECT * FROM project LIMIT 1')
    .toArray()[0] as Record<string, unknown> | undefined;
  if (!row) return json({ error: 'project_not_initialized' }, 404);
  // Spend is stored against cost_month and only reset on the first spend of a
  // new month (storeMessage). Report 0 for a stale month so the UI/budget bar
  // doesn't show last month's total — matching the auto-pause gate in autoAdvance.
  const currentMonth = new Date().toISOString().slice(0, 7);
  const spent = row.cost_month === currentMonth ? (row.cost_spent_monthly_usd as number) : 0;
  return json({
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at,
    costCapMonthlyUsd: row.cost_cap_monthly_usd,
    costSpentMonthlyUsd: spent,
    maxRunMinutes: (row.max_run_minutes as number) ?? 10,
    repoUrl: row.repo_url,
    status: row.status ?? 'paused',
    // #9: the latest deploy of the shared tree + where the app is served, for
    // the console's deploy-status / live-preview panel.
    deploy: deployStatusOf(row, String(row.slug)),
  });
}

export async function initProject(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json()) as Partial<Project> & { idea?: string; template?: TemplateType };
  if (!body.name || !body.slug || !body.ownerId) {
    return json({ error: 'name, slug, ownerId required' }, 400);
  }

  // Prevent re-init takeover: reject if project already exists
  const existing = h.state.storage.sql
    .exec('SELECT id, owner_id FROM project LIMIT 1')
    .toArray()[0] as { id: string; owner_id: string } | undefined;
  if (existing) {
    // Only the owner can re-init (to update name/cap)
    const userId = request.headers.get('X-User-Id');
    if (existing.owner_id !== userId) {
      return json({ error: 'not_found' }, 404);
    }
    // Update, don't replace (preserve cost tracking)
    h.state.storage.sql.exec(
      'UPDATE project SET name = ?, cost_cap_monthly_usd = ? WHERE id = ?',
      body.name, body.costCapMonthlyUsd ?? 50.0, existing.id,
    );
    return json({ id: existing.id, slug: body.slug });
  }

  const id = uuid();
  const now = Date.now();

  h.state.storage.sql.exec(
    `INSERT INTO project (id, owner_id, name, slug, created_at, cost_cap_monthly_usd, app_idea)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, body.ownerId, body.name, body.slug, now, body.costCapMonthlyUsd ?? 50.0, body.idea?.trim() ?? null,
  );

  // Set default role configs
  const defaults: RoleConfig[] = [
    { role: 'Architect', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'batch_write_files', 'read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: ['web_search', 'web_fetch'] },
    { role: 'BA', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 8192, spineTools: ['read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: [] },
    { role: 'Dev', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'read_file', 'list_files', 'batch_write_files', 'search_files', 'read_docs'], vendorTools: [] },
    { role: 'QA', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: [] },
  ];

  for (const rc of defaults) {
    h.state.storage.sql.exec(
      `INSERT OR REPLACE INTO role_configs (role, runtime, model, spine_tools, vendor_tools, max_tokens, persona)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rc.role, rc.runtime, rc.model, JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools), rc.maxTokens ?? null,
      DEFAULT_PERSONAS[rc.role] ?? null,
    );
  }

  // Seed the working tree from the platform template. This gives every new app
  // the correct infrastructure files (.gitignore, LICENSE, package.json with test
  // script, vite.config.ts, tsconfig.json, etc.) so the Dev agent writes INTO a
  // proper scaffold — not from scratch. Matches pas/templates/template-app/.
  const templateFiles = seedFiles(body.slug, body.template ?? 'blank');
  saveFiles(h.state.storage.sql, templateFiles);

  h.broadcast({ type: 'project-created', projectId: id });
  return json({ id, slug: body.slug, seededTicket: false });
}

export function getRoles(h: ProjectHost): Response {
  const rows = h.state.storage.sql
    .exec('SELECT * FROM role_configs ORDER BY role')
    .toArray();
  const configs = rows.map(rowToRoleConfig);
  return json({ roles: configs });
}

export function getAgents(h: ProjectHost): Response {
  const rows = h.state.storage.sql
    .exec('SELECT * FROM role_configs ORDER BY role')
    .toArray();
  const configs = rows.map(rowToRoleConfig);
  const po = h.state.storage.sql
    .exec("SELECT persona FROM role_configs WHERE role = 'PO'")
    .toArray()[0] as { persona: string | null } | undefined;
  const agents = buildAgentCatalog(configs.filter((c) => c.role !== ('PO' as Role)), { poPersona: po?.persona ?? null });
  return json({ agents });
}

/** Update project settings: monthly cost cap and/or agent run timeout. */
export async function setBudget(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json()) as { costCapMonthlyUsd?: number; maxRunMinutes?: number };
  const cap = body.costCapMonthlyUsd;
  const timeout = body.maxRunMinutes;
  if (cap !== undefined) {
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 1000) {
      return json({ error: 'costCapMonthlyUsd must be a number between 1 and 1000' }, 400);
    }
    h.state.storage.sql.exec('UPDATE project SET cost_cap_monthly_usd = ? WHERE id = (SELECT id FROM project LIMIT 1)', cap);
    h.logActivity('control', `Monthly budget set to $${cap.toFixed(2)}`);
  }
  if (timeout !== undefined) {
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
      return json({ error: 'maxRunMinutes must be an integer between 1 and 60' }, 400);
    }
    h.state.storage.sql.exec('UPDATE project SET max_run_minutes = ? WHERE id = (SELECT id FROM project LIMIT 1)', timeout);
    h.logActivity('control', `Agent run timeout set to ${timeout} min`);
  }
  return json({ ok: true, ...(cap !== undefined ? { costCapMonthlyUsd: cap } : {}), ...(timeout !== undefined ? { maxRunMinutes: timeout } : {}) });
}

export async function setRoles(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json()) as { roles: RoleConfig[] };

  // Validate the WHOLE batch first — otherwise an invalid role mid-list would
  // leave the earlier ones already written (partial update on a 400).
  for (const rc of body.roles ?? []) {
    const err = validateRoleConfig(rc);
    if (err) return json({ error: err }, 400);
  }

  for (const rc of body.roles ?? []) {
    h.state.storage.sql.exec(
      `INSERT OR REPLACE INTO role_configs (role, runtime, model, system_prompt_override, spine_tools, vendor_tools, max_tokens, persona, key_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rc.role, rc.runtime, rc.model, rc.systemPromptOverride ?? null,
      JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools), rc.maxTokens ?? null, rc.persona ?? null,
      rc.keyProvider ?? null,
    );
  }
  return json({ ok: true });
}
