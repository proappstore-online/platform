import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #618: the iOS and Android companions ship the same marketing version. Each has one version source.
function setting(file: string, pattern: RegExp): string {
  const match = readFileSync(file, 'utf8').match(pattern);
  if (!match) throw new Error(`${file}: ${pattern} not found`);
  return match[1];
}

describe('native companion version', () => {
  it('iOS MARKETING_VERSION equals Android versionName', () => {
    const ios = setting('ios/Config/Version.xcconfig', /^MARKETING_VERSION = (\S+)$/m);
    const android = setting('android/version.properties', /^versionName=(\S+)$/m);
    expect(ios).toBe(android);
  });

  it('Info.plist reads its version, build and commit from the xcconfig', () => {
    const plist = readFileSync('ios/ProAppStore/Info.plist', 'utf8');
    expect(plist).toMatch(/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/);
    expect(plist).toMatch(/<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/);
    expect(plist).toMatch(/<key>PASCommit<\/key>\s*<string>\$\(PAS_COMMIT\)<\/string>/);
    expect(readFileSync('ios/Config/Base.xcconfig', 'utf8')).toMatch(/^#include "Version\.xcconfig"$/m);
  });
});
