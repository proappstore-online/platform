// Stub of the platform API behind the data worker's `API` service binding.
// The data worker has already verified the session's HMAC before it asks the
// platform which team role the caller holds on APP_ID; this stub answers that
// question from the session's uid so tests can exercise owner / viewer / none.
const ROLES = { 'gh:owner': 'owner', 'gh:viewer': 'viewer' };
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/apps') return Response.json({ error: 'stub: unknown route' }, { status: 404 });
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let uid = null;
    try {
      const body = token.slice(0, token.lastIndexOf('.'));
      const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((body.length + 3) % 4);
      uid = JSON.parse(atob(padded)).uid ?? null;
    } catch {}
    if (!uid) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const role = ROLES[uid];
    return Response.json({ apps: role ? [{ id: 'test-app', team_role: role }] : [] });
  },
};
