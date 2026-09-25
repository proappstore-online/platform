// A service-binding target that reports what reached it: which worker, the
// method, the path and the headers. Bound under several names (the host's API /
// ADMIN / AGENTS / MCP / KB, agent-teams' PAS_BACKEND / KB), it lets a test prove
// the dispatch went to the right binding with the right request — the wiring
// class of bug the unit suite cannot see.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) headers[k] = v;
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
    return Response.json(
      { worker: env.STUB_NAME, method: request.method, host: url.host, path: url.pathname + url.search, headers, body },
      { headers: { 'X-Stub-Worker': env.STUB_NAME } },
    );
  },
};
