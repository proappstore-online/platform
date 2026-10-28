import { Command } from 'commander';
import { requireSession, resolveAppIdOrExit, ownerApi } from './secret.js';

// `pas billing` (#509, epic #506): the app owner's view of what their app sells. Owner only: the server answers 403 to anyone else.

export interface BillingProductRow {
  key: string;
  name: string;
  amount: number;
  currency: string;
  modes: string[];
  interval: { unit: string; count: number | null } | null;
  active: boolean;
  syncError: string | null;
}

export interface LedgerRow {
  purchaseId: string;
  product: string;
  buyerUserId: string;
  subjects: string[];
  status: string;
  createdAt: number;
  currency: string | null;
  gross: number;
  refunded: number;
  fee: number | null;
  net: number;
}

export interface EntitlementRow {
  product: string;
  subject: string;
  status: string;
  periodEnd: number | null;
  graceUntil: number | null;
  renews: boolean;
  buyerUserId: string | null;
}

/** 1234 -> "12.34 AUD". Amounts are in the smallest unit; a zero-decimal currency would need its own table, so the code is always shown. */
export function money(minor: number, currency: string | null): string {
  return `${(minor / 100).toFixed(2)}${currency ? ` ${currency.toUpperCase()}` : ''}`;
}

const day = (ms: number | null): string => (ms ? new Date(ms).toISOString().slice(0, 10) : '-');

export function formatProducts(enabled: boolean, products: BillingProductRow[]): string {
  const lines = [`Billing is ${enabled ? 'ENABLED' : 'not enabled'} for this app${enabled ? '' : ' (a platform admin turns it on)'}.`];
  if (products.length === 0) return `${lines[0]}\nNo products declared.\n`;
  for (const p of products) {
    const term = p.interval ? `every ${p.interval.count ?? 1} ${p.interval.unit}` : 'one-off';
    lines.push(`${p.key.padEnd(24)} ${money(p.amount, p.currency).padEnd(14)} ${p.modes.join('/').padEnd(18)} ${term}${p.active ? '' : '  (inactive)'}${p.syncError ? `  sync error: ${p.syncError}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export function formatPurchases(rows: LedgerRow[], totals: { currency: string; gross: number; refunded: number; fee: number; net: number }[]): string {
  if (rows.length === 0) return 'No paid purchases.\n';
  const lines = rows.map((r) =>
    `${day(r.createdAt)}  ${r.purchaseId.slice(0, 8)}  ${r.product.padEnd(20)} ${r.buyerUserId.padEnd(14)} gross ${money(r.gross, r.currency)}  refunded ${money(r.refunded, r.currency)}  fee ${r.fee === null ? 'pending' : money(r.fee, r.currency)}  net ${money(r.net, r.currency)}  ${r.status}${r.subjects.length ? `  [${r.subjects.join(', ')}]` : ''}`);
  for (const t of totals) lines.push(`TOTAL ${t.currency.toUpperCase() || '?'}: gross ${money(t.gross, t.currency)}  refunded ${money(t.refunded, t.currency)}  fees ${money(t.fee, t.currency)}  net ${money(t.net, t.currency)}`);
  return `${lines.join('\n')}\n`;
}

export function formatEntitlements(rows: EntitlementRow[]): string {
  if (rows.length === 0) return 'No entitlements.\n';
  return `${rows.map((e) =>
    `${e.product.padEnd(24)} ${(e.subject || '(none)').padEnd(20)} ${e.status.padEnd(9)} until ${day(e.periodEnd)}${e.status === 'grace' ? ` (grace to ${day(e.graceUntil)})` : ''}${e.renews ? '  renews' : ''}  ${e.buyerUserId ?? ''}`).join('\n')}\n`;
}

const appOption = ['--app <id>', 'app id (defaults to package.json name in cwd)'] as const;

export const billingCommand = new Command('billing')
  .description("What your app sells: products, purchases with refunds and Stripe fees, and entitlements. Owner only.")
  .addCommand(
    new Command('products')
      .description('The products the app declares, and whether billing is enabled.')
      .option(...appOption)
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const data = await ownerApi<{ enabled: boolean; products: BillingProductRow[] }>(cfg, 'GET', `/v1/apps/${appId}/billing/owner/products`, 'list billing products');
        process.stdout.write(opts.json ? `${JSON.stringify(data, null, 2)}\n` : formatProducts(data.enabled, data.products));
      }),
  )
  .addCommand(
    new Command('purchases')
      .description('Paid purchases with gross, refunds and Stripe fees (the revenue ledger).')
      .option(...appOption)
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const data = await ownerApi<{ purchases: LedgerRow[]; totals: { currency: string; gross: number; refunded: number; fee: number; net: number }[] }>(cfg, 'GET', `/v1/apps/${appId}/billing/owner/purchases`, 'list billing purchases');
        process.stdout.write(opts.json ? `${JSON.stringify(data, null, 2)}\n` : formatPurchases(data.purchases, data.totals));
      }),
  )
  .addCommand(
    new Command('entitlements')
      .description('Every entitlement of the app: who has paid access to what, until when.')
      .option(...appOption)
      .option('--product <key>', 'only this product')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; product?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const query = opts.product ? `?product=${encodeURIComponent(opts.product)}` : '';
        const data = await ownerApi<{ entitlements: EntitlementRow[] }>(cfg, 'GET', `/v1/apps/${appId}/billing/owner/entitlements${query}`, 'list entitlements');
        process.stdout.write(opts.json ? `${JSON.stringify(data, null, 2)}\n` : formatEntitlements(data.entitlements));
      }),
  );
