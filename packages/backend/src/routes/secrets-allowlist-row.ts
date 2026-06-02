/**
 * Allowlist DB row shape + row->rule mapper. Shared by the allowlist CRUD
 * routes and the proxy. Extracted verbatim from secrets.ts.
 */
import type { AllowlistRule } from '../lib/proxy-allowlist.js';

export interface AllowlistRow {
  pattern: string;
  inject_kind: string;
  inject_name: string;
  secret_name: string;
  secret_name_2: string | null;
  token_url: string | null;
  methods: string;
  created_at: number;
}

export function rowToRule(r: AllowlistRow): AllowlistRule {
  return {
    pattern: r.pattern,
    injectKind: r.inject_kind as AllowlistRule['injectKind'],
    injectName: r.inject_name,
    secretName: r.secret_name,
    secretName2: r.secret_name_2 ?? '',
    tokenUrl: r.token_url ?? '',
    methods: r.methods.split(',').filter(Boolean),
  };
}
