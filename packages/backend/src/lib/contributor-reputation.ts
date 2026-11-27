import { contributionDataState, type ContributionStatus } from './contributions/stats.js';
import { POLICY_VERSION } from './contributions/policy.js';

// #586: the person's own, currently authorized project evidence. This is not a public directory,
// lifetime membership ledger, rating, ownership share or a grant of access.
interface ReputationRow {
  app_id: string; role: string; member_since: number | null;
  repo_id: number | null; repo_status: string | null; repo_name: string | null; branch: string | null; verified_at: number | null;
  sync_repo_id: number | null; sync_state: string | null; complete: number | null; head_sha: string | null; walk_id: string | null;
  attempted_at: number | null; refreshed_at: number | null; last_error: string | null; error_count: number | null;
  rate_limited_until: number | null; rewrite_at: number | null; next_refresh_at: number | null; policy_version: number | null;
  commits: number; additions: number; deletions: number; first_commit_at: number | null; last_commit_at: number | null; truncated: number; old_policy: number;
}

export async function ownContributorReputation(db: D1Database, userId: string, now: number) {
  // Requiring both the canonical id and the saved provider identity prevents a free-text login/email
  // (or a different provider with the same name) from claiming somebody else's Git history.
  const identity = await db.prepare("SELECT provider_id FROM users WHERE id = ?1 AND provider = 'github' AND id = 'gh:' || provider_id")
    .bind(userId).first<{ provider_id: string }>();
  const candidate = identity && /^[1-9]\d*$/.test(identity.provider_id) ? Number(identity.provider_id) : null;
  const githubId = candidate !== null && Number.isSafeInteger(candidate) ? candidate : null;
  const { results } = await db.prepare(`WITH eligible AS (
      SELECT a.id AS app_id, CASE WHEN a.creator_id = ?1 THEN 'owner' ELSE t.role END AS role,
             CASE WHEN a.creator_id = ?1 THEN NULL ELSE t.created_at END AS member_since
        FROM apps a LEFT JOIN team_members t ON t.app_id = a.id AND t.user_id = ?1
       WHERE a.creator_id = ?1 OR t.role IN ('viewer','po','developer','admin','owner')
    ), activity AS (
      SELECT c.app_id, COUNT(*) AS commits, SUM(c.additions) AS additions, SUM(c.deletions) AS deletions,
             MIN(c.authored_at) AS first_commit_at, MAX(c.authored_at) AS last_commit_at
        FROM project_commits c JOIN eligible e ON e.app_id = c.app_id
        JOIN project_repositories r ON r.app_id = c.app_id AND r.github_repo_id = c.github_repo_id
       WHERE c.author_github_id = ?2 AND c.author_kind = 'user' AND c.reachable = 1 AND c.counted = 1 AND c.files_counted > 0
       GROUP BY c.app_id
    ), coverage AS (
      SELECT c.app_id, SUM(c.files_truncated) AS truncated,
             SUM(CASE WHEN c.policy_version <> ?3 THEN 1 ELSE 0 END) AS old_policy
        FROM project_commits c JOIN eligible e ON e.app_id = c.app_id
        JOIN project_repositories r ON r.app_id = c.app_id AND r.github_repo_id = c.github_repo_id
       WHERE c.reachable = 1 AND c.counted = 1 GROUP BY c.app_id
    )
    SELECT e.*, r.github_repo_id AS repo_id, r.status AS repo_status, r.full_name AS repo_name,
           r.default_branch AS branch, r.verified_at,
           s.github_repo_id AS sync_repo_id, s.state AS sync_state, s.backfill_complete AS complete,
           s.head_sha, s.walk_id, s.last_attempt_at AS attempted_at, s.last_success_at AS refreshed_at, s.last_error,
           s.error_count, s.rate_limited_until, s.rewrite_detected_at AS rewrite_at, s.next_refresh_at, s.policy_version,
           COALESCE(c.commits, 0) AS commits, COALESCE(c.additions, 0) AS additions, COALESCE(c.deletions, 0) AS deletions,
           c.first_commit_at, c.last_commit_at, COALESCE(f.truncated, 0) AS truncated, COALESCE(f.old_policy, 0) AS old_policy
      FROM eligible e LEFT JOIN project_repositories r ON r.app_id = e.app_id
      LEFT JOIN project_contribution_sync s ON s.app_id = e.app_id LEFT JOIN activity c ON c.app_id = e.app_id
      LEFT JOIN coverage f ON f.app_id = e.app_id
     ORDER BY e.app_id`).bind(userId, githubId, POLICY_VERSION).all<ReputationRow>();

  const creditedRepos = new Set<number>();
  const apps = (results ?? []).map((r) => {
    const st: ContributionStatus = {
      repository: r.repo_name === null ? null : { full_name: r.repo_name, github_repo_id: r.repo_id, status: r.repo_status!, default_branch: r.branch, verified_at: r.verified_at },
      sync: r.sync_state === null ? null : {
        state: r.sync_state, walk_id: r.walk_id, backfill_complete: r.complete === 1, head_sha: r.head_sha,
        last_attempt_at: r.attempted_at, last_success_at: r.refreshed_at,
        error: r.last_error ? r.last_error.split(':')[0]! : null, error_count: r.error_count ?? 0,
        rate_limited_until: r.rate_limited_until, rewrite_detected_at: r.rewrite_at,
        next_refresh_at: r.next_refresh_at ?? 0, policy_version: r.policy_version ?? 0,
      },
    };
    let verdict = contributionDataState(st, r.commits, now);
    const currentRepository = r.repo_status === 'verified' && r.repo_id !== null && r.sync_repo_id === r.repo_id;
    const currentPolicy = r.policy_version === POLICY_VERSION && r.old_policy === 0;
    if (githubId === null) verdict = { state: 'unavailable', reason: 'This sign-in has no verified GitHub identity. Accounts are not matched by name or email.' };
    else if (r.repo_id !== null && !currentRepository) verdict = { state: 'unavailable', reason: 'The current repository identity is not verified and synchronized.' };
    else if (r.policy_version !== null && !currentPolicy) verdict = { state: 'unavailable', reason: 'The recorded counting policy needs a refresh.' };
    else if (r.sync_state === 'running' || r.sync_state === 'incomplete' || r.walk_id !== null) verdict = { state: 'partial', reason: 'Repository history is being reconciled; this generation is not complete.' };
    else if (r.truncated > 0 && (verdict.state === 'ok' || verdict.state === 'empty')) verdict = { state: 'partial', reason: 'Some commit files were not returned; these figures are incomplete.' };
    const verified = currentRepository && currentPolicy && r.sync_state === 'complete' && r.walk_id === null && (verdict.state === 'ok' || verdict.state === 'empty');
    if (verified && r.commits > 0) creditedRepos.add(r.repo_id!);
    const hasEvidence = githubId !== null && currentRepository && currentPolicy && r.refreshed_at !== null;
    return {
      app_id: r.app_id, role: r.role, membership_observed_since: r.member_since,
      state: verdict.state, state_reason: verdict.reason, verified,
      counts: hasEvidence ? { commits: r.commits, additions: r.additions, deletions: r.deletions } : null,
      first_recorded_commit_at: hasEvidence ? r.first_commit_at : null,
      last_recorded_commit_at: hasEvidence ? r.last_commit_at : null,
      last_refreshed_at: r.refreshed_at,
    };
  });
  const badges: { id: string; label: string; evidence: string }[] = [];
  if (creditedRepos.size >= 1) badges.push({ id: 'code-contributor', label: 'Code contributor', evidence: 'At least one eligible commit in a complete, fresh, verified repository.' });
  if (creditedRepos.size >= 2) badges.push({ id: 'multi-app-contributor', label: 'Multi-app contributor', evidence: 'Eligible commits in at least two distinct complete, fresh, verified repositories.' });
  return {
    version: 1, policy_version: POLICY_VERSION, generated_at: now,
    identity: githubId === null ? 'unlinked' : 'verified_github',
    scope: 'current_authorized_apps', apps,
    summary: { current_apps: apps.length, verified_contributed_repositories: creditedRepos.size, incomplete_apps: apps.filter((a) => !a.verified).length },
    badges,
    history_note: 'Only apps you currently own or belong to are included. Membership dates describe current rows, not lifetime participation; an owner start date is unknown. Commit dates describe recorded code activity, not role tenure. Badges are recomputed from current verified evidence and confer no access, ownership or payment rights.',
  };
}
