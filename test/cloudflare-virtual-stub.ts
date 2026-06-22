/**
 * Node-test stub for the workerd-only virtual modules `cloudflare:workers` and
 * `cloudflare:workflows`. Aliased in vitest.config.ts so test files that import a
 * Worker entrypoint (which re-exports a WorkflowEntrypoint subclass) can load
 * under the Node runner. Only the runtime values need to exist — the durable
 * step logic itself is tested directly (pollCiToVerdict / runProvisionSteps), not
 * through these.
 */

export class WorkflowEntrypoint<_Env = unknown, _Params = unknown> {
  constructor(
    public ctx?: unknown,
    public env?: unknown,
  ) {}
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// Type-only exports (WorkflowEvent, WorkflowStep) are erased at compile time, so
// they need no runtime stub.
