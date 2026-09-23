/**
 * Approved-template catalogue and selection contract (#178).
 *
 * The single source of truth for which templates an app may be provisioned
 * from. Consumed by the MCP provisioner (list_templates, provision_pas_app,
 * scaffold_app) and the backend /v1/provision guard, and published verbatim to
 * https://docs.proappstore.online/templates/catalogue.json by
 * scripts/build-template-catalogue.mjs (the CLI reads that public copy).
 *
 * Contract:
 *  - `id` is stable and unique; `repo` is the GitHub source; `ref` its branch.
 *  - `status`: approved | deprecated | withdrawn. Provisioning REJECTS unknown
 *    and withdrawn templates, WARNS on deprecated ones, and always falls back
 *    to the default (template-app) when no template is named.
 *  - `release.source_commit` is the reviewed revision; the provisioner records
 *    the exact commit it actually copied on the app row (`apps.template_rev`).
 *  - Add an entry only for a reviewed, maintained template — never to
 *    populate the list (#178).
 *
 * Keep this file dependency-free: the docs generator imports it directly via
 * Node type stripping.
 */

export type TemplateStatus = 'approved' | 'deprecated' | 'withdrawn';

export interface TemplateEntry {
  /** Stable catalogue id — also accepted as `template_repo` by the provisioner. */
  id: string;
  /** GitHub `owner/name` of the template repository (must be a GitHub template). */
  repo: string;
  /** Branch the provisioner copies from. */
  ref: string;
  title: string;
  purpose: string;
  /** Store categories the template suits; `any` means no restriction. */
  supported_categories: string[];
  requires: { sdk: string; cli: string; node: string; pnpm: string };
  capabilities: string[];
  security_compliance: {
    status: 'reviewed' | 'unreviewed';
    reviewed_at: string;
    /** Known deviations from the Application Standard, by clause id. */
    known_deviations: string[];
    notes: string;
  };
  maintainer: { org: string; contact: string };
  release: { version: string; source_commit: string; released_at: string };
  preview: { docs: string; screenshot: string | null };
  status: TemplateStatus;
  deprecation: { since: string; replaced_by: string | null; reason: string } | null;
  default: boolean;
}

export const TEMPLATE_CATALOGUE_VERSION = '1.0';

export const DEFAULT_TEMPLATE_ID = 'template-app';

export const TEMPLATE_CATALOGUE: readonly TemplateEntry[] = [
  {
    id: 'template-app',
    repo: 'proappstore-online/template-app',
    ref: 'main',
    title: 'ProAppStore app template',
    purpose:
      'The canonical Pro app scaffold: React 19 + Vite 8 + Tailwind 4 web/ workspace, @proappstore/sdk, ' +
      'registered actions (mcp.json), additive D1 migrations (migrations.json), PWA manifest and service worker, ' +
      'the keyless deploy / CI / compliance workflows, and the design tokens. Suits any app category.',
    supported_categories: ['any'],
    requires: { sdk: '>=1.16.0 (template pins ^1.9.0; resolves to the latest 1.x on install)', cli: '>=2.6.0', node: '>=22', pnpm: '10.x' },
    capabilities: [
      'platform-auth', 'registered-actions', 'd1-migrations', 'pwa', 'design-tokens',
      'keyless-oidc-deploy', 'ci-typecheck', 'compliance-workflow', 'app-shell',
    ],
    security_compliance: {
      status: 'reviewed',
      reviewed_at: '2026-09-23',
      known_deviations: ['PAS-AUTH-001', 'PAS-UI-002', 'PAS-UI-007'],
      notes:
        'Template actions list_items/get_item are scoped to the calling user (d8c2e08). Known deviations an app must fix on day one: ' +
        'initPro() is called without authMode (PAS-AUTH-001), the theme boot script reads fas:theme instead of stores-theme (PAS-UI-002), ' +
        'and the viewport meta ships user-scalable=no (PAS-UI-007). Tracked for the template repository.',
    },
    maintainer: { org: 'proappstore-online', contact: 'https://github.com/proappstore-online/platform/issues' },
    release: { version: '2026.09.23', source_commit: 'd8c2e08f32b8e30847b27c7092fd4b0e64341d2f', released_at: '2026-09-23' },
    preview: { docs: 'https://docs.proappstore.online/getting-started/', screenshot: null },
    status: 'approved',
    deprecation: null,
    default: true,
  },
];

export function getTemplate(idOrRepo: string | undefined | null): TemplateEntry | undefined {
  if (!idOrRepo) return TEMPLATE_CATALOGUE.find((t) => t.default);
  const key = idOrRepo.trim();
  return TEMPLATE_CATALOGUE.find((t) => t.id === key || t.repo === key || t.repo.split('/')[1] === key);
}

export interface TemplateSelection {
  ok: boolean;
  template?: TemplateEntry;
  /** Non-fatal notices (e.g. deprecated) the caller must surface. */
  warnings: string[];
  /** Fatal reason when `ok` is false. */
  reason?: string;
  approved: string[];
}

/**
 * Apply the selection contract. `allowUnapproved` lets a platform admin proceed
 * with an unknown or withdrawn template — the caller must still record it.
 */
export function selectTemplate(idOrRepo: string | undefined | null, opts: { allowUnapproved?: boolean } = {}): TemplateSelection {
  const approved = TEMPLATE_CATALOGUE.filter((t) => t.status === 'approved').map((t) => t.id);
  const template = getTemplate(idOrRepo);
  if (!template) {
    if (opts.allowUnapproved && idOrRepo) {
      return { ok: true, warnings: [`template "${idOrRepo}" is not in the approved catalogue — proceeding on an explicit override; the app record will carry it as-is`], approved };
    }
    return { ok: false, warnings: [], reason: `unknown template "${idOrRepo}". Approved templates: ${approved.join(', ')}. Omit the template to use the default (${DEFAULT_TEMPLATE_ID}).`, approved };
  }
  if (template.status === 'withdrawn' && !opts.allowUnapproved) {
    return { ok: false, template, warnings: [], reason: `template "${template.id}" is withdrawn${template.deprecation?.replaced_by ? ` — use ${template.deprecation.replaced_by}` : ''}.`, approved };
  }
  const warnings: string[] = [];
  if (template.status === 'deprecated') {
    warnings.push(`template "${template.id}" is deprecated since ${template.deprecation?.since ?? '?'}${template.deprecation?.replaced_by ? ` — prefer ${template.deprecation.replaced_by}` : ''}${template.deprecation?.reason ? `: ${template.deprecation.reason}` : ''}`);
  }
  if (template.status === 'withdrawn') warnings.push(`template "${template.id}" is withdrawn — proceeding on an explicit override`);
  return { ok: true, template, warnings, approved };
}

/** A git object id as recorded on the app row. */
export const TEMPLATE_REV_RE = /^[0-9a-f]{7,40}$/;

/** The document published at docs/templates/catalogue.json. */
export function templateCatalogueJson(): {
  $schema: string; catalogue_version: string; default: string; selection_contract: Record<string, string>; templates: TemplateEntry[];
} {
  return {
    $schema: 'https://docs.proappstore.online/templates/catalogue.schema.json',
    catalogue_version: TEMPLATE_CATALOGUE_VERSION,
    default: DEFAULT_TEMPLATE_ID,
    selection_contract: {
      unknown: 'rejected (platform admins may override explicitly; the override is recorded)',
      withdrawn: 'rejected (admin override only)',
      deprecated: 'allowed with a warning that the caller must surface',
      approved: 'allowed',
      omitted: `the default template (${DEFAULT_TEMPLATE_ID}) is used`,
      recorded: 'apps.template_id and apps.template_rev hold the template id and the exact source commit copied at provision time',
    },
    templates: [...TEMPLATE_CATALOGUE],
  };
}
