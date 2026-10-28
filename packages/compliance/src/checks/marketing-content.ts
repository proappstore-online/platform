import type { FileSource } from '../lib/file-source.js';
import { stripCommentsOnly } from '../lib/strip.js';
import type { CheckResult, CheckStatus } from '../types.js';

/**
 * #498: an app's `marketing/` site must not go live with the template's copy.
 *
 * `marketing/src/site.ts` is the whole content contract (#398). The template ships it with
 * placeholder text, an empty contact and no imagery, and nothing flagged an app that published it
 * untouched. This reads that one file and reports what is still the template's:
 *
 *   template-copy     the headline, summary, benefits or how-it-works steps are the template's words
 *   operator-contact  the operator named on the legal pages is the default `The <name> team`,
 *                     there is no contactEmail, or the Terms name no governing law
 *   imagery           no hero image and no screenshots; without a hero the social preview
 *                     falls back to the app icon
 *   placeholder       an `APPNAME` the scaffold never replaced
 *
 * Every rule is `warn` in this release. RULE_SEVERITY is where "block the first activation" is
 * decided later; that needs the same signal in the deploy step, which this check only provides.
 * The check never invents content: it only recognises the template's own strings, so a site with
 * its own (even short) copy passes.
 */

export type MarketingRule = 'template-copy' | 'operator-contact' | 'imagery' | 'placeholder';

export const RULE_SEVERITY: Record<MarketingRule, CheckStatus> = {
  'template-copy': 'warn',
  'operator-contact': 'warn',
  imagery: 'warn',
  placeholder: 'warn',
};

const SITE = 'marketing/src/site.ts';

/** The template's own sentences (template-app `marketing/src/site.ts`), the ones an owner is meant to replace. */
const TEMPLATE_SUMMARY = /^Describe in one or two sentences/i;
const TEMPLATE_BENEFIT_TITLE = /^(?:First|Second|Third) benefit$/i;
const TEMPLATE_BENEFIT_BODY = /^(?:What someone can do with .+ that matters to them\.|Another concrete outcome, in plain words\.|A third reason to try it\.)$/;
const TEMPLATE_STEP = /^(?:Describe the first thing a new user does\.|Go to .+ in any modern browser\. It installs like an app on phone and desktop\.|Use your GitHub or Google account\. No new password to remember\.)$/;

/** The value of a top-level `key: 'literal'` field, or null. Escapes are kept as written. */
function literal(src: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`).exec(src);
  return m ? m[2]! : null;
}

/** The text between the brackets that follow `key: [`, or null. */
function arrayBody(src: string, key: string): string | null {
  const start = new RegExp(`(?:^|\\n)\\s*${key}:\\s*\\[`).exec(src);
  if (!start) return null;
  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') depth--;
    i++;
  }
  return depth === 0 ? src.slice(from, i - 1) : null;
}

/** Every `field: 'literal'` inside an array's text. */
function fields(body: string, key: string): string[] {
  return [...body.matchAll(new RegExp(`${key}:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1`, 'g'))].map((m) => m[2]!);
}

interface Finding {
  rule: MarketingRule;
  what: string;
}

export function marketingFindings(raw: string): Finding[] {
  const src = stripCommentsOnly(raw);
  const out: Finding[] = [];
  const add = (rule: MarketingRule, what: string) => out.push({ rule, what });

  const name = literal(src, 'name') ?? '';
  const appId = literal(src, 'appId') ?? '';

  if (/APPNAME/.test(src)) add('placeholder', 'APPNAME was never replaced');

  const headline = literal(src, 'headline');
  if (headline !== null && (headline.trim() === '' || headline === `Explore ${name}.` || headline === `Explore ${appId}.`)) add('template-copy', `headline "${headline}"`);
  const summary = literal(src, 'summary');
  if (summary !== null && (summary.trim() === '' || TEMPLATE_SUMMARY.test(summary))) add('template-copy', 'summary is the template sentence');

  const benefits = arrayBody(src, 'benefits');
  if (benefits !== null) {
    const titles = fields(benefits, 'title');
    const bodies = fields(benefits, 'body');
    const stale = titles.filter((t) => TEMPLATE_BENEFIT_TITLE.test(t)).length + bodies.filter((b) => TEMPLATE_BENEFIT_BODY.test(b)).length;
    if (titles.length === 0) add('template-copy', 'no benefits');
    else if (stale > 0) add('template-copy', `${titles.filter((t) => TEMPLATE_BENEFIT_TITLE.test(t)).length} of ${titles.length} benefits are the template's`);
  }
  const steps = arrayBody(src, 'howItWorks');
  if (steps !== null) {
    const stale = fields(steps, 'body').filter((b) => TEMPLATE_STEP.test(b)).length;
    if (stale > 0) add('template-copy', `${stale} how-it-works step${stale === 1 ? '' : 's'} are the template's`);
  }

  const owner = literal(src, 'owner');
  if (owner !== null && owner.trim() === '') add('operator-contact', 'no operator named on the legal pages');
  else if (owner !== null && (owner === `The ${name} team` || owner === `The ${appId} team`)) add('operator-contact', `operator "${owner}" is the default`);
  if ((literal(src, 'contactEmail') ?? '').trim() === '') add('operator-contact', 'no contactEmail on the legal pages');
  if ((literal(src, 'governingLaw') ?? '').trim() === '') add('operator-contact', 'no governing law in the Terms');

  const hero = /(?:^|\n)\s*heroImage:\s*null\b/.test(src) || !/(?:^|\n)\s*heroImage:/.test(src);
  const screenshots = arrayBody(src, 'screenshots');
  const noShots = screenshots === null || screenshots.trim() === '';
  if (hero && noShots) add('imagery', 'no hero image and no screenshots; the social preview is the app icon');
  else if (hero) add('imagery', 'no hero image; the social preview is the app icon');
  else if (noShots) add('imagery', 'no screenshots');

  return out;
}

const ORDER: readonly MarketingRule[] = ['placeholder', 'template-copy', 'operator-contact', 'imagery'];
const SEVERITY_ORDER: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2 };

export async function checkMarketingContent(source: FileSource): Promise<CheckResult> {
  const name = 'Marketing site content';
  const raw = await source.read(SITE);
  if (raw === null) return { name, status: 'pass', detail: 'no marketing site' };
  const findings = marketingFindings(raw);
  if (findings.length === 0) return { name, status: 'pass', detail: `${SITE}: no template copy, operator and contact set, imagery present` };
  let status: CheckStatus = 'pass';
  const parts: string[] = [];
  for (const rule of ORDER) {
    const hits = findings.filter((f) => f.rule === rule);
    if (hits.length === 0) continue;
    if (SEVERITY_ORDER[RULE_SEVERITY[rule]] > SEVERITY_ORDER[status]) status = RULE_SEVERITY[rule];
    parts.push(`${rule}: ${hits.map((h) => h.what).join('; ')}`);
  }
  return {
    name,
    status,
    detail: `${SITE}: ${parts.join(' | ')}`,
    suggestions: [
      'Edit marketing/src/site.ts: your own headline, summary and benefits; the operator and a contact email for the legal pages; a hero image or screenshots in marketing/public/assets/.',
      'Keep claims true: no invented pricing, testimonials or customer counts. Leave an optional section empty and it is left out.',
    ],
  };
}
