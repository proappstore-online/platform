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

/** RPC entrypoints (#254): methods are called directly in Node tests; `ctx.props` is whatever the test passes. */
export class WorkerEntrypoint<Env = unknown, _Props = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}

export class RpcTarget {}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

// Type-only exports (WorkflowEvent, WorkflowStep) are erased at compile time, so
// they need no runtime stub.
