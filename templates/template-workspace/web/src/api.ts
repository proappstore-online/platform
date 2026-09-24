import { initPro } from '@proappstore/sdk'

// platform-cookie is the current auth mode (PAS-AUTH-001).
export const app = initPro({ appId: 'APPNAME', authMode: 'platform-cookie' })

/**
 * Extension points. The spine is generic — workspaces, members, permissions, invitations,
 * records with a lifecycle, approvals, audit — and the record types are yours.
 */
export const RECORD_TYPES = ['invoice', 'expense', 'deal', 'timesheet'] as const
export const PERMISSION_KEYS = ['manage_members', 'approve', 'export'] as const
export const ROLES = ['admin', 'manager', 'member'] as const
/** Where the caller's chosen workspace lives: per-user platform KV, never localStorage. Every statement re-checks membership. */
export const ACTIVE_WORKSPACE_KEY = 'active_workspace'

export type Role = (typeof ROLES)[number]
export type PermissionKey = (typeof PERMISSION_KEYS)[number]
export type RecordStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'closed'

export interface Workspace { id: string; name: string; created_at: number; role: Role }
export interface WorkspaceDetail extends Workspace { updated_at: number; permissions: string }
export interface Member { user_id: string; display_name: string; role: Role; joined_at: number; permissions: string }
export interface Invitation { id: string; login: string; role: Role; invited_by: string; created_at: number }
export interface RecordRow {
  id: string; workspace_id: string; type: string; title: string; status: RecordStatus; amount: number | null
  assignee_id: string | null; notes: string; created_by: string; created_at: number; updated_at: number
}
export interface RecordDetail extends RecordRow { approvals: string }
export interface Approval { id: string; requested_by: string; decision: string; decided_by: string | null; note: string; created_at: number; decided_at: number | null }
export interface PendingApproval { id: string; record_id: string; requested_by: string; requested_by_name: string | null; note: string; created_at: number; type: string; title: string; amount: number | null }
export interface Stat { status: RecordStatus; count: number; total: number }
export interface Activity { id: string; user_id: string; user_name: string | null; entity_type: string; entity_id: string; action: string; changes: string; created_at: number }

/** Query action → rows. */
export async function q<T>(name: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const res = await app.actions.call<{ rows: T[] }>(name, params)
  return res.rows
}

/** Execute action → rows changed (0 = refused by a guard). */
export async function x(name: string, params: Record<string, unknown> = {}): Promise<number> {
  const res = await app.actions.call<{ meta: { changes: number } }>(name, params)
  return res.meta.changes
}

/** Batch action → rows changed per statement, in order. The first statement is the write; the last is its audit row. */
export async function batch(name: string, params: Record<string, unknown> = {}): Promise<number[]> {
  const res = await app.actions.call<{ results: { meta: { changes: number } }[] }>(name, params)
  return res.results.map((r) => r.meta.changes)
}

export function parsePermissions(json: string | null | undefined): PermissionKey[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((k): k is PermissionKey => (PERMISSION_KEYS as readonly string[]).includes(String(k))) : []
  } catch {
    return []
  }
}

export function can(ws: WorkspaceDetail | null, key: PermissionKey): boolean {
  return !!ws && (ws.role === 'admin' || parsePermissions(ws.permissions).includes(key))
}

export function money(n: number | null): string {
  if (n === null || n === undefined) return ''
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
}

export function when(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ''
  const cols = Object.keys(rows[0]!)
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')
}
