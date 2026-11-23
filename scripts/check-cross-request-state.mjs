#!/usr/bin/env node
// #655 (#653): a Worker isolate serves many requests, and a promise created by one
// request and awaited by another fails once the first request ends — the 1101s
// of #616. Module scope is shared by every request, so it may hold plain data
// (with a TTL), never a promise.
//
// Over the source of every deployed Worker and every workspace package it
// bundles (DEPLOYS + bundledDeps from check-deploy-paths.mjs), this fails on a
// module-scope declaration that:
//   - declares a type holding a Promise (`let p: Promise<T>`,
//     `const m: Map<string, Promise<T>>`, `const m = new Map<string, Promise<T>>()`);
//     a function type that returns one holds none;
//   - or is a `let`/`var` assigned anywhere in the file with `??=` (the
//     memoise-a-promise shape).
// The TypeScript parser, not a regex: code inside template strings is not code.
//
// A deliberate case is allowed with a comment on the line above the declaration:
//   // cross-request-ok: <why this cannot be awaited across requests>
//
//   node scripts/check-cross-request-state.mjs     exit 1 with every finding
//
// Run by CI (.github/workflows/ci.yml, check job) and listed in CLAUDE.md's
// verification bar.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DEPLOYS, bundledDeps, sourceFiles } from './check-deploy-paths.mjs';

const ts = createRequire(import.meta.url)('typescript');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const ALLOW = /\/\/\s*cross-request-ok:\s*\S/;

/** A `Promise<…>` reference in a type, outside a function's signature (a function returning one is fine). */
function holdsPromise(type) {
  if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type) || ts.isMethodSignature(type) || ts.isCallSignatureDeclaration(type)) return false;
  if (ts.isTypeReferenceNode(type) && type.typeName.getText() === 'Promise') return true;
  return ts.forEachChild(type, (child) => (holdsPromise(child) ? true : undefined)) ?? false;
}

/** Findings for one file's source text: `line: name — why`. */
export function findCrossRequestState(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const nullishAssigned = new Set();
  (function visit(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken && ts.isIdentifier(node.left)) {
      nullishAssigned.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  })(sf);

  const findings = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const mutable = !(stmt.declarationList.flags & ts.NodeFlags.Const);
    const leading = (ts.getLeadingCommentRanges(text, stmt.getFullStart()) ?? []).map((r) => text.slice(r.pos, r.end));
    if (leading.length && ALLOW.test(leading[leading.length - 1])) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      const line = sf.getLineAndCharacterOfPosition(decl.getStart()).line + 1;
      const init = decl.initializer;
      const typeArgs = init && ts.isNewExpression(init) ? (init.typeArguments ?? []) : [];
      if ((decl.type && holdsPromise(decl.type)) || typeArgs.some(holdsPromise)) {
        findings.push(`${line}: ${name} — module-scope state holding a Promise`);
      } else if (mutable && nullishAssigned.has(name)) {
        findings.push(`${line}: ${name} — module-scope let/var assigned with ??=`);
      }
    }
  }
  return findings;
}

/** Packages whose code runs in a Worker: every deployed package and everything it bundles. */
export function workerPackages() {
  const pkgs = new Set();
  for (const pkg of Object.values(DEPLOYS)) {
    pkgs.add(pkg);
    for (const dep of bundledDeps(pkg).keys()) pkgs.add(dep);
  }
  return [...pkgs].sort();
}

/** The whole repo: every finding as `path:line: name — why`. */
export function checkCrossRequestState() {
  const problems = [];
  for (const pkg of workerPackages()) {
    for (const file of sourceFiles(join(root, 'packages', pkg, 'src'))) {
      for (const f of findCrossRequestState(file, readFileSync(file, 'utf8'))) problems.push(`${relative(root, file)}:${f}`);
    }
  }
  return problems;
}

function main() {
  const problems = checkCrossRequestState();
  if (problems.length) {
    console.error(`✗ module-scope state that can be awaited across requests (#655):\n  ${problems.join('\n  ')}\n\nCache the resolved value, not the promise. If it is deliberate, put\n  // cross-request-ok: <reason>\non the line above the declaration.`);
    process.exit(1);
  }
  console.log(`✓ no module-scope promises in ${workerPackages().join(', ')}.`);
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) main();
