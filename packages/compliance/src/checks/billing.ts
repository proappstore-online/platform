import type { FileSource } from '../lib/file-source.js';
import { validateBilling, type BillingActionShape } from '../lib/billing-policy.js';
import type { CheckResult } from '../types.js';

const NAME = 'Billing products';

/**
 * #507: `billing` in mcp.json (products an app sells through the platform's Stripe account)
 * must pass the same validation registration applies, so a bad manifest fails `pas check`
 * rather than the deploy.
 */
export async function checkBilling(source: FileSource): Promise<CheckResult> {
  const raw = await source.read('mcp.json');
  if (raw === null) return { name: NAME, status: 'pass', detail: 'no mcp.json' };
  let manifest: { tools?: unknown; billing?: unknown };
  try {
    manifest = JSON.parse(raw) as typeof manifest;
  } catch {
    return { name: NAME, status: 'pass', detail: 'mcp.json is not valid JSON; registration reports it' };
  }
  if (manifest.billing === undefined || manifest.billing === null) return { name: NAME, status: 'pass', detail: 'sells no products' };
  const tools = (Array.isArray(manifest.tools) ? manifest.tools : []).filter((t): t is BillingActionShape => !!t && typeof t === 'object');
  const result = validateBilling(manifest.billing, tools);
  if ('error' in result) {
    return {
      name: NAME,
      status: 'fail',
      detail: result.error,
      suggestions: ['Declare "billing": { "authorize_action": "<query action with callers [\\"billing\\"]>", "products": [{ "key", "name", "amount", "currency", ... }] }. See docs/app-billing.md.'],
    };
  }
  return { name: NAME, status: 'pass', detail: `${result.billing!.products.length} product(s), authorized by ${result.billing!.authorize_action}` };
}
