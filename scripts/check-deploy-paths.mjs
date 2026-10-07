#!/usr/bin/env node
// #322: a deploy workflow's `paths:` must list every workspace package its worker
// bundles. Otherwise a change confined to that package merges green and never
// deploys, and production runs a stale or mismatched bundle.
//
// For each deploy workflow below this script computes the set of workspace
// packages the deployed package bundles:
//   - every package its non-test source imports: by name (`@proappstore/x`) or by
//     a relative path into another package (`../../agent-teams/src/…`);
//   - every package a build step embeds (EMBEDS);
//   - transitively, whatever those packages import in turn.
// It then requires the workflow's `packages/*/**` triggers to be exactly the
// deployed package plus that set. A missing glob is a stale deploy; an extra one
// is an unrelated deploy on every change to that package. Type-only imports do
// not bundle and are ignored.
//
//   node scripts/check-deploy-paths.mjs        exit 1 with every mismatch
//
// Run by CI (.github/workflows/ci.yml, check job) and listed in CLAUDE.md's
// verification bar.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The TypeScript parser, not a regex: app templates and docs carry sample code in
// string literals (`import … from '@proappstore/sdk'`), which a regex would count
// as imports.
const ts = createRequire(import.meta.url)('typescript');

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagesDir = join(root, 'packages');
const workflowsDir = join(root, '.github/workflows');

/** Deploy workflow → the package it builds and deploys. Every deploy-*.yml must be here. */
export const DEPLOYS = {
  'deploy-backend.yml': 'backend',
  'deploy-host.yml': 'host',
  'deploy-mcp.yml': 'mcp',
  'deploy-admin.yml': 'admin',
  'deploy-agent-teams.yml': 'agent-teams',
  'deploy-kb-host.yml': 'kb-host',
  'deploy-qa-worker.yml': 'qa-worker',
};

/**
 * Packages a build step embeds without a source import. The backend's prebuild
 * (scripts/embed-data-worker.mjs) bundles packages/data-worker into the
 * gitignored src/generated/data-worker-bundle.ts at deploy time.
 */
export const EMBEDS = {
  backend: [{ pkg: 'data-worker', via: 'packages/backend/scripts/embed-data-worker.mjs' }],
};

const packageDirs = readdirSync(packagesDir).filter((d) => existsSync(join(packagesDir, d, 'package.json')));
const nameToDir = new Map(packageDirs.map((d) => [JSON.parse(readFileSync(join(packagesDir, d, 'package.json'), 'utf8')).name, d]));

const SOURCE = /\.(m?[jt]sx?)$/;
const TEST = /(\.test\.|\.spec\.|[\\/]__tests__[\\/]|[\\/]__fixtures__[\\/])/;
function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (SOURCE.test(entry) && !TEST.test(p)) out.push(p);
  }
  return out;
}

/** The module specifiers a file really imports at runtime: import/export declarations and import(), never type-only. */
export function runtimeImports(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const typeOnly = clause?.isTypeOnly || (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** Workspace packages one package's own source reaches directly, with a reason each. */
export function directDeps(pkg) {
  const deps = new Map();
  for (const file of sourceFiles(join(packagesDir, pkg, 'src'))) {
    for (const spec of runtimeImports(file, readFileSync(file, 'utf8'))) {
      let dep = null;
      if (spec.startsWith('@proappstore/')) {
        dep = nameToDir.get(spec.split('/').slice(0, 2).join('/')) ?? null;
      } else if (spec.startsWith('.')) {
        const target = relative(packagesDir, resolve(file, '..', spec));
        const top = target.split(sep)[0];
        if (!target.startsWith('..') && top !== pkg && packageDirs.includes(top)) dep = top;
      }
      if (dep && dep !== pkg && !deps.has(dep)) deps.set(dep, `${relative(root, file)} imports ${spec}`);
    }
  }
  for (const e of EMBEDS[pkg] ?? []) if (!deps.has(e.pkg)) deps.set(e.pkg, `${e.via} embeds it`);
  return deps;
}

/** Every workspace package `pkg` bundles, transitively, with the first reason found. */
export function bundledDeps(pkg) {
  const seen = new Map();
  const queue = [pkg];
  while (queue.length) {
    const cur = queue.shift();
    for (const [dep, why] of directDeps(cur)) {
      if (dep === pkg || seen.has(dep)) continue;
      seen.set(dep, cur === pkg ? why : `${why} (via ${cur})`);
      queue.push(dep);
    }
  }
  return seen;
}

/** The `packages/<name>/**` globs in a workflow's `paths:` lists (block or inline form; comments allowed). */
export function triggerPackages(yaml) {
  const items = [];
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)paths:\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].replace(/#.*/, '').trim();
    if (rest.startsWith('[')) { items.push(...rest.replace(/^\[|\]$/g, '').split(',')); continue; }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].replace(/#.*/, '');
      if (!line.trim()) continue; // blank or comment-only
      const item = line.match(/^\s*-\s*(.+)$/);
      if (!item) break; // the next key: the list is over
      items.push(item[1]);
    }
  }
  const out = new Set();
  for (const raw of items) {
    const m = raw.trim().replace(/^['"]|['"]$/g, '').match(/^packages\/([a-z0-9-]+)\/\*\*$/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Mismatches between one workflow's triggers (its YAML text) and what `pkg` bundles. */
export function problemsFor(workflow, pkg, yaml) {
  const problems = [];
  const triggers = triggerPackages(yaml);
  const deps = bundledDeps(pkg);
  const expected = new Set([pkg, ...deps.keys()]);
  for (const need of expected) {
    if (!triggers.has(need)) problems.push(`${workflow}: missing 'packages/${need}/**'${need === pkg ? ' (the package it deploys)' : ` — ${deps.get(need)}`}`);
  }
  for (const extra of triggers) {
    if (!expected.has(extra)) problems.push(`${workflow}: 'packages/${extra}/**' triggers it, but ${pkg} does not bundle ${extra} (an unrelated deploy)`);
  }
  return problems;
}

/** The whole repo: every deploy workflow against its package. */
export function checkDeployPaths() {
  const problems = [];
  const map = {};
  for (const f of readdirSync(workflowsDir).filter((n) => /^deploy-.*\.ya?ml$/.test(n))) {
    if (!DEPLOYS[f]) problems.push(`${f}: not in DEPLOYS — map it to the package it deploys`);
  }
  for (const [workflow, pkg] of Object.entries(DEPLOYS)) {
    const path = join(workflowsDir, workflow);
    if (!existsSync(path)) { problems.push(`${workflow}: listed in DEPLOYS but missing`); continue; }
    problems.push(...problemsFor(workflow, pkg, readFileSync(path, 'utf8')));
    map[workflow] = [...bundledDeps(pkg).keys()].sort();
  }
  return { problems, map };
}

/** For a change confined to `pkg`: the deploy workflows whose triggers it matches. */
export function deploysTriggeredBy(pkg) {
  return Object.keys(DEPLOYS).filter((w) => existsSync(join(workflowsDir, w)) && triggerPackages(readFileSync(join(workflowsDir, w), 'utf8')).has(pkg)).sort();
}

export { packageDirs };

function main() {
  const { problems, map } = checkDeployPaths();
  for (const [workflow, deps] of Object.entries(map)) console.log(`${workflow.padEnd(24)} ${DEPLOYS[workflow]} ← ${deps.join(', ') || '(no workspace packages)'}`);
  if (problems.length) {
    console.error(`\n✗ deploy path filters out of step with workspace imports:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\n✓ every deploy workflow triggers on exactly the workspace packages its worker bundles.');
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) main();
