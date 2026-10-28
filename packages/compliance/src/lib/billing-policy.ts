/**
 * The `billing` section of mcp.json (#507, epic #506): the products an app sells through the
 * platform's Stripe account, and the registered action that decides who may buy them.
 *
 * ```json
 * { "billing": {
 *     "authorize_action": "billing_can_buy",
 *     "products": [ { "key": "child_term", "name": "Chess Academy term (per child)",
 *       "amount": 1000, "currency": "aud", "tax_behavior": "inclusive",
 *       "modes": ["one_time", "recurring"], "interval": { "unit": "month", "count": 3 },
 *       "grace_days": 5, "subject": "required" } ] } }
 * ```
 *
 * Shared by the platform's registration gate (backend `routes/tools.ts`) and the `billing`
 * compliance check, so a manifest `pas check` accepts is one registration accepts.
 */

export const BILLING_MODES = ['one_time', 'recurring'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const BILLING_INTERVAL_UNITS = ['day', 'week', 'month', 'year'] as const;
type BillingIntervalUnit = (typeof BILLING_INTERVAL_UNITS)[number];
export const BILLING_TAX_BEHAVIORS = ['inclusive', 'exclusive', 'unspecified'] as const;
type BillingTaxBehavior = (typeof BILLING_TAX_BEHAVIORS)[number];
export const BILLING_SUBJECTS = ['required', 'none'] as const;
type BillingSubject = (typeof BILLING_SUBJECTS)[number];

export const MAX_BILLING_PRODUCTS = 20;
/** Stripe's own ceiling on a unit amount is 99,999,999 in the smallest currency unit. */
const MAX_BILLING_AMOUNT = 99_999_999;
const MAX_BILLING_GRACE_DAYS = 30;
/** Stripe caps a recurring interval at one year (3 years for the sum of unit and count). */
const MAX_INTERVAL_COUNT: Record<BillingIntervalUnit, number> = { day: 365, week: 52, month: 12, year: 1 };

export const PRODUCT_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export interface BillingProduct {
  key: string;
  name: string;
  /** Smallest currency unit (cents). */
  amount: number;
  /** Lower-case ISO 4217. */
  currency: string;
  tax_behavior: BillingTaxBehavior;
  modes: BillingMode[];
  /** Required when `modes` includes "recurring": the billing period, and the term a one-off purchase covers. */
  interval: { unit: BillingIntervalUnit; count: number } | null;
  grace_days: number;
  subject: BillingSubject;
}

export interface BillingConfig { authorize_action: string; products: BillingProduct[] }

/** The slice of a registered action the billing policy reads. */
export interface BillingActionShape {
  name?: unknown;
  operation?: unknown;
  callers?: unknown;
  requires_auth?: unknown;
  schedule?: unknown;
  params?: unknown;
  auth?: { app_roles?: unknown; platform_roles?: unknown } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validateProduct(raw: unknown, at: string): { error: string } | { product: BillingProduct } {
  if (!isObject(raw)) return { error: `${at} must be an object` };
  const allowed = ['key', 'name', 'amount', 'currency', 'tax_behavior', 'modes', 'interval', 'grace_days', 'subject'];
  const unknown = Object.keys(raw).find((k) => !allowed.includes(k));
  if (unknown) return { error: `${at}: unknown field "${unknown}"` };
  const { key, name, amount, currency, tax_behavior, modes, interval, grace_days, subject } = raw;

  if (typeof key !== 'string' || !PRODUCT_KEY.test(key)) return { error: `${at}.key must match ${PRODUCT_KEY.source}` };
  if (typeof name !== 'string' || name.trim() === '' || name.length > 80) return { error: `${at}.name must be 1-80 characters` };
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_BILLING_AMOUNT) {
    return { error: `${at}.amount must be an integer of 1 to ${MAX_BILLING_AMOUNT} in the smallest currency unit (cents)` };
  }
  if (typeof currency !== 'string' || !/^[a-zA-Z]{3}$/.test(currency)) return { error: `${at}.currency must be a three-letter ISO 4217 code` };

  const tax = tax_behavior === undefined ? 'unspecified' : tax_behavior;
  if (typeof tax !== 'string' || !(BILLING_TAX_BEHAVIORS as readonly string[]).includes(tax)) {
    return { error: `${at}.tax_behavior must be ${BILLING_TAX_BEHAVIORS.map((t) => `"${t}"`).join(', ')}` };
  }

  const modeList = modes === undefined ? ['one_time'] : modes;
  if (!Array.isArray(modeList) || modeList.length === 0 || modeList.some((m) => !(BILLING_MODES as readonly unknown[]).includes(m)) || new Set(modeList).size !== modeList.length) {
    return { error: `${at}.modes must be a non-empty list without repeats of ${BILLING_MODES.map((m) => `"${m}"`).join(', ')}` };
  }

  let parsedInterval: BillingProduct['interval'] = null;
  if (interval !== undefined && interval !== null) {
    if (!isObject(interval) || Object.keys(interval).some((k) => k !== 'unit' && k !== 'count')) return { error: `${at}.interval must be { "unit", "count" }` };
    const { unit, count } = interval;
    if (typeof unit !== 'string' || !(BILLING_INTERVAL_UNITS as readonly string[]).includes(unit)) {
      return { error: `${at}.interval.unit must be ${BILLING_INTERVAL_UNITS.map((u) => `"${u}"`).join(', ')}` };
    }
    const max = MAX_INTERVAL_COUNT[unit as BillingIntervalUnit];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > max) {
      return { error: `${at}.interval.count must be an integer of 1 to ${max} for "${unit}"` };
    }
    parsedInterval = { unit: unit as BillingIntervalUnit, count };
  }
  if ((modeList as string[]).includes('recurring') && !parsedInterval) return { error: `${at}.interval is required when modes includes "recurring"` };

  const grace = grace_days === undefined ? 0 : grace_days;
  if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0 || grace > MAX_BILLING_GRACE_DAYS) {
    return { error: `${at}.grace_days must be an integer of 0 to ${MAX_BILLING_GRACE_DAYS}` };
  }
  const subj = subject === undefined ? 'none' : subject;
  if (typeof subj !== 'string' || !(BILLING_SUBJECTS as readonly string[]).includes(subj)) {
    return { error: `${at}.subject must be "required" or "none"` };
  }
  return {
    product: {
      key, name: name.trim(), amount, currency: currency.toLowerCase(), tax_behavior: tax as BillingTaxBehavior,
      modes: modeList as BillingMode[], interval: parsedInterval, grace_days: grace, subject: subj as BillingSubject,
    },
  };
}

/**
 * Validate `billing` against the manifest's actions. Absent or null means the app sells nothing.
 * The authorize action must be a registered query that only the platform's billing path can
 * call (`callers` includes "billing"), takes `product` and `subjects_json`, runs for the buyer
 * (no schedule, no role gate: a buyer holds no role yet) and so scopes itself with :__user_id.
 */
export function validateBilling(raw: unknown, tools: readonly BillingActionShape[]): { error: string } | { billing: BillingConfig | null } {
  if (raw === undefined || raw === null) return { billing: null };
  if (!isObject(raw)) return { error: 'billing must be an object { authorize_action, products }' };
  const extra = Object.keys(raw).find((k) => k !== 'authorize_action' && k !== 'products');
  if (extra) return { error: `billing: unknown field "${extra}"` };
  const { authorize_action, products } = raw;
  if (!Array.isArray(products) || products.length === 0 || products.length > MAX_BILLING_PRODUCTS) {
    return { error: `billing.products must be a list of 1 to ${MAX_BILLING_PRODUCTS} products` };
  }
  const list: BillingProduct[] = [];
  for (const [i, item] of products.entries()) {
    const v = validateProduct(item, `billing.products[${i}]`);
    if ('error' in v) return v;
    if (list.some((p) => p.key === v.product.key)) return { error: `billing.products[${i}]: duplicate key "${v.product.key}"` };
    list.push(v.product);
  }

  if (typeof authorize_action !== 'string' || !authorize_action) return { error: 'billing.authorize_action must name a registered action' };
  const tool = tools.find((t) => t.name === authorize_action);
  const at = `billing.authorize_action "${authorize_action}"`;
  if (!tool) return { error: `${at} is not an action in this manifest` };
  if (tool.operation !== 'query') return { error: `${at} must be a query action` };
  if (!Array.isArray(tool.callers) || !tool.callers.includes('billing')) return { error: `${at} must list "billing" in its callers` };
  if (tool.callers.includes('worker') || tool.callers.includes('hook')) return { error: `${at} must not also list "worker" or "hook" in its callers` };
  if (tool.requires_auth === false) return { error: `${at} must require auth` };
  if (tool.schedule !== undefined) return { error: `${at} cannot be a scheduled action` };
  if ((Array.isArray(tool.auth?.app_roles) && tool.auth.app_roles.length) || (Array.isArray(tool.auth?.platform_roles) && tool.auth.platform_roles.length)) {
    return { error: `${at} cannot be role-gated: it runs for a buyer, who holds no role` };
  }
  const params = isObject(tool.params) ? tool.params : {};
  for (const p of ['product', 'subjects_json']) {
    if (!(p in params)) return { error: `${at} must declare the param "${p}" (type string)` };
  }
  return { billing: { authorize_action, products: list } };
}
