import { fileURLToPath } from "node:url";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { COMPATIBILITY_DATE, SESSION_SIGNING_KEY, INTERNAL_TOKEN } from "./config/shared";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
export default defineWorkersConfig({
  test: {
    deps: { optimizer: { ssr: { enabled: true, include: ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"] } } },
    name: "mcp", include: ["test/mcp/**/*.test.ts"],
    poolOptions: { workers: {
      main: here("../mcp/src/index.ts"), singleWorker: true,
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"],
        durableObjects: { OAUTH_STATE: { className: "OAuthState", useSQLite: true }, MCP_OBJECT: { className: "PasMcpAgent", useSQLite: true } },
        kvNamespaces: ["OAUTH_KV"],
        serviceBindings: { API: "mcp-api", ADMIN: "mcp-api", AGENTS: "mcp-api", HOST: "mcp-api" },
        bindings: {
          SESSION_SIGNING_KEY, INTERNAL_TOKEN, API_BASE: "https://api.proappstore.online",
          AGENTS_BASE: "https://agents.proappstore.online", GITHUB_ORG: "proappstore-online", AUTH_PROVIDERS: "github,google",
        },
        workers: [{ name: "mcp-api", modules: [{ type: "ESModule", path: here("./stubs/mcp-api.js") }], compatibilityDate: COMPATIBILITY_DATE }],
      },
    } },
  },
});
