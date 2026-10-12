import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { readConfig, resolveToken } from './lib/config.js';
import {
  connect, DEFAULT_SERVER_NAME, DEFAULT_TOKEN_ENV, disconnect, identity, mcpResource, readCredential, RemoteAuthError,
  type RemoteAuthDeps,
} from './mcp-remote-auth.js';

// `pas mcp-auth` (#356): connect a headless machine's MCP client to ProAppStore, approved from a phone.
// Protocol: docs/mcp-remote-auth-client.md.

const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')) as { version: string };
const MCP_ORIGIN = process.env.PAS_MCP_ORIGIN ?? 'https://mcp.proappstore.online';

function realDeps(): RemoteAuthDeps {
  return {
    fetch,
    runPags: (args, stdin) => new Promise((resolve, reject) => {
      const child = spawn('pags', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      child.stdin.end(stdin ?? '');
    }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (line) => { process.stdout.write(`${line}\n`); },
    dir: join(homedir(), '.proappstore', 'mcp'),
    pid: process.pid,
    isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  };
}

function fail(e: unknown): never {
  process.stderr.write(`pas: ${e instanceof RemoteAuthError ? e.message : e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}

export const mcpAuthCommand = new Command('mcp-auth')
  .description('Connect this machine\'s MCP client to ProAppStore, approved from your phone (no browser on this machine).')
  .addCommand(
    new Command('connect')
      .description('Start a sign-in request, get it approved on your phone, and store the new MCP credential.')
      .option('--app <id>', 'connect to one app\'s MCP endpoint (/mcp/apps/<id>) instead of the platform /mcp')
      .option('--name <name>', 'local name for this connection', DEFAULT_SERVER_NAME)
      .option('--agent <id>', 'the MCP client the credential is for, shown on the approval page', 'codex')
      .option('--machine <label>', 'how this machine is named on the approval page', hostname())
      .option('--no-relay', 'do not notify your phone through ProAgentStore; open the printed approval link yourself')
      .action(async (opts: { app?: string; name: string; agent: string; machine: string; relay: boolean }) => {
        try {
          const cfg = await readConfig();
          const resource = mcpResource(MCP_ORIGIN, opts.app);
          const result = await connect(realDeps(), {
            apiBase: cfg.apiBase,
            bearer: resolveToken(),
            resource,
            name: opts.name,
            agent: identity(opts.agent, opts.agent === 'codex' ? 'Codex' : opts.agent),
            machine: identity(opts.machine, opts.machine),
            relay: opts.relay,
            clientVersion: pkg.version,
          });
          process.stdout.write([
            `Connected "${result.name}" to ${result.resource}. The credential is stored in ~/.proappstore/mcp/${result.name}.json (0600).`,
            'To use it from Codex (once, a separate server entry; your existing ones are untouched):',
            `  codex mcp add ${result.name} --url ${result.resource} --bearer-token-env-var ${DEFAULT_TOKEN_ENV}`,
            'then start Codex with the credential in its environment only:',
            `  pas mcp-auth exec --name ${result.name} -- codex`,
            '',
          ].join('\n'));
        } catch (e) { fail(e); }
      }),
  )
  .addCommand(
    new Command('status')
      .description('Show the stored connection (never the credential itself).')
      .option('--name <name>', 'local connection name', DEFAULT_SERVER_NAME)
      .action(async (opts: { name: string }) => {
        try {
          const stored = await readCredential(realDeps(), opts.name);
          if (!stored) { process.stdout.write(`No connection "${opts.name}". Run \`pas mcp-auth connect\`.\n`); return; }
          const left = stored.expires_at - Date.now();
          process.stdout.write(`"${opts.name}": ${stored.resource}, ${left > 0 ? `valid for ${Math.round(left / 60_000)} more minutes` : 'expired — run `pas mcp-auth connect` again'}.\n`);
        } catch (e) { fail(e); }
      }),
  )
  .addCommand(
    new Command('exec')
      .description(`Run a command (e.g. codex) with the stored credential in ${DEFAULT_TOKEN_ENV}, for that process only.`)
      .option('--name <name>', 'local connection name', DEFAULT_SERVER_NAME)
      .option('--env-var <name>', 'environment variable to set', DEFAULT_TOKEN_ENV)
      .argument('<command...>', 'the command to run, after --')
      .action(async (command: string[], opts: { name: string; envVar: string }) => {
        try {
          const stored = await readCredential(realDeps(), opts.name);
          if (!stored) throw new RemoteAuthError('no_credential', `No connection "${opts.name}". Run \`pas mcp-auth connect\` first.`);
          if (stored.expires_at <= Date.now()) throw new RemoteAuthError('no_credential', `The connection "${opts.name}" has expired. Run \`pas mcp-auth connect\` again.`);
          if (!/^[A-Z_][A-Z0-9_]*$/.test(opts.envVar)) throw new RemoteAuthError('no_credential', `invalid environment variable name "${opts.envVar}"`);
          const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env: { ...process.env, [opts.envVar]: stored.access_token } });
          child.on('error', (err) => fail(err));
          child.on('close', (code) => process.exit(code ?? 1));
        } catch (e) { fail(e); }
      }),
  )
  .addCommand(
    new Command('disconnect')
      .description('Forget this machine\'s stored connection (local only; your ProAppStore account and other machines are unaffected).')
      .option('--name <name>', 'local connection name', DEFAULT_SERVER_NAME)
      .action(async (opts: { name: string }) => {
        try {
          const existed = await disconnect(realDeps(), opts.name);
          process.stdout.write(existed ? `Removed "${opts.name}" from this machine.\n` : `No connection "${opts.name}" on this machine.\n`);
        } catch (e) { fail(e); }
      }),
  );
