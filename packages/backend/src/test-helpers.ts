import { mintSession } from '@proappstore/build-core';
import type { NewSession } from '@proappstore/build-core';

/** Signing key used by all backend tests. Must match SESSION_SIGNING_KEY in test env. */
export const TEST_SK = 'test-signing-key';

/** Mint a valid PAS session token for tests. */
export async function testToken(
  uid: string,
  opts?: { roles?: string[]; login?: string; appRoles?: Record<string, string[]> },
): Promise<string> {
  const claims: NewSession = {
    uid,
    login: opts?.login ?? 'testuser',
    roles: opts?.roles ?? ['user'],
    ...(opts?.appRoles ? { appRoles: opts.appRoles } : {}),
  };
  return mintSession(claims, TEST_SK);
}
