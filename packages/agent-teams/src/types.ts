// Canonical types for PAS Agent Teams.
// Source of truth: §Data Model in the design doc.
// Path: ~/.gstack/projects/serge-ivo-stores-workspace/serge-ivo-main-design-20260521-181709.md
//
// Fields tagged [v1] ship in v1; [v2] later.
// Binary offload from day 1: anything > 8KB goes to R2 with key stored inline.

// ─── Project ──────────────────────────────────────────────────────────────

export type Project = {
  id: string                  // [v1] uuid
  ownerId: string             // [v1] PAS subscriber id (FAS GitHub OAuth)
  name: string                // [v1]
  slug: string                // [v1] becomes <slug>.proappstore.online
  createdAt: number           // [v1]
  roleConfigs: RoleConfig[]   // [v1] which runtime each role uses
  costCapMonthlyUsd: number   // [v1] hard stop when exceeded
  costSpentMonthlyUsd: number // [v1] rolled up from ticket history
  repoUrl: string | null      // [v1] github.com/proappstore-online/<slug>
  repoProvisionedAt: number | null  // [v1] populated by first Dev git.openPR
  registryEntryId: string | null    // [v1] populated by first publish
}

// ─── Roles ────────────────────────────────────────────────────────────────

export type Role = 'BA' | 'Dev' | 'QA'

// v1 ships two runtime adapters. anthropic-managed dropped (no BYO support).
export type RuntimeKind = 'openai-responses' | 'cf-native'

export type RoleConfig = {
  role: Role
  runtime: RuntimeKind
  model: string                  // e.g. 'claude-opus-4-7' (cf-native), 'gpt-5' (openai)
  maxTokens?: number             // per-turn output cap; falls back to runtime default
  persona?: string               // "soul" — identity/principles/tone, prepended to the system prompt
  systemPromptOverride?: string  // optional; default lives in role registry
  spineTools: string[]           // tool names round-tripped to spine
  vendorTools: string[]          // vendor-native tools (e.g. 'web_search')
}

// ─── Tickets ──────────────────────────────────────────────────────────────

export type TicketStatus =
  | 'inbox'             // PO created, BA not started
  | 'ba-refining'       // BA agent active
  | 'awaiting-approval' // BA done, PO must approve spec
  | 'ready'             // approved, waiting for Dev to pick up
  | 'dev-active'        // Dev agent running
  | 'qa-active'         // QA agent running
  | 'qa-failed'         // QA found bugs; routes back to Dev with comments
  | 'deploying'         // QA passed; system is pushing + verifying the CI build
  | 'needs-input'       // agent is stuck, needs user decision before continuing
  | 'done'              // built + deployed live (verified green)
  | 'failed'            // hit iteration cap, cost cap, or stuck-ticket
  | 'cancelled'         // PO killed it

export type Ticket = {
  id: string                  // [v1] uuid
  seq: number                 // [v1] short per-project number, human-quotable as #N
  projectId: string           // [v1]
  title: string               // [v1] PO-written
  rawIdea: string             // [v1] PO's free-text idea
  spec: BaSpec | null         // [v1] populated by BA, approved by PO
  status: TicketStatus        // [v1]
  assigneeRole: Role | null   // [v1]
  iterations: number          // [v1] QA→Dev loop count; capped at 5
  createdAt: number           // [v1]
  updatedAt: number           // [v1]
  costSpentUsd: number        // [v1] sum of all agent runs on this ticket
  prUrl: string | null        // [v1] when Dev opens a PR
  finalCommitSha: string | null  // [v1] when QA approves
  stuckReason: string | null  // [v1] populated when auto-fails
}

// SDK primitives the BA can include in a spec.
// v1: agent is restricted to static-output apps. Anything beyond 'auth' requires
// the v1.1 PAS SDK-runtime port to actually run.
export type SdkPrimitive =
  | 'auth'           // [v1 ok]  GitHub OAuth via FAS — works on static host
  | 'kv'             // [v1.1]   per-user KV
  | 'rooms'          // [v1.1]   WebSocket DOs
  | 'db'             // [v1.1]   per-app D1 via data-worker
  | 'proxy'          // [v1.1]   AI key vault proxy
  | 'counters'       // [v1.1]   atomic counters
  | 'subscription'   // [v1.1]   Stripe entitlements

export type BaSpec = {
  summary: string                  // 1-paragraph
  acceptanceCriteria: string[]     // checklist; QA verifies these
  sdkPrimitives: SdkPrimitive[]    // v1 BA must constrain to ['auth'] or []
  filesToCreate: string[]          // guidance only; Dev may diverge
  outOfScope: string[]             // what NOT to do; prevents creep
  approvedBy: string | null        // PAS user id; null until PO approves
  approvedAt: number | null
  revisionOf: number | null        // index into ticket.specHistory[] if revised
}

// ─── Messages + Tool calls ────────────────────────────────────────────────

export type MessageAuthor = 'po' | Role | 'system'

export type Message = {
  id: string
  ticketId: string
  author: MessageAuthor
  body: string                  // markdown
  toolCalls?: ToolCall[]        // when an agent message includes tool invocations
  createdAt: number
  costUsd: number               // model spend for this turn
  tokensIn: number
  tokensOut: number
  bodyOffloadKey?: string       // R2 key when body > 8KB
}

export type ToolCall = {
  id: string                    // matches ToolResult.callId
  name: string                  // from §Tool Catalog
  args: unknown
  result?: ToolResult           // populated by spine after execution
}

export type ToolResult = {
  callId: string
  ok: boolean
  data?: unknown                // small payloads inline
  dataOffloadKey?: string       // R2 key when payload > 8KB
  errorMessage?: string
  durationMs: number
}

// ─── AgentRuntime interface ───────────────────────────────────────────────
// Two implementations in v1: CFNativeRuntime, OpenAIResponsesRuntime.

export type PrepareContext = {
  projectId: string
  ticketId: string
  role: RoleConfig
  byoKey: string  // decrypted just-in-time, never logged
  userToken?: string | undefined  // owner session token, forwarded to the spine for tool dispatch
  // Tool executor injected by the DO. When set, the runtime routes every tool
  // call here (file tools → in-memory map, infra tools → provisioning) instead
  // of the legacy MCP dispatch. Keeps stateful execution in the DO.
  dispatch?: ((call: ToolCall) => Promise<ToolResult>) | undefined
}

export type RuntimeHandle = {
  runtime: RuntimeKind
  // Opaque per-runtime state (e.g. previous_response_id for OpenAI,
  // session_id for Anthropic Managed when/if added back).
  state: Record<string, unknown>
}

export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'tool-result'; result: ToolResult }
  | { type: 'done'; costUsd: number; tokensIn: number; tokensOut: number }
  | { type: 'error'; message: string; retryable: boolean }
  // Emitted every 5s during model streaming AND long tool runs.
  // Anytime upstream is alive but not emitting semantic events.
  // Prevents stuck-ticket false positives on slow model responses.
  | { type: 'heartbeat' }

export type RuntimeTerminationStats = {
  costUsd: number
  tokensIn: number
  tokensOut: number
}

export interface AgentRuntime {
  prepare(ctx: PrepareContext): Promise<RuntimeHandle>

  // Stream agent output for a single turn given full message history.
  run(handle: RuntimeHandle, messages: Message[]): AsyncIterable<StreamEvent>

  // Execute a tool the agent requested. Spine tools round-trip here;
  // vendor-native tools may be handled in-runtime per RoleConfig.vendorTools.
  invokeTool(handle: RuntimeHandle, toolCall: ToolCall): Promise<ToolResult>

  terminate(handle: RuntimeHandle): Promise<RuntimeTerminationStats>
}
