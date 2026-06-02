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
}

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
      return {
        ok: true,
        status: r.status,
        sha: data.sha as string,
        content: data.content ? b64decode((data.content as string).replace(/\n/g, '')) : undefined,
      };
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
      let ref = await api(`/repos/${r}/git/ref/heads/main`);
      if (!ref.ok || !(d(ref).object as { sha?: string } | undefined)?.sha) {
        if (!opts?.initIfEmpty) return { ok: false, error: 'repo has no main ref (not initialized)' };
        await api(`/repos/${r}/contents/README.md`, {
          method: 'PUT',
          body: { message: 'Initialize repo', content: b64encode('# Initial commit\n') },
        });
        await sleep(1000);
        ref = await api(`/repos/${r}/git/ref/heads/main`);
      }
      const parentSha = (d(ref).object as { sha?: string } | undefined)?.sha;

      const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
      for (const f of files) {
        const blob = await api(`/repos/${r}/git/blobs`, { method: 'POST', body: { content: f.content, encoding: 'utf-8' } });
        const blobSha = (d(blob).sha as string | undefined);
        if (!blobSha) return { ok: false, error: `blob failed for ${f.path}` };
        treeItems.push({ path: f.path, mode: '100644', type: 'blob', sha: blobSha });
      }

      let baseTree: string | undefined;
      if (parentSha) {
        const parent = await api(`/repos/${r}/git/commits/${parentSha}`);
        baseTree = (d(parent).tree as { sha?: string } | undefined)?.sha;
      }
      const tree = await api(`/repos/${r}/git/trees`, {
        method: 'POST',
        body: baseTree ? { base_tree: baseTree, tree: treeItems } : { tree: treeItems },
      });
      const treeSha = d(tree).sha as string | undefined;
      if (!treeSha) return { ok: false, error: 'tree creation failed' };

      const commit = await api(`/repos/${r}/git/commits`, {
        method: 'POST',
        body: { message, tree: treeSha, parents: parentSha ? [parentSha] : [] },
      });
      const commitSha = d(commit).sha as string | undefined;
      if (!commitSha) return { ok: false, error: 'commit creation failed' };

      const upd = await api(`/repos/${r}/git/refs/heads/main`, { method: 'PATCH', body: { sha: commitSha } });
      if (!upd.ok) return { ok: false, error: 'ref update failed' };
      return { ok: true, commitSha };
    },

    async getDeployStatus(id, perPage = 3) {
      return api(`/repos/${repo(id)}/actions/runs?per_page=${perPage}`);
    },
  };
}
