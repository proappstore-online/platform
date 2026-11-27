import { beforeEach, describe, expect, it } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { ownContributorReputation } from '../lib/contributor-reputation.js';

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const now = Date.now();
const read = (uid = 'gh:1') => ownContributorReputation(db, uid, now);

beforeEach(() => {
  db = sqliteD1();
  env = makeEnv({ DB: db }) as Env;
  db.sql.exec(`INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
    ('gh:1','github','1','renamed-person',0,0),('gh:2','github','2','other',0,0),('google:1','google','1','renamed-person',0,0);
    INSERT INTO apps (id,creator_id,created_at) VALUES ('alpha','gh:1',0),('beta','gh:2',0),('private-other','gh:2',0);
    INSERT INTO team_members(app_id,user_id,role,created_at) VALUES ('beta','gh:1','developer',1234);`);
});

function evidence(appId: string, repoId: number, sha = appId) {
  db.sql.prepare(`INSERT INTO project_repositories(app_id,github_repo_id,full_name,source,status,verified_at,created_at,updated_at)
    VALUES (?,?,?,'convention','verified',?,?,?)`).run(appId, repoId, `org/${appId}`, now, now, now);
  db.sql.prepare(`INSERT INTO project_contribution_sync(app_id,github_repo_id,policy_version,state,backfill_complete,last_attempt_at,last_success_at,updated_at)
    VALUES (?,?,1,'complete',1,?,?,?)`).run(appId, repoId, now, now, now);
  db.sql.prepare(`INSERT INTO project_commits(github_repo_id,sha,app_id,author_github_id,author_login,author_kind,authored_at,parent_count,counted,additions,deletions,files_counted,policy_version,ingested_at)
    VALUES (?,?,?,1,'old-login','user',?,1,1,12,3,1,1,?)`).run(repoId, sha, appId, now - 1000, now);
}

describe('own developer reputation (#586)', () => {
  it('includes only current authorized apps and never treats unread history as zero', async () => {
    const r = await read();
    expect(r.apps.map((a) => [a.app_id, a.role, a.membership_observed_since])).toEqual([['alpha', 'owner', null], ['beta', 'developer', 1234]]);
    expect(r.apps.every((a) => a.state === 'unavailable' && a.counts === null)).toBe(true);
    expect(r.badges).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('private-other');
  });

  it('attributes by verified numeric identity despite renamed logins, and derives reversible distinct-repository badges', async () => {
    evidence('alpha', 101); evidence('beta', 102);
    let r = await read();
    expect(r.apps[0]).toMatchObject({ state: 'ok', verified: true, counts: { commits: 1, additions: 12, deletions: 3 }, first_recorded_commit_at: now - 1000 });
    expect(r.badges.map((b) => b.id)).toEqual(['code-contributor', 'multi-app-contributor']);
    db.sql.exec("UPDATE project_commits SET reachable=0 WHERE app_id='beta'");
    r = await read();
    expect(r.apps[1]).toMatchObject({ state: 'empty', counts: { commits: 0, additions: 0, deletions: 0 } });
    expect(r.badges.map((b) => b.id)).toEqual(['code-contributor']);
    db.sql.exec("DELETE FROM team_members WHERE app_id='beta'");
    expect((await read()).apps.map((a) => a.app_id)).toEqual(['alpha']);
  });

  it('does not award multi-app credit twice for the same immutable repository', async () => {
    evidence('alpha', 101); evidence('beta', 101);
    const r = await read();
    expect(r.summary.verified_contributed_repositories).toBe(1);
    expect(r.badges.map((b) => b.id)).toEqual(['code-contributor']);
  });

  it.each([
    ["UPDATE project_commits SET author_kind='bot'", 'empty'],
    ["UPDATE project_commits SET author_github_id=2", 'empty'],
    ["UPDATE project_commits SET counted=0", 'empty'],
    ["UPDATE project_commits SET files_counted=0", 'empty'],
    ["UPDATE project_commits SET reachable=0", 'empty'],
    ["UPDATE project_commits SET files_truncated=1", 'partial'],
    ["UPDATE project_commits SET policy_version=0", 'unavailable'],
    ["UPDATE project_contribution_sync SET policy_version=0", 'unavailable'],
    ["UPDATE project_contribution_sync SET github_repo_id=999", 'unavailable'],
    ["UPDATE project_repositories SET status='identity_changed'", 'unavailable'],
    ["UPDATE project_contribution_sync SET backfill_complete=0", 'partial'],
    ["UPDATE project_contribution_sync SET last_success_at=1", 'stale'],
    ["UPDATE project_contribution_sync SET last_error='access_lost:private detail'", 'stale'],
  ])('withholds badges for ineligible or incomplete evidence: %s', async (sql, state) => {
    evidence('alpha', 101);
    db.sql.exec(sql);
    const r = await read();
    expect(r.apps[0]!.state).toBe(state);
    expect(r.badges).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('private detail');
  });

  it('does not infer identity from a same-named Google account or inconsistent provider record', async () => {
    evidence('alpha', 101);
    db.sql.exec("INSERT INTO team_members(app_id,user_id,role,created_at) VALUES ('alpha','google:1','developer',0)");
    expect(await read('google:1')).toMatchObject({ identity: 'unlinked', badges: [], apps: [{ counts: null }] });
    db.sql.exec("UPDATE users SET provider_id='2' WHERE id='gh:1'");
    expect(await read()).toMatchObject({ identity: 'unlinked', badges: [] });
  });

  it.each(['running', 'incomplete'])('withholds badges while a %s rewrite still has the prior fresh completion flag', async (state) => {
    evidence('alpha', 101);
    db.sql.prepare("UPDATE project_contribution_sync SET state=?, walk_id='new-walk', rewrite_detected_at=?").run(state, now);
    db.sql.exec("INSERT INTO project_commits SELECT github_repo_id,'replacement',app_id,author_github_id,author_login,author_kind,authored_at,parent_count,counted,20,2,files_counted,files_excluded,co_authors,files_truncated,policy_version,reachable,'new-walk',ingested_at FROM project_commits WHERE sha='alpha'");
    const r = await read();
    expect(r.apps[0]).toMatchObject({ state: 'partial', verified: false, counts: { commits: 2 } });
    expect(r.badges).toEqual([]);
  });

  it.each([1, 2])('does not hide truncated zero-eligible-file commits by author %s when deriving badges', async (author) => {
    evidence('alpha', 101);
    db.sql.prepare("INSERT INTO project_commits SELECT github_repo_id,'truncated',app_id,?,author_login,author_kind,authored_at,parent_count,counted,0,0,0,files_excluded,co_authors,1,policy_version,reachable,walk_id,ingested_at FROM project_commits WHERE sha='alpha'").run(author);
    const r = await read();
    expect(r.apps[0]).toMatchObject({ state: 'partial', verified: false, counts: { commits: 1 } });
    expect(r.badges).toEqual([]);
  });

  it('ignores unknown member roles and never grants administrators an ecosystem-wide view', async () => {
    db.sql.exec("UPDATE team_members SET role='unknown' WHERE app_id='beta'");
    const token = await mintSession({ uid: 'gh:1', roles: ['admin'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
    const r = await app.request('/v1/me/developer-reputation?user_id=gh:2', { headers: { Authorization: `Bearer ${token}` } }, env);
    expect(r.status).toBe(200);
    expect(r.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await r.json() as Awaited<ReturnType<typeof read>>).apps.map((a) => a.app_id)).toEqual(['alpha']);
  });

  it('requires an explicit first-party person session and refuses app-bound and workload credentials', async () => {
    expect((await app.request('/v1/me/developer-reputation', {}, env)).status).toBe(401);
    for (const claims of [
      {}, { via: 'worker' }, { cred: credentialContext('app_origin_session', 'alpha') },
      { cred: credentialContext('first_party_session'), via: 'worker' },
    ]) {
      const token = await mintSession({ uid: 'gh:1', roles: ['user'], ...claims }, env.SESSION_SIGNING_KEY);
      const res = await app.request('/v1/me/developer-reputation', { headers: { Authorization: `Bearer ${token}` } }, env);
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
  });
});
