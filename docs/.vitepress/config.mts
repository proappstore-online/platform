import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(__dirname, "..");

function toTitle(slug: string): string {
  return slug
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildSidebarItems(dir: string, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
  const items: Array<{ text: string; link?: string; items?: any[] }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") continue;
    const slug = entry.name.replace(/\.md$/, "");
    items.push({ text: toTitle(slug), link: `${prefix}/${slug}` });
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const subItems = buildSidebarItems(join(dir, entry.name), `${prefix}/${entry.name}`);
    if (subItems.length > 0) {
      items.push({ text: toTitle(entry.name), items: subItems });
    }
  }
  return items;
}

const mainSidebar = [
  {
    text: "Guide",
    items: [
      { text: "Getting Started", link: "/getting-started" },
      { text: "Tailored vs Ready", link: "/tailored-vs-ready" },
      { text: "Services Marketplace", link: "/services-marketplace" },
      { text: "UI Components", link: "/ui" },
      { text: "Recipes", link: "/recipes" },
    ],
  },
  {
    text: "Application Standard",
    items: [
      { text: "Overview & Audit Guide", link: "/standard/" },
      { text: "Audit Model", link: "/standard/audit-model" },
      { text: "Audit Instructions", link: "/standard/audit-instructions" },
      { text: "Governance & Versioning", link: "/standard/governance" },
      { text: "Stack & Platform Services", link: "/standard/stack" },
      { text: "Identity, Sessions & Permissions", link: "/standard/auth" },
      { text: "Data, Actions & Workers", link: "/standard/data" },
      { text: "Integrations & Platform Services", link: "/standard/integrations" },
      { text: "UI, Browser Security & PWA", link: "/standard/ui" },
      { text: "Testing, Deployment & Operations", link: "/standard/ops" },
      { text: "Changelog", link: "/standard/changelog" },
    ],
  },
  {
    text: "Architecture",
    items: [
      { text: "System Overview", link: "/architecture" },
      { text: "Browser Auth Sessions", link: "/auth-session-model" },
      { text: "Bot Protection (Turnstile)", link: "/turnstile" },
      { text: "Publishing Flow", link: "/publishing-flow" },
      { text: "Approved Templates", link: "/templates/" },
      { text: "Stripe & Entitlements", link: "/stripe-entitlements" },
    ],
  },
  {
    text: "AI & Agents",
    items: [
      { text: "MCP: App Tools", link: "/mcp-app-tools" },
      { text: "Agent Customization", link: "/agent-customization" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "SDK Overview", link: "/sdk-overview" },
      { text: "UI Components", link: "/ui" },
      { text: "Recipes", link: "/recipes" },
      { text: "CLI Overview", link: "/cli-overview" },
    ],
  },
];

export default withMermaid(
  defineConfig({
    title: "ProAppStore Docs",
    description:
      "Architecture and developer documentation for ProAppStore — distribution and monetization for AI-first apps",
    cleanUrls: true,
    lastUpdated: true,
    mermaid: {},
    themeConfig: {
      siteTitle: "ProAppStore Docs",
      outline: { level: [2, 3] },
      nav: [
        { text: "Guide", link: "/getting-started" },
        { text: "Architecture", link: "/architecture" },
        { text: "AI & Agents", link: "/mcp-app-tools" },
        { text: "SDK", link: "/sdk-overview" },
        { text: "UI", link: "/ui" },
        { text: "ADRs", link: "/adr/001-cloudflare-workers-only" },
      ],
      sidebar: {
        "/adr/": [
          {
            text: "Architecture Decision Records",
            items: buildSidebarItems(join(docsDir, "adr"), "/adr"),
          },
        ],
        "/": mainSidebar,
      },
      search: {
        provider: "local",
      },
      socialLinks: [
        { icon: "github", link: "https://github.com/proappstore-online/sdk" },
      ],
    },
  })
);
