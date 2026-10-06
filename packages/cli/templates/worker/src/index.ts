// The APPNAME app worker (ADR-009). Built to dist/app.js and deployed by the
// platform on push to main, once a platform admin has enabled app workers for
// this app. Docs: https://docs.proappstore.online/app-workers
//
// It has no database, KV or secret bindings: data goes through registered
// actions whose `callers` include "worker" (mcp.json), secrets through
// pas.secrets.get() for names listed in mcp.json `worker.secrets`.
// Delivery is at-least-once: make every handler idempotent on `event.id`.
import { defineAppWorker } from '@proappstore/sdk/worker';

export default defineAppWorker({
  // Runs on a schedule declared in mcp.json:
  //   "worker": { "schedules": [{ "name": "sync", "cron": "*/15 * * * *" }] }
  //
  // async scheduled(event, pas) {
  //   const token = await pas.secrets.get('GITHUB_TOKEN');
  //   const res = await fetch('https://api.github.com/user/repos', { headers: { authorization: `Bearer ${token}`, 'user-agent': 'APPNAME' } });
  //   const repos = (await res.json()) as { id: number; full_name: string }[];
  //   await pas.actions.batch(repos.map((r) => ({ name: 'upsert_repo', params: { id: r.id, name: r.full_name } })));
  //   await pas.log('info', 'synced', { count: repos.length, run: event.id });
  // },

  // A signed-in user's request to /.pas/worker/* on the app's origin; actions run as that user.
  async fetch(request) {
    return Response.json({ ok: true, path: new URL(request.url).pathname });
  },
});
