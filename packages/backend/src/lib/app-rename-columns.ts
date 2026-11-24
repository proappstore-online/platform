/**
 * #686 Phase 2: every registry column that can hold an app ID, and how an app-ID
 * rename (`from` -> `to`) rewrites it. The rename's switch batch is generated from
 * this table, never from runtime introspection, so a column nobody has decided on
 * is never rewritten. `app-rename-columns.test.ts` builds the schema from every
 * migration and fails when a column that looks like it holds an app ID is not
 * listed here exactly once, or when an append-only table is anything but `keep`.
 *
 * - `id`: the value is the app ID itself.
 * - `repository`: `proappstore-online/<id>`.
 * - `url`: `https://github.com/proappstore-online/<id>`.
 * - `prefix`: an R2 key under `<segment>/<id>`, rewritten at that leading segment only.
 * - `keep`: never rewritten; `reason` says why.
 *
 * Handled outside this table by the switch itself (0150's sequence):
 * `app_custom_domains.domain` (the canonical-alias dance and the old host's alias row)
 * and `app_user_secrets` ciphertext (the app ID is its AES-GCM associated data).
 */
interface AppIdColumn {
  table: string;
  column: string;
  kind: 'id' | 'repository' | 'url' | 'prefix' | 'keep';
  /** `prefix` only: the R2 key segment before the app ID. */
  segment?: string;
  /** `keep` only. */
  reason?: string;
}

const APPEND_ONLY = 'append-only history: a BEFORE UPDATE trigger refuses every update, and the row keeps the ID it was written under';
const keep = (table: string, column: string, reason: string): AppIdColumn => ({ table, column, kind: 'keep', reason });

export const APP_ID_COLUMNS: readonly AppIdColumn[] = [
  keep('account_audit_events', 'app_id', APPEND_ONLY),
  keep('accounts', 'slug', "not an app ID: the account's own handle"),
  { table: 'agent_projects', column: 'slug', kind: 'id' },
  { table: 'app_access_grants', column: 'app_id', kind: 'id' },
  { table: 'app_action_audit', column: 'app_id', kind: 'id' },
  { table: 'app_alerts', column: 'app_id', kind: 'id' },
  { table: 'app_analytics', column: 'app_id', kind: 'id' },
  { table: 'app_billing_events', column: 'app_id', kind: 'id' },
  { table: 'app_billing_prices', column: 'app_id', kind: 'id' },
  { table: 'app_billing_products_test', column: 'app_id', kind: 'id' },
  { table: 'app_billing_products', column: 'app_id', kind: 'id' },
  { table: 'app_billing', column: 'app_id', kind: 'id' },
  { table: 'app_connector_installations', column: 'app_id', kind: 'id' },
  { table: 'app_connectors', column: 'app_id', kind: 'id' },
  { table: 'app_custom_domains', column: 'app_id', kind: 'id' },
  { table: 'app_embed', column: 'app_id', kind: 'id' },
  { table: 'app_endpoint_audit', column: 'app_id', kind: 'id' },
  { table: 'app_enquiries', column: 'app_id', kind: 'id' },
  { table: 'app_entitlements', column: 'app_id', kind: 'id' },
  { table: 'app_go_live', column: 'app_id', kind: 'id' },
  { table: 'app_group_admin_grants', column: 'app_id', kind: 'id' },
  { table: 'app_hook_deliveries', column: 'app_id', kind: 'id' },
  { table: 'app_hooks', column: 'app_id', kind: 'id' },
  { table: 'app_incidents', column: 'app_id', kind: 'id' },
  { table: 'app_invite_policies', column: 'app_id', kind: 'id' },
  { table: 'app_isolation', column: 'app_id', kind: 'id' },
  { table: 'app_listings', column: 'app_id', kind: 'id' },
  { table: 'app_log_usage', column: 'app_id', kind: 'id' },
  { table: 'app_logs', column: 'app_id', kind: 'id' },
  { table: 'app_marketing_deploys', column: 'app_id', kind: 'id' },
  { table: 'app_marketing_deploys', column: 'repository', kind: 'repository' },
  { table: 'app_marketing_sites', column: 'app_id', kind: 'id' },
  { table: 'app_metric_buckets', column: 'app_id', kind: 'id' },
  { table: 'app_operator_gate', column: 'app_id', kind: 'id' },
  keep('app_operator_gate', 'path_prefix', 'not an app ID: a path inside the app, e.g. /admin'),
  { table: 'app_operator_view', column: 'app_id', kind: 'id' },
  keep('app_ownership_audit', 'app_id', APPEND_ONLY),
  { table: 'app_ownership_transfers', column: 'app_id', kind: 'id' },
  { table: 'app_page_meta', column: 'app_id', kind: 'id' },
  { table: 'app_pags_bindings', column: 'app_id', kind: 'id' },
  { table: 'app_pags_bindings', column: 'repo', kind: 'repository' },
  { table: 'app_permissions', column: 'app_id', kind: 'id' },
  keep('app_promoter_events', 'app_id', APPEND_ONLY),
  { table: 'app_promoter_settings', column: 'app_id', kind: 'id' },
  { table: 'app_promoters', column: 'app_id', kind: 'id' },
  { table: 'app_proxy_allowlist', column: 'app_id', kind: 'id' },
  { table: 'app_proxy_usage_user', column: 'app_id', kind: 'id' },
  { table: 'app_proxy_usage', column: 'app_id', kind: 'id' },
  { table: 'app_purchases', column: 'app_id', kind: 'id' },
  { table: 'app_referral_attributions', column: 'app_id', kind: 'id' },
  keep('app_referral_events', 'app_id', APPEND_ONLY),
  { table: 'app_referral_readiness', column: 'app_id', kind: 'id' },
  { table: 'app_reliability_objectives', column: 'app_id', kind: 'id' },
  { table: 'app_roles', column: 'app_id', kind: 'id' },
  { table: 'app_room_publish_usage', column: 'app_id', kind: 'id' },
  { table: 'app_room_rules', column: 'app_id', kind: 'id' },
  keep('app_room_rules', 'prefix', 'not an app ID: a room-name prefix inside the app'),
  { table: 'app_secrets', column: 'app_id', kind: 'id' },
  { table: 'app_sitemap', column: 'app_id', kind: 'id' },
  { table: 'app_storage_config', column: 'app_id', kind: 'id' },
  { table: 'app_storefront_publication', column: 'app_id', kind: 'id' },
  { table: 'app_team_public_profiles', column: 'app_id', kind: 'id' },
  { table: 'app_test_flows', column: 'app_id', kind: 'id' },
  { table: 'app_test_runs', column: 'app_id', kind: 'id' },
  keep('app_test_runs', 'artifacts_prefix', "history: each run's artifacts are read by its own stored prefix (routes/qa.ts) and stay where they are"),
  { table: 'app_tools', column: 'app_id', kind: 'id' },
  { table: 'app_user_activations', column: 'app_id', kind: 'id' },
  { table: 'app_user_secret_decls', column: 'app_id', kind: 'id' },
  { table: 'app_user_secrets', column: 'app_id', kind: 'id' },
  { table: 'app_visibility', column: 'app_id', kind: 'id' },
  { table: 'app_webhooks', column: 'app_id', kind: 'id' },
  { table: 'app_worker_deploys', column: 'app_id', kind: 'id' },
  { table: 'app_worker_deploys', column: 'repository', kind: 'repository' },
  { table: 'app_worker_invocations', column: 'app_id', kind: 'id' },
  { table: 'app_worker_manifest', column: 'app_id', kind: 'id' },
  { table: 'app_worker_schedules', column: 'app_id', kind: 'id' },
  { table: 'app_worker_usage', column: 'app_id', kind: 'id' },
  { table: 'app_workers', column: 'app_id', kind: 'id' },
  { table: 'apps', column: 'id', kind: 'id' },
  keep('apps', 'pages_project', 'legacy Cloudflare Pages project name; apps are served from R2 and no code reads it'),
  { table: 'counters', column: 'app_id', kind: 'id' },
  { table: 'deploy_audit', column: 'app_id', kind: 'id' },
  keep('deploy_audit', 'prefix', 'history: each audit row names the R2 prefix that deploy wrote, and those objects are not moved'),
  { table: 'deploy_audit', column: 'repository', kind: 'repository' },
  { table: 'email_app_settings', column: 'app_id', kind: 'id' },
  { table: 'email_domains', column: 'app_id', kind: 'id' },
  { table: 'email_identities', column: 'app_id', kind: 'id' },
  { table: 'email_inbound', column: 'app_id', kind: 'id' },
  { table: 'email_send_events', column: 'app_id', kind: 'id' },
  { table: 'email_sends', column: 'app_id', kind: 'id' },
  { table: 'email_suppressions', column: 'app_id', kind: 'id' },
  { table: 'email_usage', column: 'app_id', kind: 'id' },
  { table: 'engagements', column: 'project_slug', kind: 'id' },
  { table: 'google_calendar_app_authorizations', column: 'app_id', kind: 'id' },
  { table: 'google_calendar_grants', column: 'app_id', kind: 'id' },
  { table: 'google_calendar_oauth_states', column: 'app_id', kind: 'id' },
  { table: 'invites', column: 'app_id', kind: 'id' },
  { table: 'kb_shares', column: 'project_slug', kind: 'id' },
  keep('key_providers', 'key_prefix', 'not an app ID: the expected prefix of a provider API key, e.g. sk-'),
  { table: 'kv', column: 'app_id', kind: 'id' },
  { table: 'licenses', column: 'app_id', kind: 'id' },
  { table: 'migration_audit', column: 'app_id', kind: 'id' },
  { table: 'native_grants', column: 'app_id', kind: 'id' },
  { table: 'native_relays', column: 'app_id', kind: 'id' },
  { table: 'notification_email_optout', column: 'app_id', kind: 'id' },
  { table: 'notification_log', column: 'app_id', kind: 'id' },
  { table: 'oidc_session_grants', column: 'repository', kind: 'repository' },
  { table: 'oidc_session_mints', column: 'repository', kind: 'repository' },
  { table: 'per_app_deleted_users', column: 'app_id', kind: 'id' },
  { table: 'project_commits', column: 'app_id', kind: 'id' },
  keep('project_contribution_events', 'app_id', APPEND_ONLY),
  { table: 'project_contribution_sync', column: 'app_id', kind: 'id' },
  { table: 'project_repositories', column: 'app_id', kind: 'id' },
  { table: 'project_repositories', column: 'full_name', kind: 'repository' },
  { table: 'provision_admissions', column: 'app_id', kind: 'id' },
  { table: 'provision_operations', column: 'app_id', kind: 'id' },
  { table: 'provisioning_plans', column: 'app_id', kind: 'id' },
  { table: 'push_subscriptions', column: 'app_id', kind: 'id' },
  { table: 'qa_api_keys', column: 'app_id', kind: 'id' },
  { table: 'release_sourcemap_manifests', column: 'app_id', kind: 'id' },
  { table: 'release_sourcemap_manifests', column: 'storage_key', kind: 'prefix', segment: '_sourcemaps' },
  { table: 'routes', column: 'r2_prefix', kind: 'prefix', segment: 'apps' },
  { table: 'routes', column: 'slug', kind: 'id' },
  { table: 'scheduled_action_runs', column: 'app_id', kind: 'id' },
  { table: 'scheduled_action_state', column: 'app_id', kind: 'id' },
  { table: 'sms_usage', column: 'app_id', kind: 'id' },
  { table: 'storage_review_access', column: 'app_id', kind: 'id' },
  { table: 'submissions', column: 'app_id', kind: 'id' },
  { table: 'submissions', column: 'repo_url', kind: 'url' },
  { table: 'team_invites', column: 'app_id', kind: 'id' },
  { table: 'team_members', column: 'app_id', kind: 'id' },
  { table: 'telemetry_health', column: 'app_id', kind: 'id' },
  keep('test_principals', 'slug', "not an app ID: the CI test principal's own handle"),
  { table: 'usage_daily', column: 'app_id', kind: 'id' },
  { table: 'user_app_tokens', column: 'app_id', kind: 'id' },
  { table: 'users', column: 'credential_app_id', kind: 'id' },
];
