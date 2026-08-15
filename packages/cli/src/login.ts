import { Command } from 'commander';
import { createServer, type Server } from 'node:http';
import { readConfig, writeConfig } from './lib/config.js';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export async function runLogin(): Promise<{ login: string }> {
  const config = await readConfig();
  const callback = await startCallbackServer();

  const startUrl = new URL(`${config.authApiBase}/v1/auth/github/start`);
  startUrl.searchParams.set('return_to', callback.url);
  startUrl.searchParams.set('response_mode', 'query');

  process.stdout.write(`\nOpen this URL to sign in to ProAppStore:\n${startUrl.toString()}\n\n`);
  process.stdout.write('Waiting for authorization...\n');

  let code: string;
  try {
    code = await callback.code;
  } finally {
    callback.close();
  }

  const exchangeUrl = `${config.authApiBase}/v1/auth/code/exchange`;
  const exchangeRes = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!exchangeRes.ok) {
    throw new Error(`Auth code exchange failed (${exchangeRes.status}): ${await exchangeRes.text()}`);
  }
  const { token: sessionToken } = (await exchangeRes.json()) as { token: string };

  const meRes = await fetch(`${config.authApiBase}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  if (!meRes.ok) {
    throw new Error(`Auth verification failed (${meRes.status}): ${await meRes.text()}`);
  }
  const me = (await meRes.json()) as { login?: string; name?: string; id?: string };
  const login = me.login ?? me.name ?? me.id ?? 'unknown';

  const { github: _legacyGithub, ...nextConfig } = config;
  await writeConfig({
    ...nextConfig,
    session: { token: sessionToken, obtainedAt: Date.now() },
  });
  process.stdout.write(`\n✓ Signed in as @${login}\n`);
  return { login };
}

function startCallbackServer(): Promise<{ url: string; code: Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server: Server = createServer((req, res) => {
      const base = server.address();
      const port = typeof base === 'object' && base ? base.port : 0;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const returnedCode = url.searchParams.get('code');
      if (!returnedCode) {
        const reason = url.searchParams.get('auth_error') ?? url.searchParams.get('error') ?? 'missing code';
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`ProAppStore sign-in failed: ${reason}`);
        rejectCode(new Error(`ProAppStore sign-in failed: ${reason}`));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>ProAppStore signed in</title><p>ProAppStore sign-in complete. You can close this tab.</p>');
      resolveCode(returnedCode);
    });

    server.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        rejectCode(error);
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || !address) {
        reject(new Error('Failed to start callback server.'));
        return;
      }
      settled = true;
      timeout = setTimeout(() => {
        rejectCode(new Error('Timed out waiting for ProAppStore sign-in.'));
        server.close();
      }, LOGIN_TIMEOUT_MS);
      resolve({
        url: `http://127.0.0.1:${address.port}/callback`,
        code,
        close: () => {
          if (timeout) clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

export const loginCommand = new Command('login')
  .description('Sign in with GitHub.')
  .action(async () => {
    await runLogin();
  });
