import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

const NAME = 'Deploy workflow';

/** The platform's reusable deploy pipeline (#427), at any released tag. */
const REUSABLE = /uses:\s*proappstore-online\/platform\/\.github\/workflows\/app-deploy\.yml@\S+/;

/**
 * What an app workflow must never do (#264): deploy a Cloudflare script itself, or
 * read a platform credential. The same patterns the platform's own pipeline is
 * tested against (packages/admin/src/publish.test.ts).
 */
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/\bwrangler\b/, 'runs wrangler'],
  [/workers\/scripts/, 'calls the Cloudflare Workers scripts API'],
  [/\bpas-data-|\bpas-app-/, 'names a platform-managed Worker'],
  [/secrets\.(CLOUDFLARE|CF_|SESSION_SIGNING_KEY|INTERNAL_TOKEN|R2_)[A-Z0-9_]*/, 'reads a platform credential'],
];

/**
 * #427: an app deploys through the platform's reusable pipeline: its
 * `.github/workflows/deploy.yml` is a thin caller of
 * `proappstore-online/platform/.github/workflows/app-deploy.yml@app-deploy-v1`, so
 * a platform change reaches it without an edit and it cannot drift.
 *
 * Warn-only for now. `pas check` runs as every template app's prebuild, so a
 * failure here would stop the next deploy of every app still on a copied
 * workflow — most of the fleet when this shipped. The pipeline itself carries
 * the hard guard; this check names what each app has to change.
 */
export async function checkDeployWorkflow(source: FileSource): Promise<CheckResult> {
  const workflows: string[] = [];
  for await (const path of source.list()) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) workflows.push(path);
  }
  const findings: string[] = [];
  for (const path of workflows.sort()) {
    const text = (await source.read(path)) ?? '';
    for (const [re, what] of FORBIDDEN) {
      const m = re.exec(text);
      if (m) findings.push(`[SECURITY] ${path} ${what} (${m[0]})`);
    }
  }
  const deploy = await source.read('.github/workflows/deploy.yml');
  const suggestions = [
    'Replace .github/workflows/deploy.yml with the thin caller from proappstore-online/template-app: `uses: proappstore-online/platform/.github/workflows/app-deploy.yml@app-deploy-v1` with `secrets: inherit`.',
    'Per-app options are its inputs (e2e, marketing, source-maps, node-version), not edits to a copy.',
  ];
  if (deploy === null) {
    return { name: NAME, status: 'warn', detail: ['no .github/workflows/deploy.yml: a push deploys nothing', ...findings].join('; '), suggestions };
  }
  if (!REUSABLE.test(deploy)) findings.unshift('.github/workflows/deploy.yml is a copied pipeline, not a caller of the platform\'s reusable one, so platform fixes do not reach it');
  if (findings.length) return { name: NAME, status: 'warn', detail: findings.join('; '), suggestions };
  return { name: NAME, status: 'pass', detail: 'deploy.yml calls the platform\'s reusable pipeline; no workflow deploys a script or reads a platform credential' };
}
