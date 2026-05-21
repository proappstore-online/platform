# Sample Tickets — PO Voice Corpus

> **PO assignment (T2 from the eng review).** This file is the input/output
> corpus that the BA agent prompt, ticket schema, spec format, and supervision
> UI all derive from. Fill it in **before** any agent code lands.

## Instructions for the PO (Sergey)

Pick one of your 8 recently-shipped PAS apps (carsads, dating, doordrop,
grasskarma, kanban, loopride, wellness, console). Pretend the agent team
already existed when you started it. Write the **3-5 backlog tickets** you
would have created — in your real voice, the way you'd type them at 11pm.

For each ticket, fill in all four sections:

1. **`rawIdea`** — the free-text you'd type into the inbox at 11pm. Casual,
   un-edited, your real voice.
2. **`BaSpec`** — what the BA agent should hand back after refining your idea
   (structured; see schema in
   `packages/agent-teams/src/types.ts`)
3. **`Dev output`** — what the Dev agent must produce (commits, file changes,
   PR description, behavior)
4. **`QA acceptance`** — what the QA agent must verify before it's done.
   These map directly to QA tool calls (`browse.click`, `pas.healthCheck`,
   etc.) — the more specific, the better.

This file becomes:
- the seed prompt for the BA agent (it learns spec format from your specs)
- the eval dataset (BA's output on `rawIdea` should match or improve on
  your hand-written `BaSpec`)
- the contract the supervision UI implements (PO sees `rawIdea` →
  `BaSpec` → approve → Dev output → QA report)

**Constraint for v1:** keep `sdkPrimitives` empty or `['auth']` only.
Anything beyond `auth` requires the v1.1 PAS SDK-runtime port and won't
work on the static-HTML host. If you can't think of 3-5 tickets that fit
that constraint for a given app, pick a different app.

---

## App chosen: `<fill in: carsads | dating | doordrop | grasskarma | kanban | loopride | wellness | console>`

Brief description of the app, in your voice (2-3 sentences):

> `<fill in>`

---

## Ticket 1

### rawIdea

`<your 11pm voice — what you'd type into the inbox>`

### BaSpec

```ts
{
  summary: `<1 paragraph>`,
  acceptanceCriteria: [
    `<bullet>`,
    `<bullet>`,
  ],
  sdkPrimitives: [] /* or ['auth'] for v1 */,
  filesToCreate: [
    `<path>`,
  ],
  outOfScope: [
    `<what NOT to do>`,
  ],
}
```

### Dev output

`<commits, files, PR shape, observable behavior>`

### QA acceptance

`<specific things QA must verify; map to tool calls where possible>`
- [ ] `browse.screenshot` of the deployed app at `<slug>.proappstore.online` matches the spec's visual intent
- [ ] `pas.healthCheck` returns 200
- [ ] `<more, specific to this ticket>`

---

## Ticket 2

### rawIdea

`<fill in>`

### BaSpec

```ts
{
  summary: ``,
  acceptanceCriteria: [],
  sdkPrimitives: [],
  filesToCreate: [],
  outOfScope: [],
}
```

### Dev output

`<fill in>`

### QA acceptance

`<fill in>`

---

## Ticket 3

### rawIdea

`<fill in>`

### BaSpec

```ts
{
  summary: ``,
  acceptanceCriteria: [],
  sdkPrimitives: [],
  filesToCreate: [],
  outOfScope: [],
}
```

### Dev output

`<fill in>`

### QA acceptance

`<fill in>`

---

## Ticket 4 (optional)

### rawIdea

`<fill in>`

### BaSpec

```ts
{
  summary: ``,
  acceptanceCriteria: [],
  sdkPrimitives: [],
  filesToCreate: [],
  outOfScope: [],
}
```

### Dev output

`<fill in>`

### QA acceptance

`<fill in>`

---

## Ticket 5 (optional)

### rawIdea

`<fill in>`

### BaSpec

```ts
{
  summary: ``,
  acceptanceCriteria: [],
  sdkPrimitives: [],
  filesToCreate: [],
  outOfScope: [],
}
```

### Dev output

`<fill in>`

### QA acceptance

`<fill in>`

---

## After you fill this in

Run `/plan-eng-review` against this file with the question:
"Does the BA prompt I'm about to write produce these `BaSpec`s from these
`rawIdea`s?" The answer drives the BA system prompt + the spec evaluator.
