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

// CF Pages Domain object shape:
//   verification_data: { error_message?: string; status?: string }
//   validation_data:   { error_message?: string; method?: 'http'|'txt'; status?: string;
//                        txt_name?: string; txt_value?: string }
// The TXT records owners actually need to add only appear in validation_data
// when method is 'txt' (CF defaults to HTTP-01, falls back to TXT only if
// HTTP-01 isn't possible).
interface VerificationData {
  status?: string;
  error_message?: string;
}
interface ValidationData {
  status?: string;
  method?: string;
  txt_name?: string;
  txt_value?: string;
  error_message?: string;
}

interface DomainDto {
  domain: string;
  status: 'pending' | 'active' | 'failed';
  cfStatus: string | null;
  verificationData: VerificationData | null;
  validationData: ValidationData | null;
  certificateAuthority: string | null;
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

function renderDomain(d: DomainDto, appId: string): void {
  process.stdout.write(`\n  ${bold(d.domain)}  ${statusBadge(d.status)}\n`);
  if (d.cfStatus) process.stdout.write(`    ${dim(`CF: ${d.cfStatus}`)}\n`);

  if (d.status === 'active') {
    process.stdout.write(`    ${dim(`verified ${new Date(d.verifiedAt || d.addedAt).toLocaleString()}`)}\n`);
    process.stdout.write(`    Live at: https://${d.domain}\n`);
    return;
  }

  // Status is cached at the time it was last attached or verified. PAS does
  // no background polling — the owner triggers a fresh check by running
  // `pas domain verify <domain>`. Make that contract explicit here so the
  // owner isn't surprised when nothing changes between `pas domain list`
  // invocations.
  process.stdout.write(
    `    ${dim(`status as of ${new Date(d.addedAt).toLocaleString()} — run \`pas domain verify ${d.domain}\` to refresh`)}\n`,
  );

  const vd = d.verificationData || {};
  const valid = d.validationData || {};
  process.stdout.write(`\n    ${bold('Add this DNS record at your registrar:')}\n\n`);
  process.stdout.write(`      Type:  CNAME\n`);
  process.stdout.write(`      Name:  ${d.domain}\n`);
  process.stdout.write(`      Value: ${bold(`${appId}.proappstore.online`)}\n`);
  process.stdout.write(
    `\n    ${dim('Apex domains (e.g. example.com without a subdomain) can\'t use a raw CNAME')}\n` +
      `    ${dim('per RFC. Use ALIAS/ANAME if your registrar supports it, or set A/AAAA')}\n` +
      `    ${dim('records pointing to Cloudflare anycast IPs (CF will tell you which).')}\n`,
  );
  // CF only emits TXT validation when HTTP-01 isn't possible — usually
  // because DNS isn't yet pointing correctly. When method is 'txt', the
  // owner needs this record too.
  if (valid.method === 'txt' && valid.txt_name && valid.txt_value) {
    process.stdout.write(`\n      ${dim('Plus this TXT record for SSL validation:')}\n`);
    process.stdout.write(`      Type:  TXT\n`);
    process.stdout.write(`      Name:  ${valid.txt_name}\n`);
    process.stdout.write(`      Value: ${valid.txt_value}\n`);
  }
  if (vd.error_message) {
    process.stdout.write(`\n    ${red('Last verification error:')} ${vd.error_message}\n`);
  } else if (valid.error_message) {
    process.stdout.write(`\n    ${red('Last validation error:')} ${valid.error_message}\n`);
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
  renderDomain(data.domain, appId);
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
  for (const d of domains) renderDomain(d, appId);
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
  renderDomain(data.domain, appId);
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
