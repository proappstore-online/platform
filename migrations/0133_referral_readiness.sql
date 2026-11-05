-- #553: deployment-scoped, authenticated referral readiness attestations.
-- No existing app is presumed ready; no relationship or attribution is rewritten.
CREATE TABLE app_referral_readiness (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  deploy_id INTEGER NOT NULL REFERENCES deploy_audit(id),
  sdk_version TEXT NOT NULL,
  auth_mode TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  recorded_at INTEGER NOT NULL
);

-- Credential issuance cannot prove readiness. Invalidate BEFORE another upload
-- can change live assets, including a retry of the same SHA. A failed deployment
-- therefore stays unavailable until a new successful verification is reported.
CREATE TRIGGER invalidate_referral_readiness_on_deploy
AFTER INSERT ON deploy_audit
BEGIN
  DELETE FROM app_referral_readiness WHERE app_id = NEW.app_id;
END;
