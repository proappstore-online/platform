// Deliberately tiny authenticated MCP service-binding double. API protocol
// tests assert the backend's D1 transitions; the MCP package unit suite covers
// canonical-resource token enforcement itself.
export default {
  async fetch(request, env) {
    if (request.headers.get('X-Internal-Token') !== env.INTERNAL_TOKEN) return new Response('not found', { status: 404 });
    const url = new URL(request.url);
    if (url.pathname === '/internal/broker/issue' && request.method === 'POST') return Response.json({ access_token: 'synthetic-resource-bound-token' });
    if (url.pathname.startsWith('/internal/broker/read-receipt/') && request.method === 'GET') return Response.json({ seen: true });
    // #367: a deterministic provisioning workflow. The real one is the MCP
    // package's (provisioning-workflow.ts, unit-tested there); this double lets
    // the API protocol tests drive the plan table on real D1. App ids steer it:
    // blocked-* → a blocker, changed-* → the plan changed at confirm.
    if (url.pathname === '/internal/provisioning/plan' || url.pathname === '/internal/provisioning/execute') {
      if (!request.headers.get('X-PAS-Session')) return Response.json({ error: 'a valid PAS session is required' }, { status: 401 });
      const body = await request.json();
      if (url.pathname.endsWith('/plan')) {
        const { appId, name, description, template, templateRev } = body.input;
        return Response.json({ plan: {
          version: 1, appId, name, description, action: appId.startsWith('blocked-') ? 'refused' : 'create',
          repository: { owner: 'proappstore-online', name: appId, url: `https://github.com/proappstore-online/${appId}`, exists: false, private: true },
          appRecord: 'none',
          template: { id: template, repo: `proappstore-online/${template}`, ref: 'main', status: 'approved', reviewedCommit: null, requestedRevision: templateRev ?? null, revision: 'a'.repeat(40), revisionSource: 'template_head' },
          changes: [], compliance: { required: true }, warnings: [],
          blockers: appId.startsWith('blocked-') ? [{ code: 'owned_by_another_account', message: 'owned by another account' }] : [],
        } });
      }
      const { plan } = body;
      if (plan.appId.startsWith('changed-')) {
        return Response.json({ error: 'plan_changed', plan: { ...plan, template: { ...plan.template, revision: 'b'.repeat(40) } } }, { status: 409 });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return Response.json({ joined: false, receipt: `stub-receipt-${plan.appId}`, repoAction: 'created', succeeded: true, lines: [] });
    }
    return new Response('not found', { status: 404 });
  },
};
