export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/provision-operations/example' && request.method === 'GET') return Response.json({
      receipt: 'runtime-receipt', appId: 'example', status: 'completed',
      steps: [{ name: 'host', status: 'pending', detail: 'Initial host returned 404; deploy may still be pending' }],
    });
    if (url.hostname === 'example.proappstore.online' && request.method === 'HEAD') return new Response(null, { status: 200 });
    // #490: an app that has not gone live. Every action is `staged`, so the listing everyone shares is
    // an empty 200; the app's team, asked as themselves, also receives the staged actions with `state`.
    // The caller is read from the session JWT's uid; gh:team is on the team, anyone else is not.
    if (url.pathname === "/v1/apps/staged-app/tools" || url.pathname === "/v1/apps/staged-app/actions/staged_report") {
      const bearer = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
      let uid = null;
      try { uid = JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).uid; } catch {}
      const onTeam = uid === "gh:team";
      if (url.pathname.endsWith("/tools")) {
        return Response.json({ tools: onTeam ? [
          { name: "staged_report", description: "Not live yet", operation: "query", requires_auth: true, params: {}, state: "staged" },
        ] : [] });
      }
      return onTeam ? Response.json({ rows: [{ id: "staged-1" }] }) : Response.json({ error: "forbidden" }, { status: 403 });
    }
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
