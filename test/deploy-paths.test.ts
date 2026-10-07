import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs CI script, no type declarations
import { bundledDeps, checkDeployPaths, deploysTriggeredBy, packageDirs, problemsFor, runtimeImports, triggerPackages } from '../scripts/check-deploy-paths.mjs';

// #322: a deploy workflow must trigger on every workspace package its worker
// bundles, and on nothing else. scripts/check-deploy-paths.mjs computes the
// bundled set from real imports; these tests pin the repo and the checker.

describe('deploy path filters track workspace imports (#322)', () => {
  it('every deploy workflow triggers on exactly the packages its worker bundles', () => {
    expect(checkDeployPaths().problems).toEqual([]);
  });

  it('a change confined to one package selects exactly the deploys that bundle it', () => {
    const expected: Record<string, string[]> = {
      backend: ['deploy-backend.yml'],
      host: ['deploy-host.yml'],
      mcp: ['deploy-mcp.yml'],
      admin: ['deploy-admin.yml'],
      'kb-host': ['deploy-kb-host.yml'],
      'qa-worker': ['deploy-qa-worker.yml'],
      'agent-teams': ['deploy-agent-teams.yml', 'deploy-mcp.yml'],
      'build-core': ['deploy-admin.yml', 'deploy-backend.yml', 'deploy-mcp.yml'],
      'qa-spec': ['deploy-backend.yml', 'deploy-host.yml', 'deploy-qa-worker.yml'],
      compliance: ['deploy-backend.yml'],
      'data-worker': ['deploy-backend.yml'],
      // Bundled by no deployed worker: their changes deploy nothing (sdk and cli are published by publish.yml).
      sdk: [], cli: [], 'mcp-registry': [], 'runtime-tests': [],
    };
    for (const pkg of packageDirs as string[]) {
      expect(deploysTriggeredBy(pkg), pkg).toEqual(expected[pkg] ?? []);
    }
    expect(Object.keys(expected).sort()).toEqual([...(packageDirs as string[])].sort());
  });

  it('flags a workflow missing a bundled package, and one triggering on a package its worker does not bundle', () => {
    const backendMissingQaSpec = `on:
  push:
    paths:
      - 'packages/backend/**'
      - 'packages/build-core/**' # comment
      - 'packages/compliance/**'
      - 'packages/data-worker/**'
`;
    expect(problemsFor('deploy-backend.yml', 'backend', backendMissingQaSpec)).toEqual([
      expect.stringMatching(/missing 'packages\/qa-spec\/\*\*' — packages\/backend\/src\/routes\/qa\.ts imports @proappstore\/qa-spec/),
    ]);
    const hostWithSdk = "on:\n  push:\n    paths: ['packages/host/**', 'packages/qa-spec/**', 'packages/sdk/**']\n";
    expect(problemsFor('deploy-host.yml', 'host', hostWithSdk)).toEqual([expect.stringMatching(/'packages\/sdk\/\*\*' triggers it, but host does not bundle sdk/)]);
  });

  it('counts relative imports into another package and build-time embeds, transitively', () => {
    expect([...bundledDeps('mcp').keys()].sort()).toEqual(['agent-teams', 'build-core']);
    expect(bundledDeps('mcp').get('agent-teams')).toMatch(/\.\.\/\.\.\/agent-teams\/src\/recipes\.js/);
    expect(bundledDeps('backend').get('data-worker')).toMatch(/embed-data-worker\.mjs embeds it/);
  });

  it('reads real imports only: not sample code in strings, not type-only imports', () => {
    const src = [
      "import { a } from '@proappstore/qa-spec';",
      "import type { T } from '@proappstore/sdk';",
      "import { type U } from '@proappstore/cli';",
      "export { b } from '../../compliance/src/x.js';",
      "export type { V } from '@proappstore/admin';",
      "const doc = `import { ProShell } from '@proappstore/sdk'`;",
      "const lazy = () => import('@proappstore/build-core');",
    ].join('\n');
    expect(runtimeImports('x.ts', src)).toEqual(['@proappstore/qa-spec', '../../compliance/src/x.js', '@proappstore/build-core']);
  });

  it('parses block and inline `paths:` lists, with comments', () => {
    expect([...triggerPackages("paths:\n  # why\n  - 'packages/a/**'   # a\n\n  - \"packages/b/**\"\n  - 'migrations/**'\nnext: 1\n  - 'packages/c/**'\n")])
      .toEqual(['a', 'b']);
    expect([...triggerPackages("    paths: ['packages/kb-host/**', 'packages/x/**'] # inline\n")]).toEqual(['kb-host', 'x']);
  });
});
