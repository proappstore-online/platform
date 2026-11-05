-- #551 (epic #548): promoter contribution read models and safe public recognition. Additive only; no new base table.
--
-- Totals, shares and standings are computed from app_referral_attributions (#550) at read time, so a reversal or
-- restore changes every view at once. This adds the indexes those reads need, and one opt-in flag.

-- Period reads: confirmed and reversed credits are placed by when they were confirmed; pending and expired by when
-- they were captured. Both are per app, optionally per promoter.
CREATE INDEX IF NOT EXISTS idx_app_referral_attr_confirmed ON app_referral_attributions (app_id, status, confirmed_at);
CREATE INDEX IF NOT EXISTS idx_app_referral_attr_captured ON app_referral_attributions (app_id, status, captured_at);
CREATE INDEX IF NOT EXISTS idx_app_referral_attr_promoter_confirmed ON app_referral_attributions (app_id, promoter_id, status, confirmed_at);
-- Organic vs referred: activations in a period.
CREATE INDEX IF NOT EXISTS idx_app_user_activations_period ON app_user_activations (app_id, first_activated_at);

-- A person's separate opt-in to show their PROMOTION contribution on the public contributor card (#541/#542).
-- Sharing a name (visible) never shows promotion by itself, and it defaults off.
ALTER TABLE app_team_public_profiles ADD COLUMN show_promotion INTEGER NOT NULL DEFAULT 0 CHECK (show_promotion IN (0, 1));

-- Withdrawing as a promoter withdraws the promotion card, and re-enrolling does not bring it back: the person
-- must choose to show it again. Their team visibility (visible) is theirs and is left alone.
CREATE TRIGGER IF NOT EXISTS clear_promotion_card_on_promoter_withdrawal
AFTER UPDATE OF status ON app_promoters
WHEN NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn'
BEGIN
  UPDATE app_team_public_profiles SET show_promotion = 0, updated_at = datetime('now')
   WHERE app_id = NEW.app_id AND user_id = NEW.user_id AND show_promotion = 1;
END;
