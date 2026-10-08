#!/usr/bin/env node
// #300: each admin-console security regression must fail against a deliberately
// weakened gate. For every mutation below this script weakens one gate in the
// source, runs the runtime suite that guards it, requires that run to FAIL, and
// restores the file (also on Ctrl-C). An unmutated baseline must pass first.
//
//   node scripts/gate-mutations.mjs            # every mutation
//   node scripts/gate-mutations.mjs step-up    # the ones whose name contains "step-up"
//
// Not part of CI: a full run takes several minutes of workerd time. Run it after
// changing an operator gate or one of these suites.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const MATRIX = ['vitest.backend.ts', 'test/backend/operator-matrix.test.ts'];

const MUTATIONS = [
  {
    name: 'admin-gate: any signed-in caller is admitted',
    file: 'backend/src/lib/operator-audit-marks.ts',
    find: 'if (!(await holdsOperatorAdminRole(c.env.DB, appId, user))) {',
    replace: 'if (false) {',
    suite: MATRIX,
  },
  {
    name: 'admin-gate: any app role counts as the declared admin role',
    file: 'backend/src/lib/operator-audit-marks.ts',
    find: 'AND r.role_name = declared.value)',
    replace: ')',
    suite: MATRIX,
  },
  {
    name: 'owner-only: the audit trail opens to a declared admin',
    file: 'backend/src/routes/operator-audit.ts',
    find: 'const owner = await requireOperatorOwner(c, appId);\n  const contract',
    replace: 'const owner = await requireOperatorAccess(c, appId);\n  const contract',
    suite: MATRIX,
  },
  {
    name: 'identity (#272): any provider\'s login is a role subject',
    file: 'backend/src/lib/role-subject.ts',
    find: "return user.id.startsWith('gh:') && user.login ? user.login : user.id;",
    replace: 'return user.login ? user.login : user.id;',
    suite: MATRIX,
  },
  {
    name: 'step-up: a stale session passes',
    file: 'backend/src/lib/auth.ts',
    find: 'if (!(age <= maxAge) || wrongMethod || wrongRp) {',
    replace: 'if (false) {',
    suite: MATRIX,
  },
  {
    name: 'field-leak: rows leave unprojected',
    file: 'backend/src/routes/operator.ts',
    find: 'return Object.fromEntries(keys.map(({ key }) => [key, row[key] ?? null]));',
    replace: 'return { ...row, ...Object.fromEntries(keys.map(({ key }) => [key, row[key] ?? null])) };',
    suite: MATRIX,
  },
  {
    name: 'field-leak (#294): no field is sensitive',
    file: 'backend/src/lib/sensitive-fields.ts',
    find: 'return sensitiveMatch(name) !== null;',
    replace: 'return false;',
    suite: ['vitest.backend.ts', 'test/backend/operator-view.test.ts', '-t', '#294'],
  },
  {
    name: 'csrf: the session cookie is a credential',
    file: 'backend/src/lib/auth.ts',
    find: "const header = c.req.header('Authorization');\n  if (!header?.startsWith('Bearer ')) {\n    throw new HttpError('missing bearer token', 401);",
    replace: "const header = c.req.header('Authorization') ?? `Bearer ${/pas_session=([^;]+)/.exec(c.req.header('Cookie') ?? '')?.[1] ?? ''}`;\n  if (!header?.startsWith('Bearer ')) {\n    throw new HttpError('missing bearer token', 401);",
    suite: MATRIX,
  },
  {
    name: 'csrf: an app page reaches the operator view',
    file: 'backend/src/lib/operator-audit-marks.ts',
    find: "if (c.req.header(APP_CONTEXT_HEADER) !== undefined) throw",
    replace: 'if (false) throw',
    suite: MATRIX,
  },
  {
    // Proves the CORS gate only: the preflight test and the ACAO assertion on the
    // query-string test fail. That the cookie or a query token is no credential
    // is proved by the 'session cookie' mutation above, not by this one.
    name: 'csrf: any origin gets a CORS grant',
    file: 'backend/src/index.ts',
    find: "if (!origin) return null;\n  try {",
    replace: "if (!origin) return null;\n  return origin;\n  try {",
    suite: MATRIX,
  },
  {
    name: 'csrf (host): cross-site mutations are forwarded',
    file: 'host/src/auth-handler.ts',
    find: 'export function isSameOriginMutation(request: Request): boolean {\n',
    replace: 'export function isSameOriginMutation(request: Request): boolean {\n  return true;\n',
    suite: ['vitest.host.ts', 'test/host/operator-csrf.test.ts'],
  },
];

const run = (args) => spawnSync('npx', ['vitest', 'run', '--config', ...args], { cwd: pkg('runtime-tests'), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
// The totals line (`Tests  2 failed | 18 passed (20)`), not the `Failed Tests 2 ⎯⎯⎯` banner.
const summary = (r) => (`${r.stdout}${r.stderr}`.match(/^\s*Tests\s+\d+ (?:failed|passed)[^\n]*/gm) ?? ['(no summary)']).at(-1).trim();
/**
 * A mutation is caught only by a failed assertion. A run that fails any other
 * way — a timeout on a loaded machine, a crash, a compile error — proves
 * nothing about the gate, so it is inconclusive and fails the script.
 */
const verdict = (r) => {
  if (r.status === 0) return 'SURVIVED';
  const out = `${r.stdout}${r.stderr}`;
  return /AssertionError/.test(out) && !/Test timed out/.test(out) ? 'caught' : 'INCONCLUSIVE';
};

const filter = process.argv[2];
const selected = MUTATIONS.filter((m) => !filter || m.name.includes(filter));
let restore = null;
process.on('SIGINT', () => { restore?.(); process.exit(130); });

if (!selected.length) { console.error(`No mutation matches "${filter}".`); process.exit(1); }

// Every target must match its file exactly once before anything runs (#341): a
// gate refactor that moves a target fails here, naming each mutation and file,
// instead of stopping the run halfway with the later mutations never tried.
const drifted = selected.filter((m) => readFileSync(pkg(m.file), 'utf8').split(m.find).length !== 2);
for (const m of drifted) console.error(`DRIFTED       ${m.name} — its target text is not in packages/${m.file} exactly once`);
if (drifted.length) {
  console.error(`\n${drifted.length} mutation target(s) no longer match the code: update their \`find\` in scripts/gate-mutations.mjs.`);
  process.exit(1);
}

const suites = [...new Map(selected.map((m) => [m.suite.join(' '), m.suite])).values()];
for (const suite of suites) {
  const r = run(suite);
  console.log(`baseline ${suite.slice(1).join(' ')}: ${r.status === 0 ? 'pass' : 'FAIL'} — ${summary(r)}`);
  if (r.status !== 0) { console.error('The unmutated suite must pass first.'); process.exit(1); }
}

let survivors = 0;
let inconclusive = 0;
for (const m of selected) {
  const path = pkg(m.file);
  const original = readFileSync(path, 'utf8');
  restore = () => writeFileSync(path, original);
  writeFileSync(path, original.replace(m.find, m.replace));
  let r;
  try { r = run(m.suite); } finally { restore(); restore = null; }
  const v = verdict(r);
  if (v === 'SURVIVED') survivors += 1;
  if (v === 'INCONCLUSIVE') inconclusive += 1;
  console.log(`${v.padEnd(12)}  ${m.name} — ${summary(r)}`);
}
if (survivors) console.log(`\n${survivors} weakened gate(s) went unnoticed.`);
if (inconclusive) console.log(`\n${inconclusive} run(s) failed without an assertion failure (timeout or crash): re-run them.`);
if (!survivors && !inconclusive) console.log(`\nAll ${selected.length} weakened gates were caught by a failed assertion.`);
process.exit(survivors || inconclusive ? 1 : 0);
