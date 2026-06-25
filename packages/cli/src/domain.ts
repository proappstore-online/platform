import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { resolveToken } from './lib/config.js';

const PAS_API = 'https://api.proappstore.online';

const isTTY = Boolean(process.stdout.isTTY) && process.env.NO_COLOR !== '1';
const ansi = (open: string) => (s: string) => (isTTY ? `\x1b[${open}m${s}\x1b[39m` : s);
const green = ansi('32');
const yellow = ansi('33');
const red = ansi('31');
const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[22m` : s);
const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[22m` : s);

// Adaptive attach: 'worker' = the domain's zone is already on Cloudflare (instant,
// no DNS records for the owner); 'saas' = external DNS, so `instructions` carries the
// CNAME + TXT records to add at the registrar.
interface DomainInstructions {
  apex: boolean;
  cname: { name: string; value: string } | null;
  cnameTarget: string;
  txt: { name: string; value: string }[];
}

interface DomainDto {
  domain: string;
  status: 'pending' | 'active' | 'failed';
  method: 'worker' | 'saas' | null;
  cfStatus: string | null;
  instructions: DomainInstructions | null;
  addedAt: number;
  verifiedAt: number | null;
}

function readJsonIfExists<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function getAppId(): string {
  const pkg = readJsonIfExists<{ name?: string }>(resolve(process.cwd(), 'package.json'));
  if (!pkg?.name) {
    process.stderr.write(
      'pas domain: no package.json with a `name` field in the current directory.\n' +
        'Run this from the root of a pas-scaffolded app.\n',
    );
    process.exit(1);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(pkg.name) || pkg.name.length > 58) {
    process.stderr.write(`pas domain: package.json name "${pkg.name}" is not a valid app id.\n`);
    process.exit(1);
  }
  return pkg.name;
}

function getToken(opts: { token?: string }): string {
  const token = resolveToken(opts.token);
  if (!token) {
    process.stderr.write(
      'pas domain: no auth token. Run `pas login` first, or use --token.\n',
    );
    process.exit(1);
  }
  return token;
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${PAS_API}${path}`, init);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = { error: await res.text().catch(() => '') };
  }
  return { status: res.status, data };
}

function statusBadge(status: DomainDto['status']): string {
  if (status === 'active') return green('● active');
  if (status === 'pending') return yellow('● pending DNS');
  return red('● failed');
}

function renderDomain(d: DomainDto): void {
  process.stdout.write(`\n  ${bold(d.domain)}  ${statusBadge(d.status)}\n`);
  if (d.cfStatus) process.stdout.write(`    ${dim(`CF: ${d.cfStatus}`)}\n`);

  if (d.status === 'active') {
    process.stdout.write(`    ${dim(`verified ${new Date(d.verifiedAt || d.addedAt).toLocaleString()}`)}\n`);
    process.stdout.write(`    Live at: https://${d.domain}\n`);
    return;
  }

  // Status is cached — PAS does no background polling. The owner triggers a
  // fresh check by running `pas domain verify <domain>`.
  process.stdout.write(
    `    ${dim(`status as of ${new Date(d.addedAt).toLocaleString()} — run \`pas domain verify ${d.domain}\` to refresh`)}\n`,
  );

  const ins = d.instructions;
  // Worker path: the domain's zone is already on Cloudflare — nothing to add.
  if (d.method !== 'saas' || !ins) {
    process.stdout.write(
      `\n    ${dim("This domain's zone is on Cloudflare — no DNS records needed; the cert is provisioning.")}\n`,
    );
    process.stdout.write(`\n    Run ${bold(`pas domain verify ${d.domain}`)} in a moment.\n`);
    return;
  }

  // SaaS path: show the CNAME (or apex note) + TXT records.
  if (ins.apex || !ins.cname) {
    process.stdout.write(`\n    ${bold('Point your root (apex) domain at us:')}\n`);
    process.stdout.write(`    ${dim(`${d.domain} is a root domain — most registrars can't CNAME it.`)}\n`);
    process.stdout.write(`    ${dim(`Use CNAME flattening / ALIAS / ANAME → ${ins.cnameTarget}, or move the`)}\n`);
    process.stdout.write(`    ${dim("domain's nameservers to Cloudflare and re-attach for an instant connect.")}\n`);
  } else {
    process.stdout.write(`\n    ${bold('Add this CNAME at your registrar:')}\n\n`);
    process.stdout.write(`      Type:  CNAME\n`);
    process.stdout.write(`      Name:  ${ins.cname.name}\n`);
    process.stdout.write(`      Value: ${bold(ins.cname.value)}\n`);
  }
  if (ins.txt.length > 0) {
    process.stdout.write(
      `\n    ${dim(`Plus ${ins.txt.length === 1 ? 'this TXT record' : 'these TXT records'} for ownership + SSL:`)}\n`,
    );
    for (const t of ins.txt) {
      process.stdout.write(`      Type:  TXT\n`);
      process.stdout.write(`      Name:  ${t.name}\n`);
      process.stdout.write(`      Value: ${t.value}\n`);
    }
  }
  process.stdout.write(`\n    After adding the records, run: ${bold(`pas domain verify ${d.domain}`)}\n`);
}

async function addDomain(domain: string, opts: { token?: string }): Promise<void> {
  const appId = getAppId();
  const token = getToken(opts);
  process.stdout.write(`\n  Attaching ${bold(domain)} to ${appId}...\n`);
  const { status, data } = await api('POST', `/v1/apps/${appId}/domains`, token, { domain });
  if (status !== 201) {
    process.stderr.write(`\n  ${red('Failed')} (${status}): ${data?.error || JSON.stringify(data)}\n\n`);
    process.exit(1);
  }
  renderDomain(data.domain);
  process.stdout.write('\n');
}

async function listCmd(opts: { token?: string }): Promise<void> {
  const appId = getAppId();
  const token = getToken(opts);
  const { status, data } = await api('GET', `/v1/apps/${appId}/domains`, token);
  if (status !== 200) {
    process.stderr.write(`  pas domain list failed (${status}): ${data?.error || JSON.stringify(data)}\n`);
    process.exit(1);
  }
  const domains: DomainDto[] = data.domains || [];
  if (domains.length === 0) {
    process.stdout.write(`\n  No custom domains attached to ${appId}.\n`);
    process.stdout.write(`  Add one with: ${bold('pas domain add example.com')}\n\n`);
    return;
  }
  for (const d of domains) renderDomain(d);
  process.stdout.write('\n');
}

async function verifyCmd(domain: string, opts: { token?: string }): Promise<void> {
  const appId = getAppId();
  const token = getToken(opts);
  process.stdout.write(`\n  Re-checking ${bold(domain)}...\n`);
  const { status, data } = await api('POST', `/v1/apps/${appId}/domains/${encodeURIComponent(domain)}/verify`, token);
  if (status !== 200) {
    process.stderr.write(`  ${red('Verify failed')} (${status}): ${data?.error || JSON.stringify(data)}\n`);
    process.exit(1);
  }
  renderDomain(data.domain);
  process.stdout.write('\n');
}

async function removeCmd(domain: string, opts: { token?: string; yes?: boolean }): Promise<void> {
  const appId = getAppId();
  const token = getToken(opts);
  if (!opts.yes) {
    process.stderr.write(
      `\n  Detach ${bold(domain)} from ${appId}? This will stop serving the app at this domain.\n` +
        `  Re-run with --yes to confirm.\n\n`,
    );
    process.exit(2);
  }
  const { status, data } = await api('DELETE', `/v1/apps/${appId}/domains/${encodeURIComponent(domain)}`, token);
  if (status !== 200) {
    process.stderr.write(`  ${red('Remove failed')} (${status}): ${data?.error || JSON.stringify(data)}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n  ${green('Detached')} ${domain}.\n\n`);
}

export const domainCommand = new Command('domain').description('Manage BYO custom domains for this app');

domainCommand
  .command('add <domain>')
  .description('Attach a custom domain (apex or subdomain) to the current app')
  .option('--token <token>', 'Session token (or set PAS_SESSION_TOKEN)')
  .action(addDomain);

domainCommand
  .command('list')
  .alias('ls')
  .description('List custom domains attached to the current app + their verification state')
  .option('--token <token>', 'Session token (or set PAS_SESSION_TOKEN)')
  .action(listCmd);

domainCommand
  .command('verify <domain>')
  .description('Ask Cloudflare to re-check DNS / cert for a pending domain')
  .option('--token <token>', 'Session token (or set PAS_SESSION_TOKEN)')
  .action(verifyCmd);

domainCommand
  .command('remove <domain>')
  .alias('rm')
  .description('Detach a custom domain from the current app')
  .option('--token <token>', 'Session token (or set PAS_SESSION_TOKEN)')
  .option('--yes', 'Skip the confirmation prompt')
  .action(removeCmd);
