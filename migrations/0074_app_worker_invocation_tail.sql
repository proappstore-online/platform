-- #308: what the app worker itself did during an invocation, as its Tail Worker
-- (AppWorkerTail, attached through the loader's WorkerCode.tails) reports it.
--
-- Additive only. All NULL until the tail event arrives, which is after the
-- invocation finishes, and stay NULL where no tail ran (no ctx.exports).
--
--   child_cpu_ms   the dynamic worker's own cpuTime. It excludes module start-up
--                  (#305), and the parent's cpuTime never included it.
--   child_wall_ms  the dynamic worker's wallTime.
--   child_outcome  the runtime's outcome: ok, exception, exceededCpu, canceled, …
--
-- The worker's console output lands in app_logs (category `worker`, source
-- `worker-console`) with trace_id = the invocation id; the index below serves
-- GET /v1/apps/:appId/logs?trace_id=<invocation id>.
ALTER TABLE app_worker_invocations ADD COLUMN child_cpu_ms INTEGER;
ALTER TABLE app_worker_invocations ADD COLUMN child_wall_ms INTEGER;
ALTER TABLE app_worker_invocations ADD COLUMN child_outcome TEXT;
CREATE INDEX IF NOT EXISTS idx_app_logs_app_trace ON app_logs (app_id, trace_id);
