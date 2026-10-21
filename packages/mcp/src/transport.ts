import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** The official SDK's stateless HTTP transport. A session id never identifies a
 * user, and refreshing credentials cannot leave old claims in a Durable Object. */
export async function serveMcp(server: McpServer, request: Request): Promise<Response> {
  const cors = {
    "Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, MCP-Protocol-Version, MCP-Session-Id",
    "Access-Control-Expose-Headers": "WWW-Authenticate, MCP-Session-Id",
    "Vary": "Origin",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  // This stateless server has no unsolicited server-to-client event stream.
  if (request.method === "GET") return new Response("No standalone event stream", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(cors)) headers.set(name, value);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } finally {
    await server.close();
  }
}
