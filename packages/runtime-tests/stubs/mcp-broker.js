// Deliberately tiny authenticated MCP service-binding double. API protocol
// tests assert the backend's D1 transitions; the MCP package unit suite covers
// canonical-resource token enforcement itself.
export default {
  async fetch(request, env) {
    if (request.headers.get('X-Internal-Token') !== env.INTERNAL_TOKEN) return new Response('not found', { status: 404 });
    const url = new URL(request.url);
    if (url.pathname === '/internal/broker/issue' && request.method === 'POST') return Response.json({ access_token: 'synthetic-resource-bound-token' });
    if (url.pathname.startsWith('/internal/broker/read-receipt/') && request.method === 'GET') return Response.json({ seen: true });
    return new Response('not found', { status: 404 });
  },
};
