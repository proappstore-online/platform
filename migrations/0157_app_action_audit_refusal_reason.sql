-- #697: the reason an operator-view action declared for a refusal. When a
-- guarded transition changes nothing and one of the contract action's
-- `refusals` holds, its message is the 409's `reason` and is recorded here on
-- that refusal row. NULL for every other row, including a refusal no declared
-- reason explained ("the record changed since it was loaded").
ALTER TABLE app_action_audit ADD COLUMN refusal_reason TEXT;
