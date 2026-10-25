export interface OperatorGate { prefix: string; role: string }

const OPERATOR_PREFIX = /^(\/[a-z0-9][a-z0-9_-]*)+$/;
export const OPERATOR_ROLE = /^[a-z][a-z0-9_-]{0,49}$/;

/**
 * Validate `operator` (#229): a path prefix the host serves only to holders of
 * one app role. Segments start with [a-z0-9], so the platform's own `/.pas` and
 * `/__qa` paths can never be declared. `member` is refused — every signed-in
 * user holds it.
 */
export function validateOperatorGate(operator: unknown): { error: string } | { gate: OperatorGate | null } {
  if (operator === undefined || operator === null) return { gate: null };
  if (typeof operator !== 'object' || Array.isArray(operator)) return { error: 'operator must be an object' };
  const { prefix, role } = operator as Record<string, unknown>;
  if (typeof prefix !== 'string' || prefix.length > 100 || !OPERATOR_PREFIX.test(prefix)) {
    return { error: 'operator.prefix must be a path like /admin (lowercase segments [a-z0-9_-], max 100 chars)' };
  }
  if (typeof role !== 'string' || !OPERATOR_ROLE.test(role)) return { error: 'operator.role must be an app role name ([a-z][a-z0-9_-], max 50 chars)' };
  if (role === 'member') return { error: "operator.role cannot be 'member' (every signed-in user holds it)" };
  return { gate: { prefix, role } };
}
