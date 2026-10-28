import { actionCallers, selectsColumn, type ToolManifest } from '../action-sql.js';

/**
 * The `billing` section of mcp.json (#507, epic #506): products an app sells through the platform's Stripe account, and
 * the action that authorizes a purchase.
 *
 *   "billing": {
 *     "authorize_action": "may_buy",
 *     "products": [{ "key": "child_term", "name": "Term (per child)", "amount": 1000, "currency": "aud",
 *                    "tax_behavior": "inclusive", "modes": ["one_time", "recurring"],
 *                    "interval": { "unit": "month", "count": 3 }, "grace_days": 5, "subject": "required" }]
 *   }
 *
 * Amounts are in the currency's smallest unit (cents). Declaring a product creates nothing that takes money: checkout
 * stays refused until an admin enables billing for the app.
 */

const BILLING_MODES = ['one_time', 'recurring'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
const TAX_BEHAVIORS = ['inclusive', 'exclusive', 'unspecified'] as const;
type TaxBehavior = (typeof TAX_BEHAVIORS)[number];
const INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const;
type IntervalUnit = (typeof INTERVAL_UNITS)[number];
const SUBJECT_RULES = ['required', 'none'] as const;
type SubjectRule = (typeof SUBJECT_RULES)[number];

export const MAX_BILLING_PRODUCTS = 20;
/** Stripe's own ceiling: a recurring interval is at most one year. */
const MAX_INTERVAL_COUNT: Record<IntervalUnit, number> = { day: 365, week: 52, month: 12, year: 1 };
const CURRENCIES = new Set(['aud', 'cad', 'chf', 'eur', 'gbp', 'jpy', 'nzd', 'sgd', 'usd']);
const MAX_AMOUNT = 99_999_999;

interface BillingProduct {
  key: string;
  name: string;
  amount: number;
  currency: string;
  tax_behavior: TaxBehavior;
  modes: BillingMode[];
  interval: { unit: IntervalUnit; count: number } | null;
  grace_days: number;
  subject: SubjectRule;
}
export interface BillingManifest {
  authorize_action: string;
  products: BillingProduct[];
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = <T extends string>(allowed: readonly T[], v: unknown): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v);

function validateProduct(raw: unknown, where: string): { error: string } | { product: BillingProduct } {
  if (!isObject(raw)) return { error: `${where} must be an object` };
  const unknown = Object.keys(raw).find((k) => !['key', 'name', 'amount', 'currency', 'tax_behavior', 'modes', 'interval', 'grace_days', 'subject'].includes(k));
  if (unknown) return { error: `${where}: unknown field "${unknown}"` };
  const { key, name, amount, currency, tax_behavior, modes, interval, grace_days, subject } = raw;
  if (typeof key !== 'string' || !KEY.test(key)) return { error: `${where}: key must be lowercase letters, digits and underscores, starting with a letter (max 40)` };
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return { error: `${where}: name is required (max 100 characters)` };
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) return { error: `${where}: amount must be a whole number of the currency's smallest unit (1 to ${MAX_AMOUNT})` };
  if (typeof currency !== 'string' || !CURRENCIES.has(currency)) return { error: `${where}: currency must be one of ${[...CURRENCIES].join(', ')} (lowercase)` };
  const tax = tax_behavior === undefined ? 'unspecified' : tax_behavior;
  if (!only(TAX_BEHAVIORS, tax)) return { error: `${where}: tax_behavior must be ${TAX_BEHAVIORS.map((t) => `"${t}"`).join(', ')}` };
  const modeList = modes === undefined ? ['one_time'] : modes;
  if (!Array.isArray(modeList) || modeList.length === 0 || modeList.some((m) => !only(BILLING_MODES, m)) || new Set(modeList).size !== modeList.length) {
    return { error: `${where}: modes must be a non-empty list of "one_time" and/or "recurring", without repeats` };
  }
  let period: BillingProduct['interval'] = null;
  if (interval !== undefined && interval !== null) {
    if (!isObject(interval) || !only(INTERVAL_UNITS, interval.unit) || typeof interval.count !== 'number' || !Number.isInteger(interval.count) || interval.count < 1) {
      return { error: `${where}: interval must be { unit: "day" | "week" | "month" | "year", count: a whole number from 1 }` };
    }
    if (Object.keys(interval).some((k) => k !== 'unit' && k !== 'count')) return { error: `${where}: interval takes only unit and count` };
    if (interval.count > MAX_INTERVAL_COUNT[interval.unit]) return { error: `${where}: a ${interval.unit} interval is at most ${MAX_INTERVAL_COUNT[interval.unit]} (Stripe's limit is one year)` };
    period = { unit: interval.unit, count: interval.count };
  }
  if ((modeList as string[]).includes('recurring') && !period) return { error: `${where}: a recurring product needs an interval` };
  const grace = grace_days === undefined ? 0 : grace_days;
  if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0 || grace > 30) return { error: `${where}: grace_days must be a whole number from 0 to 30` };
  const subjectRule = subject === undefined ? 'none' : subject;
  if (!only(SUBJECT_RULES, subjectRule)) return { error: `${where}: subject must be "required" or "none"` };
  return { product: { key, name: name.trim(), amount, currency, tax_behavior: tax, modes: modeList as BillingMode[], interval: period, grace_days: grace, subject: subjectRule } };
}

/** An absent section is `null`: the app sells nothing. Validated against the already-validated tools. */
export function validateBilling(raw: unknown, tools: ToolManifest[]): { error: string } | { billing: BillingManifest | null } {
  if (raw === undefined || raw === null) return { billing: null };
  if (!isObject(raw)) return { error: 'billing must be an object' };
  const unknown = Object.keys(raw).find((k) => k !== 'products' && k !== 'authorize_action');
  if (unknown) return { error: `billing: unknown field "${unknown}"` };
  const { products, authorize_action } = raw;
  if (!Array.isArray(products) || products.length === 0) return { error: 'billing.products must be a non-empty list' };
  if (products.length > MAX_BILLING_PRODUCTS) return { error: `billing.products: max ${MAX_BILLING_PRODUCTS} products` };
  const out: BillingProduct[] = [];
  const seen = new Set<string>();
  for (const [i, p] of products.entries()) {
    const r = validateProduct(p, `billing.products[${i}]`);
    if ('error' in r) return r;
    if (seen.has(r.product.key)) return { error: `billing.products[${i}]: key "${r.product.key}" is declared twice` };
    seen.add(r.product.key);
    out.push(r.product);
  }

  // Fail closed: every product needs an app-side decision about who may buy it. An app that wants everyone writes a query that says so.
  if (typeof authorize_action !== 'string' || !authorize_action) return { error: 'billing.authorize_action is required: the name of the action (callers: ["billing"]) that decides who may buy' };
  const action = tools.find((t) => t.name === authorize_action);
  if (!action) return { error: `billing.authorize_action: "${authorize_action}" is not a tool in this manifest` };
  const callers = actionCallers(action);
  if (callers.length !== 1 || callers[0] !== 'billing') return { error: `billing.authorize_action: "${authorize_action}" must declare callers: ["billing"] only, so no user, worker or hook can call it` };
  if (action.operation !== 'query') return { error: `billing.authorize_action: "${authorize_action}" must be a query` };
  if (action.requires_auth === false) return { error: `billing.authorize_action: "${authorize_action}" must require auth` };
  const sql = typeof action.sql === 'string' ? action.sql : '';
  if (!sql.includes(':__user_id')) return { error: `billing.authorize_action: "${authorize_action}" must use :__user_id, or it decides nothing about the buyer` };
  // `AS allowed` is read directly: selectsColumn wants a FROM after it, and `SELECT 1 AS allowed WHERE ...` is valid SQLite.
  if (!selectsColumn(sql, 'allowed') && !/\bAS\s+["`]?allowed["`]?(?![\w])/i.test(sql)) return { error: `billing.authorize_action: "${authorize_action}" must select an "allowed" column (1 to allow)` };
  const params = Object.entries(action.params ?? {});
  const badParam = params.find(([n, s]) => (n !== 'product' && n !== 'subjects_json') || (s as { type?: string }).type !== 'string');
  if (badParam) return { error: `billing.authorize_action: "${authorize_action}" may declare only the string params "product" and "subjects_json" (got "${badParam[0]}")` };
  return { billing: { authorize_action, products: out } };
}
