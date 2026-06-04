/**
 * The agent catalog — the single, resolved view of EVERY agent on a project:
 * its identity (persona), its base system prompt, the skills/tools it's granted,
 * and its model/runtime. This is what powers "see all prompts / skills /
 * identities" in the console (and, later, over MCP). Pure + self-contained so
 * the resolution rules (defaults vs per-project overrides) are unit-testable
 * without the DO.
 *
 * Resolution layers, in the order an agent actually receives them at run time:
 *   1. identity (persona) — the "soul"; tunable per project.
 *   2. base system prompt — the role's job description; tunable for build roles
 *      (`systemPromptOverride`), templated per-turn for the chat agents.
 *   3. PLATFORM_CAPABILITIES — shared platform/SDK ground truth (not per-agent).
 *   4. the per-ticket / per-message task framing (see prompts.ts) — dynamic.
 * This catalog surfaces layers 1–2 (the tunable, textual parts) plus the tools.
 */

import type { Role, RoleConfig } from './types.ts';
import { DEFAULT_PERSONAS, PO_PERSONA } from './memory.ts';
import { buildDefaultPrompt } from './runtimes/cf-native-prompt.ts';

/** How an agent's prompt is sourced. */
export type PromptSource = 'default' | 'custom' | 'templated';

export interface AgentDescriptor {
  /** Stable id used to address the agent (PO | Architect | BA | Dev | QA). */
  id: string;
  label: string;
  /** One-line "what this agent is for". */
  summary: string;
  /** Where it runs: a conversational chat thread, or the build pipeline. */
  surface: 'chat' | 'build';
  /** For chat agents, which transcript thread they speak on. */
  thread?: 'build' | 'research';
  /** The resolved identity ("soul") this agent runs with. */
  identity: string;
  /** Whether `identity` is the seeded default or a per-project override. */
  identitySource: 'default' | 'custom';
  /** The resolved base system prompt (job description). */
  systemPrompt: string;
  /** default = seeded; custom = per-project override; templated = built per-turn. */
  systemPromptSource: PromptSource;
  /** The skills/tools this agent may call. */
  tools: string[];
  model: string;
  runtime: string;
  maxTokens?: number | undefined;
  /** What can be tuned today and how. */
  editable: { fields: string[]; via: string };
}

/** Fixed tool sets for the two conversational agents (see po-chat / architect-chat). */
const PO_CHAT_TOOLS = ['list_files', 'read_file', 'search_files', 'remember', 'create_ticket'];
const ARCHITECT_CHAT_TOOLS = ['list_files', 'read_file', 'search_files', 'write_file', 'batch_write_files', 'remember', 'read_docs'];

const PUT_ROLES = 'PUT /v1/projects/:slug/roles';

/**
 * Build the full agent catalog from the project's stored role configs. Build
 * roles (Architect/BA/Dev/QA) resolve from their `role_configs` row; the two
 * chat agents (PO, Architect-chat identity) resolve from defaults + the few
 * fields they honor today. `poPersona`/`architectPersona` let the caller pass a
 * resolved per-project identity (e.g. the Architect's persona is shared with its
 * build-role row).
 */
export function buildAgentCatalog(
  roleConfigs: RoleConfig[],
  opts: { poPersona?: string | null } = {},
): AgentDescriptor[] {
  const byRole = new Map<Role, RoleConfig>();
  for (const rc of roleConfigs) byRole.set(rc.role, rc);

  const buildRole = (role: Role, summary: string): AgentDescriptor => {
    const rc = byRole.get(role);
    const identity = rc?.persona ?? DEFAULT_PERSONAS[role];
    const override = rc?.systemPromptOverride;
    // The default persona is SEEDED into role_configs at project creation, so a
    // non-null persona alone doesn't mean "custom" — compare against the default.
    const personaIsCustom = !!rc?.persona && rc.persona !== DEFAULT_PERSONAS[role];
    return {
      id: role,
      label: role,
      summary,
      surface: 'build',
      identity,
      identitySource: personaIsCustom ? 'custom' : 'default',
      systemPrompt: override ?? buildDefaultPrompt(role),
      systemPromptSource: override ? 'custom' : 'default',
      tools: rc?.spineTools ?? [],
      model: rc?.model ?? 'claude-sonnet-4-6',
      runtime: rc?.runtime ?? 'cf-native',
      maxTokens: rc?.maxTokens,
      editable: { fields: ['identity', 'systemPrompt', 'model', 'runtime', 'tools', 'maxTokens'], via: PUT_ROLES },
    };
  };

  // The Architect's identity is shared between its build-role run (writing the
  // KB from a ticket) and its Research-tab chat — one agent, one soul.
  const architect = buildRole('Architect', 'Researches the app and authors the Knowledge Base (KNOWLEDGE.md + docs/) the team builds against. Also the Research-tab chat agent.');

  return [
    {
      id: 'PO',
      label: 'Product Owner',
      summary: 'The Build-tab chat agent. Turns the founder\'s intent into the smallest shippable tickets and answers questions from the real code.',
      surface: 'chat',
      thread: 'build',
      identity: opts.poPersona ?? PO_PERSONA,
      identitySource: opts.poPersona ? 'custom' : 'default',
      systemPrompt: 'Built per message from the live backlog, file list, and project memory (see buildPOSystemPrompt). The tunable part is the identity above.',
      systemPromptSource: 'templated',
      tools: PO_CHAT_TOOLS,
      model: 'claude-sonnet-4-6',
      runtime: 'cf-native',
      editable: { fields: ['identity'], via: PUT_ROLES + " (role 'PO') — roadmap" },
    },
    architect,
    buildRole('BA', 'Turns a ticket into a crisp, buildable spec with concrete acceptance criteria.'),
    buildRole('Dev', 'Implements the approved spec with the PAS SDK; also authors the app\'s mcp.json so it\'s MCP-callable.'),
    buildRole('QA', 'Writes Playwright end-to-end specs that gate the deploy against the live app.'),
  ];
}
