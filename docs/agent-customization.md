# Agent customization

ProAppStore's Agent Teams aren't a black box. Everything **textual** about an
agent — its identity, its system prompt, the skills it can use, the model it runs
on — is data, scoped per project, and tunable. The platform gives you the
framework and a sensible default team; you tune the parts that matter for your
app.

This pairs with [MCP app tools](./mcp-app-tools): agents build the app, and the
finished app becomes MCP-callable.

## The agent roster

A project has five agents, each deliberately narrow (one job, so its skill set
stays small and it does that job well):

| Agent | Surface | Job | Skills (tools) |
|-------|---------|-----|----------------|
| **PO** | Build-tab chat | Turns the founder's intent into the smallest shippable tickets; answers from the real code. Owns the backlog. | `list_files`, `read_file`, `search_files`, `remember`, `create_ticket` |
| **Architect** | Research-tab chat **+** build | Researches the app and authors the Knowledge Base (`KNOWLEDGE.md` + `docs/`) the whole team builds against. Designs the intended MCP tool surface. | `write_file`, `batch_write_files`, `read_file`, `list_files`, `search_files`, `read_docs`, `remember` |
| **BA** | Build | Turns a ticket into a crisp, buildable spec with concrete acceptance criteria. | read-only + `read_docs` |
| **Dev** | Build | Implements the approved spec with the PAS SDK; authors the app's `mcp.json`. | `write_file`, `batch_write_files`, `read_file`, `list_files`, `search_files`, `read_docs` |
| **QA** | Build | Writes Playwright E2E specs that gate the deploy against the live app. | `write_file`, `read_file`, `list_files`, `search_files`, `read_docs` |

The **PO** and **Architect-chat** are conversational; **BA/Dev/QA** (and the
Architect's KB-build run) execute against the ticket pipeline. The Architect is
**one identity** used in both its chat and its build run.

## What each agent receives

At run time, an agent's prompt is assembled in layers:

1. **Identity (persona)** — the agent's "soul": directive, boundaries, tone.
   *Tunable per project.*
2. **Base system prompt** — the role's job description. *Tunable for build roles
   (`systemPromptOverride`); templated per-turn for the chat agents.*
3. **`PLATFORM_CAPABILITIES`** — shared PAS/SDK ground truth (not per-agent).
4. **Task framing** — the per-ticket / per-message context (backlog, file list,
   spec, KB) built dynamically.

Customization targets layers **1 and 2** plus the **skills** and **model/runtime**.

## See every agent: `GET /agents`

One call returns the fully *resolved* catalog (defaults applied) — the basis for
"see all prompts / skills / identities" in the Console:

```
GET /v1/projects/:slug/agents
```

```jsonc
{
  "agents": [
    {
      "id": "Dev",
      "label": "Dev",
      "summary": "Implements the approved spec with the PAS SDK; also authors the app's mcp.json…",
      "surface": "build",
      "identity": "You are the Developer (Dev).\nDirective: …",
      "identitySource": "default",          // "default" | "custom"
      "systemPrompt": "You are a Developer building a ProAppStore app. …",
      "systemPromptSource": "default",       // "default" | "custom" | "templated"
      "tools": ["write_file", "batch_write_files", "read_file", "…"],
      "model": "claude-sonnet-4-6",
      "runtime": "cf-native",
      "maxTokens": 16384,
      "editable": { "fields": ["identity","systemPrompt","model","runtime","tools","maxTokens"], "via": "PUT /v1/projects/:slug/roles" }
    }
    // … PO, Architect, BA, QA
  ]
}
```

`identitySource` / `systemPromptSource` tell you whether an agent is running the
seeded default or a per-project override. `systemPromptSource: "templated"` (PO,
Architect-chat) means the base prompt is generated per message — the **identity**
is the tunable part there.

## Tune the build roles: `GET` / `PUT /roles`

The four build roles (Architect, BA, Dev, QA) are configured per project:

```
GET /v1/projects/:slug/roles
PUT /v1/projects/:slug/roles
```

```jsonc
// PUT body
{
  "roles": [
    {
      "role": "Dev",
      "runtime": "cf-native",            // cf-native (Anthropic) | openai-responses (OpenAI)
      "model": "claude-sonnet-4-6",
      "maxTokens": 16384,                 // 1024–64000
      "persona": "You are a senior React engineer who values small diffs.",   // identity override
      "systemPromptOverride": "…",        // optional full base-prompt replacement (≤ 8KB)
      "spineTools": ["write_file", "batch_write_files", "read_file", "list_files", "search_files", "read_docs"],
      "vendorTools": []
    }
  ]
}
```

Bounds (validated server-side): `model` 1–64 chars; `maxTokens` 1024–64000;
`persona` ≤ 4KB; `systemPromptOverride` ≤ 8KB; `spineTools` drawn from the known
spine set (`write_file`, `read_file`, `list_files`, `delete_file`,
`search_files`, `batch_write_files`, `read_docs`); `runtime` ∈ {`cf-native`,
`openai-responses`}.

Each role can run a **different model and runtime** — e.g. Dev on Opus via
`cf-native`, QA on a cheaper model, BA on OpenAI. Keys come from the BYO key
vault.

The **Architect's persona** set here is also what its Research-tab **chat** uses
— one identity across research and build.

## Defaults

Every new project is seeded with `cf-native` / `claude-sonnet-4-6` roles and the
default personas (the "directive / boundaries / vibe" blocks in `memory.ts`).
Override only what you need; anything you don't set keeps the default and reads
back as `…Source: "default"`.

## Roadmap

The data model + read/write APIs above are the foundation. Building on them:

- **Console UI** — an Agents view that renders `GET /agents` (every identity,
  prompt, skill, model) and edits the build roles inline via `PUT /roles`.
- **Tune over MCP** — platform MCP tools to read and update a project's agent
  config, so you can retune the team from your own AI client.
- **PO identity tuning** — a first-class override for the PO (and a full
  systemPrompt override for the chat agents), so *every* agent's identity is
  editable, not just the build roles. (`GET /agents` already surfaces a PO
  override when one is stored.)
