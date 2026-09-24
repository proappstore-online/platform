// Stub of proappstore-qa-worker behind the backend's QA_WORKER service binding.
// Records that the binding is wired; the real worker is exercised by its own suite.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/qa/runs' && request.method === 'POST') {
      return Response.json({ queued: true, stub: true }, { status: 202 });
    }
    return Response.json({ ok: true, stub: 'qa-worker', path: url.pathname });
  },
};
