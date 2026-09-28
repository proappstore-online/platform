-- Operator context on the success audit (#240, reports & suspensions slice).
-- Calls made from the console operator view record which contract action or
-- read ran (`operator_action`, e.g. `suspend_member`, `read:members`,
-- `detail:members`) and the record it targeted (`target`: the value of the
-- column the contract names, e.g. the suspended user's id). NULL for every
-- other call. Still no other params, SQL or results.
ALTER TABLE app_action_audit ADD COLUMN operator_action TEXT;
ALTER TABLE app_action_audit ADD COLUMN target TEXT;
