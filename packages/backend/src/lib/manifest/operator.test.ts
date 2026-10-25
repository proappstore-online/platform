import { describe, expect, it } from 'vitest';
import { validateOperatorGate } from './operator.js';

describe('validateOperatorGate', () => {
  it('treats an absent operator as no gate', () => {
    expect(validateOperatorGate(undefined)).toEqual({ gate: null });
    expect(validateOperatorGate(null)).toEqual({ gate: null });
  });

  it('accepts a prefix and an app role', () => {
    expect(validateOperatorGate({ prefix: '/admin', role: 'admin' })).toEqual({ gate: { prefix: '/admin', role: 'admin' } });
    expect(validateOperatorGate({ prefix: '/ops/tools', role: 'staff_1' })).toEqual({ gate: { prefix: '/ops/tools', role: 'staff_1' } });
  });

  it('refuses the platform paths, a bad prefix and a non-object', () => {
    expect(validateOperatorGate('admin')).toEqual({ error: 'operator must be an object' });
    for (const prefix of ['/.pas', '/__qa', 'admin', '/Admin', '/admin/']) {
      expect(validateOperatorGate({ prefix, role: 'admin' }), prefix).toMatchObject({ error: expect.stringContaining('operator.prefix') });
    }
  });

  it("refuses 'member' and a malformed role", () => {
    expect(validateOperatorGate({ prefix: '/admin', role: 'member' })).toEqual({ error: "operator.role cannot be 'member' (every signed-in user holds it)" });
    expect(validateOperatorGate({ prefix: '/admin', role: 'Admin' })).toMatchObject({ error: expect.stringContaining('operator.role') });
  });
});
