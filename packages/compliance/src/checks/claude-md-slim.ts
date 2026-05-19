import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

/**
 * Per-repo CLAUDE.md is intended to be slim: the H1, a 1-line description,
 * dev/build/deploy commands, and a pointer to SKILLS.md. Anything that
 * belongs in the platform-wide guide (tech stack, brand, deploy mechanism,
 * mobile rules, paths) creates drift surface area and produces stale
 * instructions for AI agents.
 *
 * This check warns (does not fail) when the repo's CLAUDE.md looks
 * boilerplate-heavy. Warn-only so a contributor mid-edit isn't blocked,
 * and so existing repos that haven't been swept yet don't 404 their CI.
 *
 * The SKILLS.md convention section is the source-of-truth for what
 * counts as boilerplate; this check is the enforcement arm.
 */
const NAME = 'CLAUDE.md is slim (no platform boilerplate)';

const SKILLS_URL =
  'https://raw.githubusercontent.com/proappstore-online/proappstore/main/SKILLS.md';

// Section headers that should NOT appear in a per-repo CLAUDE.md — they
// belong in SKILLS.md. Match leading-`##` headers, case-insensitive.
const BOILERPLATE_HEADERS = [
  'platform: proappstore',
  'platform: freeappstore',
  'platform: freegamestore',
  'tech stack',
  'brand guidelines',
  'brand', // bare "## Brand"
  'rules', // sweeping platform rules; per-repo exceptions can be a "## Notes"
  'platform docs',
  'platform docs & publishing',
  'publishing',
];

// Anything over this many non-blank lines is suspiciously verbose for a
// slim per-repo file. Tier-3 cases (legitimate per-repo docs like setup
// instructions, architecture diagrams) can grow naturally; this is a
// warning, not a hard cap.
const SOFT_LINE_LIMIT = 60;

export async function checkClaudeMdSlim(source: FileSource): Promise<CheckResult> {
  const body = await source.read('CLAUDE.md');
  if (body == null) {
    // No CLAUDE.md is fine — agents fall back to SKILLS.md via README/docs.
    return { name: NAME, status: 'pass', detail: 'no CLAUDE.md present' };
  }

  const offendingHeaders: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.split('\n')) {
    const m = /^#{2,}\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const text = m[1]!.toLowerCase().replace(/:$/, '');
    for (const banned of BOILERPLATE_HEADERS) {
      if (text === banned || text.startsWith(`${banned} `) || text.startsWith(`${banned}:`)) {
        if (!seen.has(banned)) {
          offendingHeaders.push(m[1]!);
          seen.add(banned);
        }
        break;
      }
    }
  }

  const nonBlankLines = body.split('\n').filter((l) => l.trim().length > 0).length;
  const hasSkillsUrl = body.includes(SKILLS_URL);

  const issues: string[] = [];
  if (offendingHeaders.length > 0) {
    issues.push(`platform-boilerplate sections: ${offendingHeaders.join(', ')}`);
  }
  if (nonBlankLines > SOFT_LINE_LIMIT) {
    issues.push(`${nonBlankLines} non-blank lines (soft limit ${SOFT_LINE_LIMIT})`);
  }
  if (!hasSkillsUrl) {
    issues.push('missing SKILLS.md pointer');
  }

  if (issues.length === 0) {
    return {
      name: NAME,
      status: 'pass',
      detail: `${nonBlankLines} non-blank lines, SKILLS.md referenced, no banned sections`,
    };
  }

  return {
    name: NAME,
    status: 'warn',
    detail: issues.join('; '),
    suggestions: [
      'Per-repo CLAUDE.md should hold only what is unique to this repo (description, dev/build/deploy, repo-specific setup).',
      'Anything platform-wide (tech stack, brand, mobile rules, deploy flow) belongs in SKILLS.md instead.',
      `See the "Per-repo CLAUDE.md convention" section of SKILLS.md: ${SKILLS_URL}`,
    ],
  };
}
