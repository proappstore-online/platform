// MCP safety layer — audit logging, read-only mode, redaction, confirm gates.
//
// Vendored from the PAGS MCP server and adapted for PAS's single-admin trust
// model: no scope taxonomy (every caller is the app owner/operator), just the
// pieces that matter when an autonomous agent is the caller —
//   1. audit:     every mutating tool call recorded, attributed to the user id.
//   2. read-only: MCP_READ_ONLY=1 blocks all mutating tools (server-wide).
//   3. confirm:   destructive tools require an explicit confirm: true.
//   4. redaction: tokens/secrets stripped before they hit the log.
//
// Audit rows live in OAUTH_KV (already bound) keyed by the verified PAS user id,
// with 90-day retention. No user id (unauthenticated) or no KV → audit() no-ops,
// the same graceful degradation PAGS uses.

export interface SafetyEnv {
  OAUTH_KV?: KVNamespace;
  MCP_READ_ONLY?: string;
}

export interface SafetyContext {
  env: SafetyEnv;
  subject?: string | null;
}

export function isReadOnly(env: SafetyEnv): boolean {
  return env.MCP_READ_ONLY === "1" || env.MCP_READ_ONLY === "true";
}

const AUDIT_TTL_SECONDS = 90 * 86_400;

/**
 * Gate a mutating tool: in read-only mode, audit the denial and throw (the MCP
 * SDK converts the throw into an isError tool result, so a caller that ignores
 * the response can't silently report success). Otherwise record an `invoked`
 * audit row. Call once at the top of every mutating tool handler.
 */
export async function gateMutation(
  ctx: SafetyContext,
  tool: string,
  input?: Record<string, unknown>,
): Promise<void> {
  if (isReadOnly(ctx.env)) {
    await audit(ctx, { tool, action: "denied", reason: "read_only", input });
    throw new Error(
      `MCP is in read-only mode (MCP_READ_ONLY); ${tool} is a mutating tool and was blocked.`,
    );
  }
  await audit(ctx, { tool, action: "invoked", input });
}

export async function audit(
  ctx: SafetyContext,
  event: Record<string, unknown>,
): Promise<void> {
  if (!ctx.env.OAUTH_KV || !ctx.subject) return;
  const now = new Date().toISOString();
  const key = `audit:${ctx.subject}:${now}:${crypto.randomUUID()}`;
  try {
    await ctx.env.OAUTH_KV.put(
      key,
      JSON.stringify({
        time: now,
        subject: ctx.subject,
        ...(redact(event) as Record<string, unknown>),
      }),
      { expirationTtl: AUDIT_TTL_SECONDS },
    );
  } catch {
    // Audit is best-effort; never let a logging failure break a tool call.
  }
}

export async function listAuditEvents(
  ctx: SafetyContext,
  limit = 50,
): Promise<unknown[]> {
  if (!ctx.env.OAUTH_KV || !ctx.subject) return [];
  const safeLimit = Math.max(1, Math.min(200, limit));
  const listed = await ctx.env.OAUTH_KV.list({
    prefix: `audit:${ctx.subject}:`,
    limit: safeLimit,
  });
  const rows = await Promise.all(
    listed.keys
      .sort((a, b) => b.name.localeCompare(a.name)) // newest first
      .slice(0, safeLimit)
      .map(async (key) => {
        const raw = await ctx.env.OAUTH_KV?.get(key.name);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return { raw };
        }
      }),
  );
  return rows.filter((row) => row !== null);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|credential|authorization/i.test(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}
