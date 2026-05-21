// PAS Agent Teams Worker — entry point.
// v0.1: scaffolding only. No routes wired yet.
//
// Design doc:
//   ~/.gstack/projects/serge-ivo-stores-workspace/serge-ivo-main-design-20260521-181709.md
//
// Next milestones (per design doc §Sequencing):
//   Stage 0 (wk 1-3): static-HTML PAS host port, DO schema, auth wiring
//   Stage 1 (wk 4-5): BA role on CFNative runtime, ticket inbox→awaiting-approval
//   Stage 2 (wk 6-8): Dev + QA roles, first ticket inbox→done on static-output app

import { Hono } from 'hono'
import type { Project, Ticket } from './types.ts'

export type Bindings = {
  PROJECT: DurableObjectNamespace
  AGENT_STORAGE: R2Bucket
  PAS_BACKEND: Fetcher
  FAS_API_BASE: string
  PAS_API_BASE: string
  FAS_SESSION_SIGNING_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ ok: true, version: '0.1.0', stage: 'scaffold' }))

// All other routes return 501 until implementation lands.
app.all('*', (c) => c.json({ error: 'not_implemented', stage: 'scaffold' }, 501))

export default app

// ─── ProjectDO ────────────────────────────────────────────────────────────
// One DO per PAS Agent Teams project. Holds backlog, message log, role configs,
// cost ledger. WebSocket hibernation for streaming agent output to the browser.
// v0.1: minimal class so wrangler can bind it. Schema lands in stage 1.

export class ProjectDO {
  // Suppress unused-warning until we wire state.sql / state.storage in stage 1.
  // The DO runtime needs the constructor signature even at scaffold stage.
  constructor(_state: DurableObjectState, _env: Bindings) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({ error: 'not_implemented', stage: 'scaffold' }),
      { status: 501, headers: { 'content-type': 'application/json' } }
    )
  }
}

// Suppress unused-import warning for v0.1; types.ts is the contract that
// downstream stages build against, re-exported here so consumers can
// `import type { Project, Ticket } from '@proappstore/agent-teams'`.
export type { Project, Ticket }
