/**
 * Stable check IDs and their mapping to the public Application Standard (#166).
 *
 * Every compliance check — source-side and live — has a kebab-case id that is
 * never renamed, one or more clause ids from docs/standard, and a statement of
 * how much of those clauses it proves. The runner decorates each CheckResult
 * with this so `pas check`, CI output and the publish gate can cite the exact
 * public clause a failure breaches.
 *
 * The standard's clause ids and URLs are the source of truth
 * (docs/standard/standard.json); clause-map.test.ts fails if a mapped clause
 * does not exist there or if docs/standard/compliance-checks.json (the
 * published copy of this table) drifts from it.
 *
 * Keep this file dependency-free: scripts/build-compliance-map.mjs imports it
 * directly to publish the JSON.
 */
import type { CheckAutomation, CheckResult, EvidenceClass, StandardCitation } from './types.js';

export const STANDARD_BASE_URL = 'https://docs.proappstore.online/standard/';

const CHAPTER_PAGES: Record<string, string> = {
  STACK: 'stack', AUTH: 'auth', DATA: 'data', INT: 'integrations', UI: 'ui', OPS: 'ops',
};

/** Public URL of a clause: `<base>/<chapter page>/#<id in lower case>`. */
export function clauseUrl(clauseId: string): string {
  const m = /^PAS-([A-Z]+)-\d{3}$/.exec(clauseId);
  const page = m ? CHAPTER_PAGES[m[1]!] : undefined;
  if (!page) throw new Error(`unknown clause id ${clauseId}`);
  return `${STANDARD_BASE_URL}${page}/#${clauseId.toLowerCase()}`;
}

export interface CheckMeta {
  /** Stable id. Never renamed; a retired check keeps its id in `RETIRED_CHECK_IDS`. */
  id: string;
  /** The `name` the check emits on its results (the historical, human-facing label). */
  name: string;
  /** Clause ids this check evidences, most specific first. */
  clauses: string[];
  automation: CheckAutomation;
  evidenceClass: EvidenceClass;
  /** `apps`, `games` or `all` — which project types the check is meaningful for. */
  scope: 'apps' | 'games' | 'all';
  /** What the check does NOT prove, or a known caveat. Shown in docs, not in CLI output. */
  limits: string;
  /** True for the live-URL audit variants. */
  live?: boolean;
}

export const CHECKS: readonly CheckMeta[] = [
  { id: 'license-mit', name: 'MIT License', clauses: ['PAS-UI-022'], automation: 'partial', evidenceClass: 'documentation', scope: 'all',
    limits: 'Assumes MIT while the Pro tier permits proprietary source; a proprietary licence records this as a known platform inconsistency, not an app defect.' },
  { id: 'no-env-production', name: 'No .env.production', clauses: ['PAS-OPS-006', 'PAS-STACK-015', 'PAS-UI-022'], automation: 'partial', evidenceClass: 'configuration', scope: 'all',
    limits: 'Only the one file name; keys in source, in VITE_* variables, or in other .env files are not detected.' },
  { id: 'no-placeholders', name: 'No template placeholders', clauses: ['PAS-UI-020'], automation: 'full', evidenceClass: 'source', scope: 'all',
    limits: 'Detects the literal APPNAME token only.' },
  { id: 'no-tracking', name: 'No tracking SDKs', clauses: ['PAS-UI-022', 'PAS-STACK-021', 'PAS-OPS-018'], automation: 'partial', evidenceClass: 'source', scope: 'all',
    limits: 'A fixed list of known trackers; a self-hosted or unlisted tracker is not detected.' },
  { id: 'brand-fonts', name: 'Brand fonts present', clauses: ['PAS-UI-001', 'PAS-STACK-022'], automation: 'partial', evidenceClass: 'source', scope: 'all',
    limits: 'Presence of the font names in CSS/HTML; not that they are actually applied.' },
  { id: 'brand-tokens', name: 'Brand tokens defined', clauses: ['PAS-UI-001', 'PAS-STACK-022'], automation: 'partial', evidenceClass: 'source', scope: 'all',
    limits: 'That the canonical tokens are defined; not that the app uses them instead of hard-coded colours.' },
  { id: 'no-brand-overrides', name: 'No brand overrides', clauses: ['PAS-UI-001', 'PAS-STACK-022'], automation: 'partial', evidenceClass: 'source', scope: 'all',
    limits: 'Common override forms only; the banned alias names themselves are caught by the platform design-system lint, not here.' },
  { id: 'no-scroll', name: 'No scroll (games only)', clauses: ['PAS-UI-009'], automation: 'partial', evidenceClass: 'source', scope: 'games',
    limits: 'Games only; static CSS anti-patterns. Real document scroll is measured only in a browser.' },
  { id: 'viewport-support', name: 'Viewport support', clauses: ['PAS-UI-008'], automation: 'partial', evidenceClass: 'configuration', scope: 'all',
    limits: 'That orientation and min_viewport_width are declared; not that the layout works at that width.' },
  { id: 'unsafe-vh', name: 'No unsafe 100vh', clauses: ['PAS-UI-010'], automation: 'partial', evidenceClass: 'source', scope: 'all',
    limits: '100vh in source only; safe-area padding and the iOS first-load scroll need a device.' },
  { id: 'accessibility-static', name: 'Accessibility static', clauses: ['PAS-UI-004'], automation: 'partial', evidenceClass: 'source', scope: 'all',
    limits: 'Missing alt text, unnamed buttons and unlabeled text controls only. Contrast, focus order, keyboard traps and rendered ARIA need a browser and a person (PAS-UI-005, 006, 023).' },
  { id: 'html-meta', name: 'HTML meta tags', clauses: ['PAS-UI-008', 'PAS-UI-020'], automation: 'partial', evidenceClass: 'configuration', scope: 'all',
    limits: 'Presence of lang, viewport, title and preview images; not the viewport\'s content (user-scalable=no is PAS-UI-007, a manual check).' },
  { id: 'pwa-meta', name: 'PWA meta tags', clauses: ['PAS-UI-020'], automation: 'partial', evidenceClass: 'configuration', scope: 'all',
    limits: 'The iOS install metas only; install behaviour is verified on a device.' },
  { id: 'pwa-offline', name: 'PWA offline correctness', clauses: ['PAS-UI-018', 'PAS-UI-019'], automation: 'partial', evidenceClass: 'configuration', scope: 'all',
    limits: 'That a service worker is registered and the workbox config is sane; not that /.pas/* or authenticated responses stay uncached at runtime.' },
  { id: 'pwa-manifest', name: 'PWA manifest', clauses: ['PAS-UI-020'], automation: 'partial', evidenceClass: 'configuration', scope: 'all',
    limits: 'The four required fields; the rest of the manifest is reviewed manually.' },
  { id: 'pwa-maskable-icon', name: 'PWA maskable icon', clauses: ['PAS-UI-020'], automation: 'full', evidenceClass: 'configuration', scope: 'all',
    limits: 'Declaration only; the icon\'s safe zone is not rendered.' },
  { id: 'store-link', name: 'Store link', clauses: ['PAS-UI-001', 'PAS-STACK-022'], automation: 'full', evidenceClass: 'source', scope: 'all',
    limits: 'That the domain appears somewhere under web/src; not that it is visible.' },
  { id: 'dark-mode', name: 'Dark mode support', clauses: ['PAS-UI-002'], automation: 'partial', evidenceClass: 'source', scope: 'apps',
    limits: 'Warn-only signal detection; the storage-key split (fas:theme vs stores-theme) and dark-scheme contrast are manual.' },
  { id: 'bundle-size', name: 'Bundle size', clauses: ['PAS-UI-021', 'PAS-STACK-024'], automation: 'partial', evidenceClass: 'process', scope: 'all',
    limits: 'Warns when web/dist is unbuilt; measures the largest JS chunk only.' },
  { id: 'claude-md-slim', name: 'CLAUDE.md is slim (no platform boilerplate)', clauses: ['PAS-STACK-001'], automation: 'partial', evidenceClass: 'documentation', scope: 'all',
    limits: 'Documentation hygiene of the scaffold\'s agent guide; warn-only and not a security signal.' },
  // Live-URL audit (auditLive) — a post-publish subset run against the deployed app.
  { id: 'reachable', name: 'Reachable', clauses: ['PAS-OPS-010'], automation: 'partial', evidenceClass: 'runtime', scope: 'all', live: true,
    limits: 'HTTP 200 from the live URL; not that the app works (that is the post-deploy smoke).' },
  { id: 'brand-fonts-live', name: 'Brand fonts (live)', clauses: ['PAS-UI-001'], automation: 'partial', evidenceClass: 'runtime', scope: 'all', live: true,
    limits: 'The fonts link in the served HTML only.' },
  { id: 'bundle-size-live', name: 'Bundle size (live)', clauses: ['PAS-UI-021'], automation: 'partial', evidenceClass: 'runtime', scope: 'all', live: true,
    limits: 'HEAD size of the main bundle only.' },
  { id: 'pwa-manifest-live', name: 'PWA manifest (live)', clauses: ['PAS-UI-020'], automation: 'partial', evidenceClass: 'runtime', scope: 'all', live: true,
    limits: 'Manifest reachable and minimally valid.' },
  { id: 'no-tracking-live', name: 'No tracking SDKs (live)', clauses: ['PAS-UI-022', 'PAS-STACK-021'], automation: 'partial', evidenceClass: 'runtime', scope: 'all', live: true,
    limits: 'Known trackers in the served HTML and fetched scripts only.' },
  { id: 'unsafe-vh-live', name: 'No unsafe 100vh (live)', clauses: ['PAS-UI-010'], automation: 'partial', evidenceClass: 'runtime', scope: 'all', live: true,
    limits: 'Served CSS text only.' },
];

/** Ids that once existed; kept so a consumer storing results by id never sees a reused meaning. */
export const RETIRED_CHECK_IDS: readonly string[] = [];

const BY_NAME = new Map(CHECKS.map((m) => [m.name, m]));
const BY_ID = new Map(CHECKS.map((m) => [m.id, m]));

export function getCheckMeta(id: string): CheckMeta | undefined {
  return BY_ID.get(id);
}

export function getCheckMetaForName(name: string): CheckMeta | undefined {
  return BY_NAME.get(name);
}

export function citationsFor(meta: CheckMeta): StandardCitation[] {
  return meta.clauses.map((clauseId) => ({ clauseId, url: clauseUrl(clauseId) }));
}

/** Decorate a raw check result with its id, citations, automation level and evidence. */
export function annotate(result: CheckResult, meta: CheckMeta): CheckResult {
  return {
    ...result,
    checkId: meta.id,
    citations: citationsFor(meta),
    automation: meta.automation,
    evidence: { class: meta.evidenceClass, detail: result.detail },
  };
}

/** Decorate by the emitted name; results with no mapping are returned unchanged. */
export function annotateByName(result: CheckResult): CheckResult {
  const meta = BY_NAME.get(result.name);
  return meta ? annotate(result, meta) : result;
}

/** The mapping in the shape published at docs/standard/compliance-checks.json. */
export function complianceMap(): {
  $schema: string; standard_base_url: string; automation_levels: Record<CheckAutomation, string>;
  checks: Array<Omit<CheckMeta, 'clauses'> & { clauses: StandardCitation[] }>;
} {
  return {
    $schema: `${STANDARD_BASE_URL}compliance-checks.schema.json`,
    standard_base_url: STANDARD_BASE_URL,
    automation_levels: {
      full: 'The check is the clause\'s automated enforcement; a pass is the clause\'s evidence.',
      partial: 'The check proves one observable facet of the clause; the rest needs the manual or human review the clause names.',
    },
    checks: CHECKS.map((m) => ({ ...m, live: m.live ?? false, clauses: citationsFor(m) })),
  };
}
