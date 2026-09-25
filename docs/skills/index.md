# ProAppStore Agent Skills

ProAppStore publishes seven portable [Agent Skills](https://agentskills.io/specification)
for agents that create, secure, ship, upgrade and audit ProAppStore apps. A skill
provides the workflow; the existing [ProAppStore MCP server](https://mcp.proappstore.online/mcp)
remains the authenticated action layer. No MCP behavior is forked and no skill
contains credentials.

The portable plugin entry points are [`plugin.json`](https://github.com/proappstore-online/platform/blob/main/plugin.json)
and [`mcp.json`](https://github.com/proappstore-online/platform/blob/main/mcp.json).
They use the open Agent Plugins layout: skills are discovered from `skills/` and
the bundled remote MCP server is configured once from `mcp.json`. The legacy
[`.claude-plugin/plugin.json`](https://github.com/proappstore-online/platform/blob/main/.claude-plugin/plugin.json)
remains as a Claude Code compatibility manifest.

## Discover and install

- **Codex / ChatGPT:** add the repository marketplace with
  `codex plugin marketplace add proappstore-online/platform`, then install
  `proappstore@proappstore-local`. For a checked-out repository, use
  `codex plugin marketplace add .` instead. Update with
  `codex plugin marketplace upgrade proappstore-local`; uninstall with
  `codex plugin remove proappstore@proappstore-local` and
  `codex plugin marketplace remove proappstore-local`.
- **Claude Code:** run `/plugin marketplace add proappstore-online/platform`,
  then `/plugin install proappstore@proappstore`. Update with
  `/plugin update proappstore@proappstore` and uninstall with
  `/plugin uninstall proappstore@proappstore`.
- **Other Agent Skills clients:** copy an unchanged `skills/<name>/` directory
  and configure `https://mcp.proappstore.online/mcp`. Verify the content digest
  in [`skills/index.json`](https://github.com/proappstore-online/platform/blob/main/skills/index.json)
  after every update.

The machine-readable, client-neutral discovery record is
[`marketplace.json`](https://github.com/proappstore-online/platform/blob/main/marketplace.json).
It includes supported clients, install/update/uninstall instructions, versioning,
the MCP endpoint and smoke-test evidence.

## Trust and release process

Each bundle is MIT-licensed and has a version in `SKILL.md` metadata. The release
gate computes SHA-256 hashes for every file and one content digest per bundle in
[`skills/index.json`](https://github.com/proappstore-online/platform/blob/main/skills/index.json).
It validates skill metadata, references, allow-lists, package manifests and
security review provenance before release.

Read the [skills README](https://github.com/proappstore-online/platform/blob/main/skills/README.md)
for the bundles and contribution process, [security review](https://github.com/proappstore-online/platform/blob/main/skills/SECURITY.md)
for the human and automated checks, and the [evaluation summary](./evaluations.md)
for the validation and client-smoke record.
