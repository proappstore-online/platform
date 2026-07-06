/**
 * GitHub build primitives — repo create, file read/write/delete, batch push via
 * the Git Data API, deploy status. Shared by packages/admin (agent-deploy) and
 * packages/mcp (project-tools) so the logic lives once.
 *
 * Pure: takes a token + org, uses the global fetch. No Worker bindings.
 */

export interface GhResult {
  ok: boolean;
  status: number;
  data: unknown;
}

/** UTF-8-safe base64 (GitHub Contents API wants base64 content). */
export function b64encode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
export function b64decode(s: string): string {
  return decodeURIComponent(escape(atob(s)));
}

/**
 * Fetch a failed Actions job's plaintext log. GitHub's job-logs endpoint
 * 302-redirects to a short-lived SIGNED blob URL that must be fetched with NO
 * auth header — `redirect: 'follow'` forwards the `Authorization: Bearer` token
 * to Azure storage, which 403s, so the log silently came back empty and the Dev
 * was left with only a run URL it can't open. Resolve the redirect manually,
 * then GET the signed location with no headers. Returns '' on any failure.
 */
async function fetchJobLog(jobId: number, repoFullName: string, token: string): Promise<string> {
  const url = `https://api.github.com/repos/${repoFullName}/actions/jobs/${jobId}/logs`;
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'proappstore-build-core', 'X-GitHub-Api-Version': '2022-11-28' };
  const first = await fetch(url, { headers, redirect: 'manual' });
  // Manual redirect → follow the signed Location WITHOUT auth.
  if (first.status >= 300 && first.status < 400) {
    const loc = first.headers.get('location');
    if (!loc) return '';
    const blob = await fetch(loc); // signed URL — must NOT carry the GitHub token
    return blob.ok ? blob.text() : '';
  }
  // Some runtimes hand back the body directly (no redirect surfaced).
  return first.ok ? first.text() : '';
}

export interface GitHub {
  api(path: string, opts?: { method?: string; body?: unknown }): Promise<GhResult>;
  repoExists(id: string): Promise<boolean>;
  /** Create an empty repo in the org (auto_init false). */
  createRepo(id: string, opts?: { description?: string; private?: boolean }): Promise<GhResult>;
  /** Create a repo from the org's template-app (GitHub template generate). */
  createRepoFromTemplate(
    id: string,
    opts: { template?: string; description?: string; private?: boolean },
  ): Promise<GhResult>;
  /** Read a file; returns decoded content + sha when present. */
  getFile(id: string, path: string): Promise<{ ok: boolean; status: number; sha?: string | undefined; content?: string | undefined }>;
  /** Create/overwrite a single file via the Contents API. */
  putFile(id: string, path: string, content: string, message: string, sha?: string): Promise<GhResult>;
  deleteFile(id: string, path: string, message: string, sha: string): Promise<GhResult>;
  listFiles(id: string, path?: string): Promise<GhResult>;
  searchCode(id: string, query: string): Promise<GhResult>;
  /** Push many files as ONE commit (Git Data API). Seeds empty repos when asked. */
  pushFiles(
    id: string,
    files: { path: string; content: string }[],
    message: string,
    opts?: { initIfEmpty?: boolean },
  ): Promise<{ ok: boolean; commitSha?: string; error?: string }>;
  getDeployStatus(id: string, perPage?: number): Promise<GhResult>;
  /** CI result for the default branch (the build gate). Waits (bounded by waitMs)
   *  for the relevant run(s) to finish. When `sha` is given, only runs for that
   *  exact commit count — this avoids racing a not-yet-registered run (returns
   *  status 'pending') or grading a stale previous run. A single push fans out to
   *  several workflows (ci/compliance/deploy); the verdict aggregates them: ok iff
   *  every matching run succeeds. On failure, returns a tail of the failed job's
   *  log (the compiler error etc.) so the Dev can actually fix it. */
  deployResult(id: string, opts?: { waitMs?: number; sha?: string }): Promise<{
    ok: boolean; status?: string | undefined; conclusion?: string | undefined; sha?: string | undefined; url?: string | undefined; errorTail?: string | undefined;
  }>;
  /** Latest commit SHA + date on the default branch (cheap freshness check). */
  headSha(id: string): Promise<{ ok: boolean; sha?: string | undefined; date?: string | undefined }>;
  /** Pull the repo's text files at HEAD (recursive tree → blobs), under caps.
   *  Skips junk dirs and binary/large files. Returns the commit SHA it pulled. */
  pullText(id: string, opts?: { maxFiles?: number; maxFileBytes?: number; maxTreeBytes?: number }):
    Promise<{ ok: boolean; sha?: string | undefined; files?: Record<string, string> | undefined; truncated?: boolean | undefined; error?: string | undefined }>;
  /** Set a GitHub Actions variable on a repo (for non-secret config like R2_ACCOUNT_ID). */
  setRepoVariable(id: string, name: string, value: string): Promise<GhResult>;
}

// Directories and extensions never worth pulling into the agent working tree.
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.turbo|\.wrangler)(\/|$)/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|woff2?|ttf|eot|mp[34]|mov|wasm|lock)$/i;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeGitHub(token: string, org: string): GitHub {
  async function api(path: string, opts?: { method?: string; body?: unknown }): Promise<GhResult> {
    const res = await fetch(`https://api.github.com${path}`, {
      method: opts?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'proappstore-build-core',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  const repo = (id: string) => `${org}/${id}`;
  const d = (r: GhResult) => r.data as Record<string, unknown>;

  return {
    api,

    async repoExists(id) {
      const r = await api(`/repos/${repo(id)}`);
      return r.ok && Boolean(d(r).id);
    },

    async createRepo(id, opts) {
      return api(`/orgs/${org}/repos`, {
        method: 'POST',
        body: {
          name: id,
          private: opts?.private ?? false,
          description: opts?.description ?? '',
          auto_init: false,
          has_issues: true,
          has_projects: false,
          has_wiki: false,
        },
      });
    },

    async createRepoFromTemplate(id, opts) {
      return api(`/repos/${org}/${opts.template ?? 'template-app'}/generate`, {
        method: 'POST',
        body: { owner: org, name: id, description: opts.description ?? '', private: opts.private ?? false },
      });
    },

    async getFile(id, path) {
      const r = await api(`/repos/${repo(id)}/contents/${path}`);
      if (!r.ok) return { ok: false, status: r.status };
      const data = d(r);
      let content = data.content ? b64decode((data.content as string).replace(/\n/g, '')) : undefined;
      // Files > 1MB come back with empty content + a download_url — fetch raw so
      // callers don't mistake a large file for "not found".
      if (content === undefined && typeof data.download_url === 'string') {
        try {
          const raw = await fetch(data.download_url as string);
          if (raw.ok) content = await raw.text();
        } catch { /* fall through with undefined */ }
      }
      return { ok: true, status: r.status, sha: data.sha as string, content };
    },

    async putFile(id, path, content, message, sha) {
      return api(`/repos/${repo(id)}/contents/${path}`, {
        method: 'PUT',
        body: { message, content: b64encode(content), ...(sha ? { sha } : {}) },
      });
    },

    async deleteFile(id, path, message, sha) {
      return api(`/repos/${repo(id)}/contents/${path}`, { method: 'DELETE', body: { message, sha } });
    },

    async listFiles(id, path) {
      return api(`/repos/${repo(id)}/contents/${path ?? ''}`);
    },

    async searchCode(id, query) {
      return api(`/search/code?q=${encodeURIComponent(query)}+repo:${repo(id)}`);
    },

    async pushFiles(id, files, message, opts) {
      const r = repo(id);
      if (files.length === 0) return { ok: true };

      // Git Data API needs an existing ref. Seed empty repos via Contents API.
      const refSha = (res: GhResult) => (d(res).object as { sha?: string } | undefined)?.sha;
      let ref = await api(`/repos/${r}/git/ref/heads/main`);
      if (!ref.ok || !refSha(ref)) {
        if (!opts?.initIfEmpty) return { ok: false, error: 'repo has no main ref (not initialized)' };
        await api(`/repos/${r}/contents/README.md`, {
          method: 'PUT',
          body: { message: 'Initialize repo', content: b64encode('# Initial commit\n') },
        });
        // Poll for the new ref to propagate — a parentless commit on a now
        // non-empty repo would fail the non-fast-forward ref update.
        for (let i = 0; i < 5 && !refSha(ref); i++) {
          await sleep(700);
          ref = await api(`/repos/${r}/git/ref/heads/main`);
        }
        if (!refSha(ref)) return { ok: false, error: 'repo init did not propagate (no main ref)' };
      }
      const parentSha = refSha(ref);

      // Embed file content inline in the tree instead of creating one blob per
      // file via POST /git/blobs. Dozens of rapid blob POSTs intermittently trip
      // GitHub's SECONDARY rate limit (observed: "blob failed for <random file>"
      // on ~30-file app pushes — a DIFFERENT file each attempt, so not a bad file),
      // which stranded deploys. The create-tree API builds the blobs from inline
      // utf-8 content in ONE request. App source is text (the blob path already
      // assumed utf-8), so no behaviour change — just far fewer API calls.
      const treeItems = files.map((f) => ({ path: f.path, mode: '100644', type: 'blob' as const, content: f.content }));

      let baseTree: string | undefined;
      if (parentSha) {
        const parent = await api(`/repos/${r}/git/commits/${parentSha}`);
        baseTree = (d(parent).tree as { sha?: string } | undefined)?.sha;
      }
      // GitHub returns the real reason in `.message` — surface it (e.g. "refusing
      // to allow a Personal Access Token to create or update workflow
      // `.github/workflows/deploy.yml` without `workflow` scope"). A bare "tree
      // creation failed" hides exactly the kind of cause callers need.
      const why = (res: GhResult) => (d(res).message as string | undefined) ?? `HTTP ${res.status}`;

      const tree = await api(`/repos/${r}/git/trees`, {
        method: 'POST',
        body: baseTree ? { base_tree: baseTree, tree: treeItems } : { tree: treeItems },
      });
      const treeSha = d(tree).sha as string | undefined;
      if (!treeSha) return { ok: false, error: `tree creation failed: ${why(tree)}` };

      const commit = await api(`/repos/${r}/git/commits`, {
        method: 'POST',
        body: { message, tree: treeSha, parents: parentSha ? [parentSha] : [] },
      });
      const commitSha = d(commit).sha as string | undefined;
      if (!commitSha) return { ok: false, error: `commit creation failed: ${why(commit)}` };

      const upd = await api(`/repos/${r}/git/refs/heads/main`, { method: 'PATCH', body: { sha: commitSha } });
      if (!upd.ok) return { ok: false, error: `ref update failed: ${why(upd)}` };
      return { ok: true, commitSha };
    },

    async getDeployStatus(id, perPage = 3) {
      return api(`/repos/${repo(id)}/actions/runs?per_page=${perPage}`);
    },

    async deployResult(id, opts) {
      const waitMs = opts?.waitMs ?? 0;
      const sha = opts?.sha;
      const deadline = Date.now() + waitMs;
      // A push fans out to several workflows (ci/compliance/deploy). Grade the
      // whole set for the head commit so a green "deploy" can't mask a red "ci".
      const matching = (runs: Record<string, unknown>[]) =>
        sha ? runs.filter((r) => (r.head_sha as string) === sha || (r.head_sha as string)?.startsWith(sha)) : runs.slice(0, 1);

      let runs: Record<string, unknown>[] = [];
      for (;;) {
        const r = await api(`/repos/${repo(id)}/actions/runs?per_page=20`);
        runs = matching((d(r).workflow_runs as Record<string, unknown>[]) ?? []);
        // No run for this commit yet — it may not have registered. Keep waiting
        // within budget; report 'pending' (not a failure) so the caller can
        // re-check rather than misread it as a broken build.
        if (runs.length === 0) {
          if (Date.now() >= deadline) return { ok: false, status: 'pending', errorTail: 'no CI run registered yet for this commit' };
          await sleep(4000);
          continue;
        }
        if (runs.every((x) => x.status === 'completed') || Date.now() >= deadline) break;
        await sleep(4000);
      }

      const allDone = runs.every((x) => x.status === 'completed');
      const failed = runs.find((x) => x.conclusion && x.conclusion !== 'success');
      const result: { ok: boolean; status: string; conclusion?: string | undefined; sha?: string | undefined; url?: string | undefined; errorTail?: string | undefined } = {
        ok: allDone && !failed,
        status: allDone ? 'completed' : 'in_progress',
        conclusion: failed ? (failed.conclusion as string) : allDone ? 'success' : undefined,
        sha: (runs[0]!.head_sha as string)?.slice(0, 7),
        url: (failed ?? runs[0]!).html_url as string,
      };
      // On failure, pull the failed job's plaintext log tail (the actual error)
      // so the Dev sees the real compiler output, not just a URL it can't open.
      if (failed) {
        try {
          const jobsRes = await api(`/repos/${repo(id)}/actions/runs/${failed.id}/jobs`);
          const jobs = (d(jobsRes).jobs as Record<string, unknown>[]) ?? [];
          const failedJob = jobs.find((j) => j.conclusion === 'failure') ?? jobs[0];
          if (failedJob) {
            const text = await fetchJobLog(failedJob.id as number, repo(id), token);
            if (text) {
              const lines = text.split('\n').filter((l) => /error|fail|✘|exit status|cannot|not found|TS\d{3,}/i.test(l));
              result.errorTail = (lines.length ? lines.slice(-25) : text.split('\n').slice(-25)).join('\n').slice(0, 4000);
            }
          }
        } catch { /* best-effort */ }
      }
      return result;
    },

    async headSha(id) {
      const r = await api(`/repos/${repo(id)}/commits?per_page=1`);
      if (!r.ok || !Array.isArray(r.data) || !r.data.length) return { ok: false };
      const c = (r.data as Record<string, unknown>[])[0]!;
      const commit = c.commit as { committer?: { date?: string } } | undefined;
      return { ok: true, sha: c.sha as string, date: commit?.committer?.date };
    },

    async pullText(id, opts) {
      const maxFiles = opts?.maxFiles ?? 300;
      const maxFileBytes = opts?.maxFileBytes ?? 512 * 1024;
      const maxTreeBytes = opts?.maxTreeBytes ?? 12 * 1024 * 1024;
      const head = await api(`/repos/${repo(id)}/commits?per_page=1`);
      if (!head.ok || !Array.isArray(head.data) || !head.data.length) {
        return { ok: false, error: 'repo has no commits or is unreachable' };
      }
      const sha = (head.data as Record<string, unknown>[])[0]!.sha as string;
      const treeRes = await api(`/repos/${repo(id)}/git/trees/${sha}?recursive=1`);
      if (!treeRes.ok) return { ok: false, error: `tree fetch failed (${treeRes.status})` };
      const tree = (d(treeRes).tree as { path: string; type: string; size?: number; sha: string }[] | undefined) ?? [];
      const blobs = tree.filter((t) => t.type === 'blob' && !SKIP_DIR.test(t.path) && !BINARY_EXT.test(t.path));

      const files: Record<string, string> = {};
      let total = 0;
      let truncated = (d(treeRes).truncated as boolean) ?? false;
      let count = 0;
      for (const b of blobs) {
        if (count >= maxFiles) { truncated = true; break; }
        if ((b.size ?? 0) > maxFileBytes) { truncated = true; continue; }
        const blob = await api(`/repos/${repo(id)}/git/blobs/${b.sha}`);
        if (!blob.ok) continue;
        const bd = d(blob);
        if (bd.encoding !== 'base64' || typeof bd.content !== 'string') continue;
        let content: string;
        try { content = b64decode((bd.content as string).replace(/\n/g, '')); } catch { continue; }
        if (content.includes(' ')) continue; // binary guard
        if (total + content.length > maxTreeBytes) { truncated = true; break; }
        files[b.path] = content;
        total += content.length;
        count += 1;
      }
      return { ok: true, sha, files, truncated };
    },

    /** Set a GitHub Actions variable on a repo (not encrypted — for non-secret config). */
    async setRepoVariable(id: string, name: string, value: string): Promise<GhResult> {
      const res = await api(`/repos/${repo(id)}/actions/variables/${name}`, {
        method: 'PATCH',
        body: { name, value },
      });
      if (res.ok) return res;
      // Create if it doesn't exist (PATCH returns 404 for new variables)
      return api(`/repos/${repo(id)}/actions/variables`, {
        method: 'POST',
        body: { name, value },
      });
    },
  };
}
