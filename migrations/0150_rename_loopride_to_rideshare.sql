-- Refs proappstore-online/platform#670: the Rideshare app's platform ID moves from
-- `loopride` to `rideshare` (repo proappstore-online/loopride -> /rideshare).
-- Child tables reference apps(id) without ON UPDATE CASCADE, so FK checks are
-- deferred to commit. Order matters for the 0136 canonical-alias triggers (below). History/usage rows move too,
-- so the app keeps one identity. Production had no app_user_secrets (whose AAD
-- binds the app ID) and no `rideshare` rows when this was written.
PRAGMA defer_foreign_keys = ON;

-- The domain triggers see a canonical row being moved as a clash with itself,
-- so it moves non-canonical and is re-declared once apps/routes are renamed.
UPDATE app_custom_domains SET canonical = 0 WHERE app_id = 'loopride' AND canonical = 1 AND domain = 'rideshare.proappstore.online';
UPDATE app_custom_domains SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE apps SET id = 'rideshare' WHERE id = 'loopride';
UPDATE routes SET slug = 'rideshare', r2_prefix = 'apps/rideshare' WHERE slug = 'loopride';
UPDATE app_custom_domains SET canonical = 1 WHERE app_id = 'rideshare' AND domain = 'rideshare.proappstore.online';
UPDATE account_audit_events SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE agent_projects SET slug = 'rideshare' WHERE slug = 'loopride';
UPDATE app_access_grants SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_action_audit SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_alerts SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_analytics SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_billing SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_billing_events SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_billing_prices SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_billing_products SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_billing_products_test SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_connector_installations SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_connectors SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_embed SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_endpoint_audit SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_enquiries SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_entitlements SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_go_live SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_group_admin_grants SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_hook_deliveries SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_hooks SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_incidents SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_invite_policies SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_isolation SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_listings SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_log_usage SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_logs SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_marketing_deploys SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_marketing_deploys SET repository = 'proappstore-online/rideshare' WHERE repository = 'proappstore-online/loopride';
UPDATE app_marketing_sites SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_metric_buckets SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_operator_gate SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_operator_view SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_ownership_audit SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_ownership_transfers SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_page_meta SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_pags_bindings SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_permissions SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_promoter_events SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_promoter_settings SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_promoters SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_proxy_allowlist SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_proxy_usage SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_proxy_usage_user SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_purchases SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_referral_attributions SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_referral_events SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_referral_readiness SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_reliability_objectives SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_roles SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_room_publish_usage SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_room_rules SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_secrets SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_sitemap SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_storage_config SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_storefront_publication SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_team_public_profiles SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_test_flows SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_test_runs SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_tools SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_user_activations SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_user_secret_decls SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_user_secrets SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_visibility SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_webhooks SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_worker_deploys SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_worker_deploys SET repository = 'proappstore-online/rideshare' WHERE repository = 'proappstore-online/loopride';
UPDATE app_worker_invocations SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_worker_manifest SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_worker_schedules SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_worker_usage SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE app_workers SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE counters SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE deploy_audit SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE deploy_audit SET repository = 'proappstore-online/rideshare' WHERE repository = 'proappstore-online/loopride';
UPDATE email_app_settings SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_domains SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_identities SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_inbound SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_send_events SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_sends SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_suppressions SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE email_usage SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE engagements SET project_slug = 'rideshare' WHERE project_slug = 'loopride';
UPDATE google_calendar_app_authorizations SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE google_calendar_grants SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE google_calendar_oauth_states SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE invites SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE kb_shares SET project_slug = 'rideshare' WHERE project_slug = 'loopride';
UPDATE kv SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE licenses SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE migration_audit SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE native_grants SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE native_relays SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE notification_email_optout SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE notification_log SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE oidc_session_grants SET repository = 'proappstore-online/rideshare' WHERE repository = 'proappstore-online/loopride';
UPDATE oidc_session_mints SET repository = 'proappstore-online/rideshare' WHERE repository = 'proappstore-online/loopride';
UPDATE per_app_deleted_users SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE project_commits SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE project_contribution_events SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE project_contribution_sync SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE project_repositories SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE project_repositories SET full_name = 'proappstore-online/rideshare' WHERE full_name = 'proappstore-online/loopride';
UPDATE provision_admissions SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE provision_operations SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE provisioning_plans SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE push_subscriptions SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE qa_api_keys SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE release_sourcemap_manifests SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE scheduled_action_runs SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE scheduled_action_state SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE sms_usage SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE storage_review_access SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE submissions SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE team_invites SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE team_members SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE telemetry_health SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE usage_daily SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE user_app_tokens SET app_id = 'rideshare' WHERE app_id = 'loopride';
UPDATE users SET credential_app_id = 'rideshare' WHERE credential_app_id = 'loopride';
UPDATE release_sourcemap_manifests SET storage_key = replace(storage_key, '_sourcemaps/loopride/', '_sourcemaps/rideshare/') WHERE app_id = 'rideshare';

-- Old links keep working: the retired platform host is an exact alias that the
-- host 308-redirects to the canonical rideshare.proappstore.online.
INSERT INTO app_custom_domains (app_id, domain, status, kind, added_at, verified_at, canonical)
SELECT 'rideshare', 'loopride.proappstore.online', 'active', 'exact', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, 0
WHERE EXISTS (SELECT 1 FROM apps WHERE id = 'rideshare')
ON CONFLICT(app_id, domain) DO NOTHING;
