import { SECRET_NAME_RE } from '../../routes/secrets-shared.js';
import { HOOK_NAME, type HookDef } from './hooks.js';
import { googleCapabilities, googleDisclosure, type GoogleCapability, type GoogleDisclosure } from '../google-calendar-policy.js';

// ── Connectors (#258) ────────────────────────────────────────────────────────

const MAX_CONNECTORS_PER_APP = 3;
const CONNECTOR_MODES = ['app', 'pat'] as const;
const CONNECTOR_EVENT = /^[a-z][a-z_]{0,49}$/;
export interface ConnectorDef { name: string; kind: 'github' | 'google_calendar'; modes: string[]; pat_secret: string | null; events: string[]; hook: string | null; capabilities?: GoogleCapability[]; disclosure?: GoogleDisclosure }

/**
 * The `connectors` section: `[{ name, kind: "github", modes: ["app","pat"], pat_secret?, events?, hook? }]`.
 * `pat_secret` names an app secret (required with mode "pat"); `hook` names a hook in
 * this manifest whose verifier is `github-app`, which is where the connector's events
 * are delivered (required when `events` is non-empty).
 */
export function validateConnectors(raw: unknown, hooks: HookDef[]): { error: string } | { connectors: ConnectorDef[] } {
  if (raw === undefined || raw === null) return { connectors: [] };
  if (!Array.isArray(raw) || raw.length > MAX_CONNECTORS_PER_APP) return { error: `connectors must be an array of at most ${MAX_CONNECTORS_PER_APP} connectors` };
  const out: ConnectorDef[] = [];
  for (const [i, item] of raw.entries()) {
    const at = `connectors[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: `${at} must be an object` };
    const unknown = Object.keys(item).find((k) => !['name', 'kind', 'modes', 'pat_secret', 'events', 'hook', 'capabilities', 'disclosure'].includes(k));
    if (unknown) return { error: `${at}: unknown field "${unknown}"` };
    const { name, kind, modes, pat_secret, events = [], hook, capabilities, disclosure } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !HOOK_NAME.test(name)) return { error: `${at}.name must match ${HOOK_NAME.source}` };
    if (out.some((x) => x.name === name)) return { error: `${at}: duplicate name "${name}"` };
    if (kind === 'google_calendar') {
      if (!Array.isArray(modes) || modes.length !== 1 || modes[0] !== 'oauth') return { error: `${at}.modes must be ["oauth"] for Google Calendar` };
      if (pat_secret !== undefined || hook !== undefined || !Array.isArray(events) || events.length) return { error: `${at}: Google Calendar has no PAT, hooks or webhook events` };
      if (out.some(x => x.kind === kind)) return { error: `${at}: an app declares at most one Google Calendar connector` };
      try {
        out.push({ name, kind, modes: ['oauth'], pat_secret: null, events: [], hook: null,
          ...(capabilities !== undefined ? { capabilities: googleCapabilities(capabilities) } : {}),
          ...(disclosure !== undefined ? { disclosure: googleDisclosure(disclosure) } : {}),
        });
      } catch (error) { return { error: `${at}: ${(error as Error).message}` }; }
      continue;
    }
    if (capabilities !== undefined || disclosure !== undefined) return { error: `${at}: capabilities and disclosure apply only to Google` };
    if (kind !== 'github') return { error: `${at}.kind must be "github" or "google_calendar"` };
    // Installations bind to the app, not to a connector name, so a second github connector would be ambiguous (#303 G2).
    if (out.some((x) => x.kind === 'github')) return { error: `${at}: an app declares at most one github connector` };
    if (!Array.isArray(modes) || modes.length === 0 || modes.some((m) => !CONNECTOR_MODES.includes(m as never)) || new Set(modes).size !== modes.length) {
      return { error: `${at}.modes must be a non-empty list of ${CONNECTOR_MODES.join(', ')}` };
    }
    if (modes.includes('pat') && (typeof pat_secret !== 'string' || !SECRET_NAME_RE.test(pat_secret))) return { error: `${at}.pat_secret must name an app secret (${SECRET_NAME_RE.source}) when modes includes "pat"` };
    if (pat_secret !== undefined && !modes.includes('pat')) return { error: `${at}.pat_secret applies only with mode "pat"` };
    if (!Array.isArray(events) || events.length > 20 || events.some((e) => typeof e !== 'string' || !CONNECTOR_EVENT.test(e)) || new Set(events).size !== events.length) {
      return { error: `${at}.events must be a list of at most 20 distinct GitHub event names` };
    }
    if (events.length && !modes.includes('app')) return { error: `${at}.events are delivered by the GitHub App, so modes must include "app"` };
    if (hook !== undefined && typeof hook !== 'string') return { error: `${at}.hook must be a hook name` };
    if (events.length && hook === undefined) return { error: `${at}.hook is required with events` };
    if (hook !== undefined && hooks.find((h) => h.name === hook)?.verify.kind !== 'github-app') return { error: `${at}.hook must name a hook in this manifest with verify.kind "github-app"` };
    out.push({ name, kind, modes: modes as string[], pat_secret: (pat_secret as string | undefined) ?? null, events: events as string[], hook: (hook as string | undefined) ?? null });
  }
  return { connectors: out };
}
