export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/provision-operations/example' && request.method === 'GET') return Response.json({
      receipt: 'runtime-receipt', appId: 'example', status: 'completed',
      steps: [{ name: 'host', status: 'pending', detail: 'Initial host returned 404; deploy may still be pending' }],
    });
    if (url.hostname === 'example.proappstore.online' && request.method === 'HEAD') return new Response(null, { status: 200 });
    if (url.pathname.endsWith("/visibility/me")) return Response.json({ mode: "public", allowed: true });
    if (url.pathname.endsWith("/tools")) return Response.json({ tools: [
      { name: "get_profile", description: "Read your own profile", operation: "query", requires_auth: true, params: { limit: { type: "integer", default: 10, max: 50 } } },
      { name: "update_profile", description: "Update your own profile", operation: "execute", requires_auth: true, params: {} },
    ] });
    if (url.pathname.endsWith("/actions/get_profile")) return Response.json({ rows: [(await request.json()).params] });
    if (url.pathname === "/v1/apps") return Response.json({ apps: [{ id: "example", name: "Example", description: "Runtime fixture", team_role: "owner" }] });
    if (url.pathname === "/v1/auth/me/account") return Response.json({ provider: "github", providerLabel: "GitHub", email: "fixture@example.test", emailVerified: true, accountType: "oauth" });
    return Response.json({ error: "No fixture for this route" }, { status: 404 });
  },
};
