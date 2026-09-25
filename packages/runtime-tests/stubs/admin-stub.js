// Stub of the admin Worker behind agent-teams' `ADMIN` service binding. Answers
// the repo-pull handshake the ProjectDO's syncFromGitHub performs and records
// every call on a shared D1-free channel: the worker echoes what it saw in
// response headers so the test can assert the internal token was forwarded.
const HEAD_SHA = 'abc123def4567890abc123def4567890abc12345';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const internal = request.headers.get('X-Internal-Token') || '';
    const seen = { 'X-Stub-Path': url.pathname, 'X-Stub-Internal-Token': internal };
    if (url.pathname === '/api/repo-pull' && request.method === 'POST') {
      if (internal !== 'runtime-test-internal-token') return Response.json({ error: 'forbidden' }, { status: 403, headers: seen });
      const body = await request.json();
      if (!body.id) return Response.json({ error: 'id required' }, { status: 400, headers: seen });
      if (body.headOnly) return Response.json({ ok: true, sha: HEAD_SHA }, { headers: seen });
      return Response.json({ ok: true, sha: HEAD_SHA, files: { 'index.html': '<h1>from github</h1>', 'src/app.ts': 'export {}' } }, { headers: seen });
    }
    return Response.json({ error: 'stub: unknown route', path: url.pathname }, { status: 404, headers: seen });
  },
};
