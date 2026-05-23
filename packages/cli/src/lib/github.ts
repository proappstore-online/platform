// GitHub Device Authorization Grant flow.
// Vendored from @freeappstore/cli — identical logic, no store-specific behavior.
// Spec: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  interval?: number;
}

export interface DeviceFlowStart {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  poll: () => Promise<{ accessToken: string; login: string }>;
}

export async function startDeviceFlow(clientId: string): Promise<DeviceFlowStart> {
  const codeRes = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  if (!codeRes.ok) {
    throw new Error(`GitHub device-code request failed: ${codeRes.status}`);
  }
  const code = (await codeRes.json()) as DeviceCodeResponse;

  let interval = code.interval;
  const expiresAt = Date.now() + code.expires_in * 1000;

  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    expiresAt,
    poll: async () => {
      while (Date.now() < expiresAt) {
        await sleep(interval * 1000);
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: clientId,
            device_code: code.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });
        const token = (await tokenRes.json()) as TokenResponse;
        if (token.access_token) {
          const login = await fetchLogin(token.access_token);
          return { accessToken: token.access_token, login };
        }
        if (token.error === 'slow_down') {
          interval = token.interval ?? interval + 5;
          continue;
        }
        if (token.error === 'authorization_pending') continue;
        throw new Error(`GitHub authorization failed: ${token.error ?? 'unknown'}`);
      }
      throw new Error('Device code expired before authorization completed.');
    },
  };
}

async function fetchLogin(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Failed to fetch GitHub user: ${res.status}`);
  const user = (await res.json()) as { login: string };
  return user.login;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
