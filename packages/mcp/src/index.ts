import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface Env {
  API_BASE: string;
  GITHUB_ORG: string;
}

async function getDeployStatus(org: string, appId: string) {
  const res = await fetch(
    `https://api.github.com/repos/${org}/${appId}/actions/runs?per_page=5`,
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "proappstore-mcp" } }
  );
  if (!res.ok) return { error: `GitHub API ${res.status}` };
  const data = (await res.json()) as {
    workflow_runs: Array<{
      name: string;
      conclusion: string | null;
      status: string;
      updated_at: string;
      html_url: string;
      head_sha: string;
    }>;
  };
  return (data.workflow_runs ?? []).map((r) => ({
    name: r.name,
    status: r.conclusion ?? r.status,
    updatedAt: r.updated_at,
    url: r.html_url,
    sha: r.head_sha?.slice(0, 7),
  }));
}

async function pasApi(apiBase: string, path: string, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${apiBase}${path}`, { headers });
  if (!res.ok) return { error: `API ${res.status}: ${await res.text()}` };
  return await res.json();
}

export class PasMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "ProAppStore",
    version: "0.1.0",
  });

  async init() {
    // ── list_apps ──────────────────────────────────────────────
    this.server.tool(
      "list_apps",
      "List your published apps on ProAppStore. Requires a session token.",
      { token: z.string().describe("FAS/PAS session token") },
      async ({ token }) => {
        const data = (await pasApi(this.env.API_BASE, "/v1/apps", token)) as {
          apps?: Array<{ id: string; name: string; category: string | null; description: string | null }>;
          error?: string;
        };
        if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
        const apps = data.apps ?? [];
        if (apps.length === 0) return { content: [{ type: "text" as const, text: "No apps yet. Use `pas create my-app` to get started." }] };
        const lines = apps.map(
          (a) => `- **${a.name}** (${a.id}) — ${a.description || a.category || "no description"}\n  Live: https://${a.id}.proappstore.online | Repo: https://github.com/${this.env.GITHUB_ORG}/${a.id}`
        );
        return { content: [{ type: "text" as const, text: `${apps.length} app(s):\n\n${lines.join("\n")}` }] };
      }
    );

    // ── deploy_status ──────────────────────────────────────────
    this.server.tool(
      "deploy_status",
      "Check the deploy status of a Pro app (last 5 GitHub Actions runs).",
      { app_id: z.string().describe("App ID (e.g. 'meetup', 'kanban')") },
      async ({ app_id }) => {
        const runs = await getDeployStatus(this.env.GITHUB_ORG, app_id);
        if ("error" in runs) return { content: [{ type: "text" as const, text: `Error: ${(runs as { error: string }).error}` }] };
        if ((runs as Array<unknown>).length === 0)
          return { content: [{ type: "text" as const, text: `No workflow runs found for ${app_id}.` }] };
        const lines = (runs as Array<{ name: string; status: string; updatedAt: string; sha: string; url: string }>).map(
          (r) => `- ${r.status === "success" ? "✅" : r.status === "failure" ? "❌" : "⏳"} ${r.name} (${r.sha}) — ${r.updatedAt}\n  ${r.url}`
        );
        return { content: [{ type: "text" as const, text: `Deploy history for **${app_id}**:\n\n${lines.join("\n")}` }] };
      }
    );

    // ── app_info ───────────────────────────────────────────────
    this.server.tool(
      "app_info",
      "Get info about any app on ProAppStore — live URL, repo, data worker, store listing.",
      { app_id: z.string().describe("App ID (e.g. 'meetup', 'kanban')") },
      async ({ app_id }) => {
        const domain = "proappstore.online";
        const org = this.env.GITHUB_ORG;
        const liveUrl = `https://${app_id}.${domain}`;
        const repoUrl = `https://github.com/${org}/${app_id}`;
        const listingUrl = `https://${domain}/apps/${app_id}/`;
        const dataUrl = `https://data-${app_id}.${domain}`;

        const check = await fetch(liveUrl, { method: "HEAD" });
        const status = check.ok ? "Live (200)" : `Down (${check.status})`;

        return {
          content: [{
            type: "text" as const,
            text: [
              `**${app_id}**`,
              `Status: ${status}`,
              `Live: ${liveUrl}`,
              `Repo: ${repoUrl}`,
              `Listing: ${listingUrl}`,
              `Data worker: ${dataUrl}`,
              `Deploy: push to main → auto-deploy via GitHub Actions`,
            ].join("\n"),
          }],
        };
      }
    );

    // ── platform_guide ─────────────────────────────────────────
    this.server.tool(
      "platform_guide",
      "Get the ProAppStore platform guide (skills.md) for AI-assisted development. Full reference for SDK, CLI, deployment, rules.",
      {},
      async () => {
        const res = await fetch("https://proappstore.online/skills.md");
        if (!res.ok) return { content: [{ type: "text" as const, text: "Failed to fetch skills.md" }] };
        const text = await res.text();
        return { content: [{ type: "text" as const, text }] };
      }
    );

    // ── sdk_reference ──────────────────────────────────────────
    this.server.tool(
      "sdk_reference",
      "Quick reference for @proappstore/sdk — imports, features, and usage patterns. Covers auth, db, storage, maps, AI, subscriptions, rooms, hooks, and UI components.",
      {
        feature: z.enum([
          "all", "auth", "kv", "counters", "rooms", "proxy",
          "db", "storage", "maps", "ai", "notifications", "sms",
          "subscription", "tenant", "hooks", "ui"
        ]).optional().describe("Specific feature or 'all'")
      },
      async ({ feature }) => {
        const sections: Record<string, string> = {
          auth: `## Auth
\`\`\`tsx
import { initPro } from '@proappstore/sdk'
const app = initPro({ appId: 'my-app' })
await app.auth.init()
app.auth.signIn()        // GitHub OAuth
app.auth.signOut()
app.auth.user            // { id, login, avatarUrl } | null
app.auth.token           // session token
app.auth.signIn('google') // Google OAuth
await app.auth.signInWithEmail('user@example.com') // magic link
\`\`\``,
          kv: `## Per-user KV Storage
\`\`\`tsx
await app.kv.set('key', { any: 'json' })
const val = await app.kv.get('key')
await app.kv.delete('key')
const keys = await app.kv.list({ prefix: 'draft:' })
const many = await app.kv.getMany(keys)
\`\`\`
Limits: 10MB/user on Pro (1MB on Free).`,
          counters: `## Shared Counters
\`\`\`tsx
await app.counters.increment('likes')       // +1, auth required
await app.counters.increment('score', 10)   // +10
await app.counters.get('likes')             // no auth needed
await app.counters.list()
\`\`\``,
          rooms: `## Real-time Rooms (WebSocket)
\`\`\`tsx
const room = app.rooms.join('lobby')
room.send({ type: 'move', x: 10 })
room.onMessage(msg => console.log(msg))
room.onPeers(peers => console.log(peers))
room.close()
\`\`\`
Uncapped on Pro (5 rooms, 50 user-hrs/day on Free).`,
          proxy: `## Secret-injecting API Proxy
\`\`\`tsx
const res = await app.proxy.fetch('api.example.com/v1/data')
\`\`\``,
          db: `## Per-app SQL Database (D1)
\`\`\`tsx
await app.db.execute('CREATE TABLE events (id TEXT PK, title TEXT)')
const { rows } = await app.db.query('SELECT * FROM events WHERE city = ?', ['SF'])
await app.db.execute('INSERT INTO events VALUES (?, ?)', [id, 'Meetup'])
const results = await app.db.batch([...])
await app.db.migrate([{ name: '001', sql: '...' }])
const tables = await app.db.tables()
\`\`\``,
          storage: `## File Storage (R2)
\`\`\`tsx
await app.storage.upload('photos/pic.jpg', file, 'image/jpeg')
await app.storage.uploadPublic('avatar.jpg', file, 'image/jpeg')
const url = app.storage.publicUrl('avatar.jpg')  // for <img src>
const res = await app.storage.download('photos/pic.jpg')
const files = await app.storage.list()
await app.storage.delete('photos/pic.jpg')
\`\`\``,
          maps: `## Maps + Geocoding + Routing
\`\`\`tsx
const results = await app.maps.geocode('Times Square, NYC')
const place = await app.maps.reverseGeocode(40.758, -73.985)
const route = await app.maps.route(from, to)
// route.geometry, route.distanceMeters, route.durationSeconds
const mapUrl = app.maps.embedUrl(lat, lng)   // for <iframe>
const tileUrl = app.maps.staticUrl(lat, lng) // for <img>
\`\`\`
OpenStreetMap powered, no Google keys needed.`,
          ai: `## Server-side AI (Workers AI)
\`\`\`tsx
const { text } = await app.ai.generate('Write a haiku')
const { text } = await app.ai.generate('Summarize...', { model: 'smart' })
const { text } = await app.ai.chat([
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Hello' }
])
const { vectors } = await app.ai.embed(['hello', 'world'])
\`\`\`
Models: 'fast' (Llama 8B), 'smart' (Llama 70B). Included in subscription.`,
          notifications: `## Push Notifications (Web Push)
\`\`\`tsx
await app.notifications.subscribe()
await app.notifications.isSubscribed()
await app.notifications.send('user-id', { title: 'Hey!', body: 'Event soon.' })
await app.notifications.broadcast({ title: 'New!', body: 'Check it out.' })
\`\`\``,
          sms: `## SMS (Twilio-backed)
\`\`\`tsx
await app.sms.send('+15551234567', 'Confirmed!')
await app.sms.broadcast(['+1555...', '+1555...'], 'Reminder!')
\`\`\`
Creator-only. Numbers must be E.164.`,
          subscription: `## Subscription (Stripe)
\`\`\`tsx
const sub = await app.subscription.status()
// { status, tier, priceId, currentPeriodEnd, cancelAtPeriodEnd } | null
await app.subscription.openCheckout({ priceId, successUrl, cancelUrl })
await app.subscription.openPortal(returnUrl)
\`\`\``,
          tenant: `## Multi-tenant Helpers
\`\`\`tsx
const tx = app.db.tenant('studio-123')
await tx.insert('clients', { id: 'c-1', name: 'Alice' })
const alice = await tx.find('clients', { id: 'c-1' })
const all = await tx.findMany('clients')
await tx.update('clients', { id: 'c-1' }, { name: 'Alicia' })
await tx.delete('clients', { id: 'c-1' })
await tx.count('clients')
\`\`\`
Auto-scopes all queries by tenant_id. Tables need a \`tenant_id TEXT\` column.`,
          hooks: `## React Hooks
\`\`\`tsx
import { useProAuth, useProSubscription, useProGate, useProNotifications, useTheme } from '@proappstore/sdk/hooks'

const { user, loading, signIn, signOut, deleteAccount } = useProAuth(app)
const { isPro, upgrade, manageBilling } = useProSubscription(app)
const { gate, user, signIn, upgrade } = useProGate(app)
const { theme, preference, setPreference } = useTheme()
const { isSubscribed, subscribe, unsubscribe } = useProNotifications(app)
\`\`\``,
          ui: `## UI Components
\`\`\`tsx
import { Avatar, SignInButton, ThemeToggle, ProBadge, ProfileMenu, SubscriptionStatus, UpgradeCard, BillingButton, GateScreen, ProProfilePage } from '@proappstore/sdk/ui'
import { ProShell } from '@proappstore/sdk/shell'

// Zero-config shell:
<ProShell app={app} appName="My App">{children}</ProShell>

// Individual components:
<Avatar user={user} size={32} />
<ProBadge size="md" />
<ThemeToggle />
<ProfileMenu app={app} />
<SubscriptionStatus app={app} />
<UpgradeCard app={app} />
<BillingButton app={app} variant="secondary" />
<GateScreen gate={gate} app={app} appName="My App" />
<ProProfilePage app={app} />
\`\`\`
Full docs: https://proappstore.online/docs/ui`,
        };

        const selected = feature === "all" || !feature
          ? Object.values(sections).join("\n\n")
          : sections[feature] ?? `Unknown feature: ${feature}`;

        return { content: [{ type: "text" as const, text: `# @proappstore/sdk Reference\n\n${selected}` }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "ProAppStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proappstore.online/mcp\n\nTools: list_apps, deploy_status, app_info, platform_guide, sdk_reference\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    return PasMcpAgent.serve("/mcp").fetch(request, env, ctx);
  },
};
