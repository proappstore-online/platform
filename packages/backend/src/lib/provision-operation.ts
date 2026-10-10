/** Durable, owner-bound receipts for MCP-driven app provisioning (#358). */

export type ProvisionOperationStatus = 'pending' | 'completed' | 'failed';

export interface ProvisionOperationStep {
  name: string;
  status: 'ok' | 'skip' | 'fail' | 'pending';
  detail: string;
  completedAt: number;
}

export interface ProvisionOperation {
  receiptId: string;
  creatorId: string;
  appId: string;
  status: ProvisionOperationStatus;
  steps: ProvisionOperationStep[];
  result: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

interface OperationRow {
  receipt_id: string;
  creator_id: string;
  app_id: string;
  status: ProvisionOperationStatus;
  steps_json: string;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function parseSteps(value: string): ProvisionOperationStep[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isStep) : [];
  } catch {
    return [];
  }
}

function parseResult(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isStep(value: unknown): value is ProvisionOperationStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Record<string, unknown>;
  return typeof step.name === 'string'
    && typeof step.detail === 'string'
    && typeof step.completedAt === 'number'
    && (step.status === 'ok' || step.status === 'skip' || step.status === 'fail' || step.status === 'pending');
}

function fromRow(row: OperationRow): ProvisionOperation {
  return {
    receiptId: row.receipt_id,
    creatorId: row.creator_id,
    appId: row.app_id,
    status: row.status,
    steps: parseSteps(row.steps_json),
    result: parseResult(row.result_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/** Atomically create an operation or return the app's existing receipt. */
export async function beginProvisionOperation(
  db: D1Database,
  args: { creatorId: string; appId: string; now?: number },
): Promise<{ operation: ProvisionOperation; created: boolean }> {
  const now = args.now ?? Date.now();
  const receiptId = crypto.randomUUID();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO provision_operations
       (receipt_id, creator_id, app_id, status, steps_json, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', '[]', ?, ?)`,
  ).bind(receiptId, args.creatorId, args.appId, now, now).run();
  const row = await db.prepare(
    `SELECT receipt_id, creator_id, app_id, status, steps_json, result_json,
            created_at, updated_at, completed_at
       FROM provision_operations WHERE app_id = ?`,
  ).bind(args.appId).first<OperationRow>();
  if (!row) throw new Error('provision operation insert was not readable');
  return { operation: fromRow(row), created: Number(inserted.meta.changes) > 0 };
}

export async function getProvisionOperation(db: D1Database, appId: string): Promise<ProvisionOperation | null> {
  const row = await db.prepare(
    `SELECT receipt_id, creator_id, app_id, status, steps_json, result_json,
            created_at, updated_at, completed_at
       FROM provision_operations WHERE app_id = ?`,
  ).bind(appId).first<OperationRow>();
  return row ? fromRow(row) : null;
}

/** Merge named evidence so each retry has the complete history, not just its last step. */
export async function updateProvisionOperation(
  db: D1Database,
  receiptId: string,
  update: { status?: ProvisionOperationStatus; steps?: ProvisionOperationStep[]; result?: Record<string, unknown> | null; now?: number },
): Promise<ProvisionOperation | null> {
  const existing = await db.prepare(
    `SELECT receipt_id, creator_id, app_id, status, steps_json, result_json,
            created_at, updated_at, completed_at
       FROM provision_operations WHERE receipt_id = ?`,
  ).bind(receiptId).first<OperationRow>();
  if (!existing) return null;
  const current = fromRow(existing);
  const merged = new Map(current.steps.map((step) => [step.name, step]));
  for (const step of update.steps ?? []) merged.set(step.name, step);
  const now = update.now ?? Date.now();
  const status = update.status ?? current.status;
  const result = update.result === undefined ? current.result : update.result;
  const completedAt = status === 'pending' ? null : (current.completedAt ?? now);
  await db.prepare(
    `UPDATE provision_operations
        SET status = ?, steps_json = ?, result_json = ?, updated_at = ?, completed_at = ?
      WHERE receipt_id = ?`,
  ).bind(status, JSON.stringify([...merged.values()]), result === null ? null : JSON.stringify(result), now, completedAt, receiptId).run();
  return getProvisionOperation(db, current.appId);
}
