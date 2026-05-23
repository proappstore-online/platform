import { Command } from 'commander';
import { readConfig, writeConfig } from './lib/config.js';
import { startDeviceFlow } from './lib/github.js';

// Shared GitHub OAuth App with FAS — same identity, same session, same config file.
const DEFAULT_CLIENT_ID = process.env.PAS_GITHUB_CLIENT_ID ?? 'Ov23liuUpYPXc1ikEFm2';

export async function runLogin(): Promise<{ login: string }> {
  const flow = await startDeviceFlow(DEFAULT_CLIENT_ID);
  process.stdout.write(`\nOpen ${flow.verificationUri} and enter code: ${flow.userCode}\n\n`);
  process.stdout.write('Waiting for authorization...\n');

  const { accessToken, login } = await flow.poll();
  const config = await readConfig();

  // Exchange GitHub token for a platform session via the FAS API
  // (identity lives on FAS — one login for both CLIs).
  const exchangeUrl = `${config.apiBase}/v1/auth/exchange`;
  const exchangeRes = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubToken: accessToken }),
  });
  if (!exchangeRes.ok) {
    throw new Error(
      `Auth exchange failed (${exchangeRes.status} from ${exchangeUrl}): ${await exchangeRes.text()}`,
    );
  }
  const { sessionToken } = (await exchangeRes.json()) as { sessionToken: string };

  await writeConfig({
    ...config,
    github: { accessToken, login, obtainedAt: Date.now() },
    session: { token: sessionToken, obtainedAt: Date.now() },
  });
  process.stdout.write(`\n✓ Signed in as @${login}\n`);
  return { login };
}

export const loginCommand = new Command('login')
  .description('Sign in with GitHub (shared session with fas CLI).')
  .action(async () => {
    await runLogin();
  });
