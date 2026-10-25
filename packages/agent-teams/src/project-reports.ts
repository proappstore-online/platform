import type { ProjectHost } from './project-host.ts';
import { json } from './store.ts';
import { fetchAnthropicMessages } from './runtimes/ai-gateway.ts';
import { resolveByoKey } from './byo-key.ts';
import { loadFiles } from './project-store.ts';
import { clearActivityLog, readActivity, costSummary } from './activity-log.ts';
import { LISTING_MODEL, sanitizeListing } from './listing.ts';

export function getCostSummary(h: ProjectHost): Response {
  return json(costSummary(h.state.storage.sql));
}

// Wipe the persisted activity trail (start fresh). Audit-only data; safe to clear.
export function clearActivity(h: ProjectHost): Response {
  clearActivityLog(h.state.storage.sql);
  h.broadcast({ type: 'activity-cleared' });
  return json({ ok: true });
}

export function getActivity(h: ProjectHost): Response {
  return json({ activity: readActivity(h.state.storage.sql) });
}

export async function generateListing(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { fields?: string[] };
  const fields = body.fields ?? ['tagline', 'longDescription', 'category'];
  const proj = h.state.storage.sql
    .exec('SELECT owner_id, slug, name FROM project LIMIT 1')
    .toArray()[0] as { owner_id: string; slug: string; name: string } | undefined;
  if (!proj) return json({ error: 'project not found' }, 404);

  const byoKey = await resolveByoKey(h.env, proj.owner_id, 'anthropic');
  if (!byoKey) return json({ error: 'No Anthropic API key configured. Add one in Profile > API Keys.' }, 400);

  // Gather app context from the working tree
  const files = loadFiles(h.state.storage.sql);
  const fileList = [...files.keys()].sort();
  const readme = files.get('README.md') ?? '';
  const kb = files.get('KNOWLEDGE.md') ?? '';
  const appTs = files.get('src/App.tsx') ?? files.get('src/App.jsx') ?? '';
  const pkgJson = files.get('package.json') ?? '';

  const prompt = `You are writing a store listing for a web app called "${proj.name}" (id: ${proj.slug}) on ProAppStore.

App context:
${kb ? `Knowledge Base:\n${kb.slice(0, 3000)}\n` : ''}${readme ? `README:\n${readme.slice(0, 1500)}\n` : ''}${appTs ? `App.tsx (first 100 lines):\n${appTs.split('\n').slice(0, 100).join('\n')}\n` : ''}${pkgJson ? `package.json deps:\n${pkgJson.slice(0, 500)}\n` : ''}
Files: ${fileList.slice(0, 30).join(', ')}

Generate a JSON object with ONLY these fields:
${fields.includes('tagline') ? '- "tagline": 1 sentence, max 60 chars, catchy — what the app does\n' : ''}${fields.includes('longDescription') ? '- "longDescription": 2-3 paragraphs, markdown OK, what the app does + key features + who it\'s for\n' : ''}${fields.includes('category') ? '- "category": one of: productivity, social, marketplace, transport, finance, health, education, entertainment, tools, other\n' : ''}
Respond with ONLY the JSON object, no markdown fences, no explanation.`;

  try {
    const { res } = await fetchAnthropicMessages(h.env, {
      apiKey: byoKey,
      metadata: { appId: proj.slug, surface: 'listing-generator' },
      body: { model: LISTING_MODEL, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 200)}` }, 502);
    }
    const aiRes = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = aiRes.content?.find(c => c.type === 'text')?.text ?? '';
    // SECURITY (#91): the model was fed untrusted repo content (README/App.tsx
    // written by agents or any team member), so treat its output as untrusted:
    // whitelist the fields, validate category against the allow-list, and clamp
    // lengths. Don't pass arbitrary model-emitted keys through to the listing.
    try {
      return json({ listing: sanitizeListing(JSON.parse(text)), tokensUsed: true });
    } catch {
      return json({ listing: sanitizeListing({ longDescription: text }), tokensUsed: true });
    }
  } catch (e) {
    return json({ error: `AI generation failed: ${e instanceof Error ? e.message : 'unknown'}` }, 500);
  }
}

/** Trigger a Playwright E2E test run via GitHub Actions dispatch. */
export async function triggerTestRun(h: ProjectHost): Promise<Response> {
  const proj = h.state.storage.sql
    .exec('SELECT slug, owner_id FROM project LIMIT 1')
    .toArray()[0] as { slug: string; owner_id: string } | undefined;
  if (!proj) return json({ error: 'project not found' }, 404);
  if (!h.env.ADMIN || !h.env.INTERNAL_TOKEN) return json({ error: 'admin binding not available' }, 500);

  // Check if e2e specs exist in the working tree
  const specs = [...loadFiles(h.state.storage.sql).keys()].filter(p => p.startsWith('e2e/specs/') && p.endsWith('.spec.ts'));
  if (specs.length === 0) return json({ error: 'No test specs found in e2e/specs/. Ask the QA agent to generate them first.' }, 400);

  h.logActivity('test', `Test run triggered (${specs.length} spec file(s))`, null);
  h.broadcast({ type: 'test-run-started', specs: specs.length });

  // Trigger the workflow via the GitHub API (dispatch event)
  try {
    const ghToken = h.env.INTERNAL_TOKEN;
    const res = await h.env.ADMIN!.fetch(new Request('https://admin.proappstore.online/api/trigger-test-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': ghToken },
      body: JSON.stringify({ repo: proj.slug, specs }),
    }));
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      h.logActivity('test', `Test run trigger failed: ${res.status} ${text.slice(0, 200)}`, null);
      return json({ error: `Could not trigger test run: ${text.slice(0, 200) || `admin ${res.status}`}` }, 502);
    }
    const result = await res.json() as { runId?: number; runUrl?: string };
    h.logActivity('test', `Test run started → ${result.runUrl ?? 'GitHub Actions'}`, null);
    return json({ ok: true, specs: specs.length, runUrl: result.runUrl });
  } catch (e) {
    h.logActivity('test', `Test run error: ${e instanceof Error ? e.message : 'unknown'}`, null);
    return json({ error: `Test run failed: ${e instanceof Error ? e.message : 'unknown'}` }, 500);
  }
}

/** Get test run history with per-test results. */
export function getTestHistory(h: ProjectHost): Response {
  const runs = h.state.storage.sql
    .exec('SELECT * FROM test_runs ORDER BY triggered_at DESC LIMIT 50')
    .toArray() as { id: string; triggered_at: number; source: string; commit_sha: string | null; status: string; passed: number; failed: number; skipped: number; flaky: number; duration_ms: number | null; coverage_pct: number | null }[];

  // Per-spec trending: success rate over last 20 runs
  const specStats = h.state.storage.sql
    .exec(`SELECT spec_file, status, COUNT(*) as cnt FROM test_results
           WHERE run_id IN (SELECT id FROM test_runs ORDER BY triggered_at DESC LIMIT 20)
           GROUP BY spec_file, status`)
    .toArray() as { spec_file: string; status: string; cnt: number }[];

  const specTrending: Record<string, { pass: number; fail: number; total: number; pct: number }> = {};
  for (const r of specStats) {
    const s = specTrending[r.spec_file] ?? { pass: 0, fail: 0, total: 0, pct: 0 };
    if (r.status === 'pass') s.pass += r.cnt;
    else if (r.status === 'fail') s.fail += r.cnt;
    s.total += r.cnt;
    s.pct = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0;
    specTrending[r.spec_file] = s;
  }

  // Overall stats
  const totalRuns = runs.length;
  const passedRuns = runs.filter(r => r.status === 'passed').length;
  const overallPct = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;

  return json({
    runs: runs.map(r => ({
      id: r.id, triggeredAt: r.triggered_at, source: r.source, commitSha: r.commit_sha,
      status: r.status, passed: r.passed, failed: r.failed, skipped: r.skipped,
      flaky: r.flaky, durationMs: r.duration_ms, coveragePct: r.coverage_pct,
    })),
    specTrending,
    stats: { totalRuns, passedRuns, overallPct },
  });
}

/** Ingest test results from CI or manual run. */
export async function ingestTestResults(h: ProjectHost, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    runId?: string; source?: string; commitSha?: string; status?: string;
    passed?: number; failed?: number; skipped?: number; flaky?: number;
    durationMs?: number; coveragePct?: number;
    results?: { specFile: string; testName: string; status: string; durationMs?: number; error?: string }[];
  };
  const sql = h.state.storage.sql;
  const runId = body.runId ?? crypto.randomUUID();
  const now = Date.now();

  sql.exec(
    `INSERT OR REPLACE INTO test_runs (id, triggered_at, source, commit_sha, status, passed, failed, skipped, flaky, duration_ms, coverage_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    runId, now, body.source ?? 'ci', body.commitSha ?? null,
    body.status ?? (body.failed ? 'failed' : 'passed'),
    body.passed ?? 0, body.failed ?? 0, body.skipped ?? 0, body.flaky ?? 0,
    body.durationMs ?? null, body.coveragePct ?? null,
  );

  if (body.results) {
    for (const r of body.results.slice(0, 500)) { // cap at 500 results per run
      if (!r.specFile || !r.testName || !r.status) continue; // skip malformed entries
      sql.exec(
        'INSERT INTO test_results (id, run_id, spec_file, test_name, status, duration_ms, error_text) VALUES (?, ?, ?, ?, ?, ?, ?)',
        crypto.randomUUID(), runId,
        String(r.specFile).slice(0, 500), String(r.testName).slice(0, 500),
        String(r.status).slice(0, 20),
        r.durationMs ?? null, r.error ? String(r.error).slice(0, 5000) : null,
      );
    }
  }

  h.logActivity('test', `Test run ${body.status ?? 'completed'}: ${body.passed ?? 0} passed, ${body.failed ?? 0} failed`, null);
  h.broadcast({ type: 'test-run-completed', runId, status: body.status, passed: body.passed, failed: body.failed });
  return json({ ok: true, runId });
}
