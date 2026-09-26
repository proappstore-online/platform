// A service-binding target that reports what reached it: which worker, the
// method, the path and the headers. Bound under several names (the host's API /
// ADMIN / AGENTS / MCP / KB, agent-teams' PAS_BACKEND / KB), it lets a test prove
// the dispatch went to the right binding with the right request — the wiring
// class of bug the unit suite cannot see.
// Public-action fixtures for the host's page-meta and sitemap tests (#210): the
// only paths that answer with action rows instead of an echo.
function fixtureAction(name, params) {
  if (name === 'fixture_product_meta') {
    return params.id === 'missing'
      ? Response.json({ rows: [] })
      : Response.json({ rows: [{ title: `Product ${params.id}`, description: 'A fine product', image_url: 'https://cdn.test/p.png' }] });
  }
  if (name === 'fixture_sitemap') {
    const pages = { '': [{ path: '/p/a', updated_at: Date.UTC(2026, 8, 1) }, { path: '/p/b', updated_at: '2026-09-02T00:00:00Z' }], '/p/b': [{ path: '/p/c&d' }] };
    return Response.json({ rows: pages[params.cursor] ?? [] });
  }
  return Response.json({ error: 'fixture failure' }, { status: 500 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {};
    for (const [k, v] of request.headers) headers[k] = v;
    const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
    const fixture = /\/actions\/(fixture_[a-z_]+)$/.exec(url.pathname);
    if (fixture) return fixtureAction(fixture[1], JSON.parse(body || '{}').params ?? {});
    return Response.json(
      { worker: env.STUB_NAME, method: request.method, host: url.host, path: url.pathname + url.search, headers, body },
      { headers: { 'X-Stub-Worker': env.STUB_NAME } },
    );
  },
};
