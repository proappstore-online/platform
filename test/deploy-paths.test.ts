import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs CI script, no type declarations
import { bundledDeps, checkDeployPaths, deploysTriggeredBy, packageDirs, problemsFor, runtimeImports, triggerPackages, triggerPaths } from '../scripts/check-deploy-paths.mjs';

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
      'build-core': ['deploy-admin.yml', 'deploy-backend.yml', 'deploy-kb-host.yml', 'deploy-mcp.yml'],
      'qa-spec': ['deploy-backend.yml', 'deploy-host.yml', 'deploy-qa-worker.yml'],
      compliance: ['deploy-admin.yml', 'deploy-agent-teams.yml', 'deploy-backend.yml', 'deploy-mcp.yml'], // the lettermark derivation (#505)
      'data-worker': ['deploy-backend.yml'],
      // Bundled by no deployed worker: their changes deploy nothing (sdk and cli are published by publish.yml).
      // runtime-tests is an explicit backend pre-deploy gate, so changes must deploy it.
      sdk: [], cli: [], 'mcp-registry': [], 'runtime-tests': ['deploy-backend.yml'],
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
      - 'packages/runtime-tests/**'
      - 'pnpm-lock.yaml'
      - 'package.json'
      - 'pnpm-workspace.yaml'
`;
    expect(problemsFor('deploy-backend.yml', 'backend', backendMissingQaSpec)).toEqual([
      expect.stringMatching(/missing 'packages\/qa-spec\/\*\*' — packages\/backend\/src\/routes\/qa\.ts imports @proappstore\/qa-spec/),
    ]);
    const hostWithSdk = "on:\n  push:\n    paths: ['packages/host/**', 'packages/qa-spec/**', 'packages/sdk/**']\n";
    expect(problemsFor('deploy-host.yml', 'host', hostWithSdk)).toEqual([expect.stringMatching(/'packages\/sdk\/\*\*' triggers it, but host does not bundle sdk/)]);
  });

  it('counts relative imports into another package and build-time embeds, transitively', () => {
    expect([...bundledDeps('mcp').keys()].sort()).toEqual(['agent-teams', 'build-core', 'compliance']);
    expect(bundledDeps('mcp').get('agent-teams')).toMatch(/\.\.\/\.\.\/agent-teams\/src\/recipes\.js/);
    // The backend bundles the data worker several ways: the build embeds its bundle, (#455) the migration lint imports the shared
    // SQL tokenizer from its source, and (#508) registration and the lint import the `_pas_` write checker. Any reason is a bundle.
    expect(bundledDeps('backend').get('data-worker')).toMatch(/data-worker\/src\/(sql-statements|reserved-tables)\.js|embed-data-worker\.mjs embeds it/);
  });

  it('reads real imports only: not sample code in strings, not type-only imports', () => {
    const src = [
      "import { a } from '@proappstore/qa-spec';",
      "import type { T } from '@proappstore/sdk';",
      "import { type U } from '@proappstore/cli';",
      "export { b } from '../../compliance/src/x.js';",
      "export type { V } from '@proappstore/admin';",
      "const doc = `import { AppShell } from '@proappstore/sdk'`;",
      "const lazy = () => import('@proappstore/build-core');",
    ].join('\n');
    expect(runtimeImports('x.ts', src)).toEqual(['@proappstore/qa-spec', '../../compliance/src/x.js', '@proappstore/build-core']);
  });

  it('parses block and inline `paths:` lists, with comments', () => {
    expect([...triggerPackages("paths:\n  # why\n  - 'packages/a/**'   # a\n\n  - \"packages/b/**\"\n  - 'migrations/**'\nnext: 1\n  - 'packages/c/**'\n")])
      .toEqual(['a', 'b']);
    expect([...triggerPackages("    paths: ['packages/kb-host/**', 'packages/x/**'] # inline\n")]).toEqual(['kb-host', 'x']);
  });

  it('requires backend runtime-gate inputs to trigger the deploy workflow', () => {
    const backendWorkflow = readFileSync('.github/workflows/deploy-backend.yml', 'utf8');
    const gatePaths = [
      'packages/runtime-tests/**',
      'pnpm-lock.yaml',
      'package.json',
      'pnpm-workspace.yaml',
    ];
    for (const gatePath of gatePaths) {
      expect(triggerPaths(backendWorkflow)).toContain(gatePath);
      const withoutGatePath = backendWorkflow.replace(`      - '${gatePath}'\n`, '');
      expect(problemsFor('deploy-backend.yml', 'backend', withoutGatePath)).toContain(
        `deploy-backend.yml: missing '${gatePath}' required by its pre-deploy gate`,
      );
    }
  });
});
