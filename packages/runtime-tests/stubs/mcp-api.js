export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/visibility/me")) return Response.json({ mode: "public", allowed: true });
    if (url.pathname.endsWith("/tools")) return Response.json({ tools: [
      { name: "get_profile", description: "Read your own profile", operation: "query", requires_auth: true, params: { limit: { type: "integer", default: 10, max: 50 } } },
      { name: "update_profile", description: "Update your own profile", operation: "execute", requires_auth: true, params: {} },
    ] });
    if (url.pathname.endsWith("/actions/get_profile")) return Response.json({ rows: [(await request.json()).params] });
    if (url.pathname === "/v1/apps") return Response.json({ apps: [{ id: "example", name: "Example", description: "Runtime fixture" }] });
    if (url.pathname === "/v1/auth/me/account") return Response.json({ provider: "github", providerLabel: "GitHub", email: "fixture@example.test", emailVerified: true, accountType: "oauth" });
    return Response.json({ error: "No fixture for this route" }, { status: 404 });
  },
};
