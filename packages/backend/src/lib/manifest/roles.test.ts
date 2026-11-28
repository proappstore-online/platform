import { describe, expect, it } from 'vitest';
import type { ToolManifest } from '../action-sql.js';
import type { OperatorViewContract } from '../operator-contract-shared.js';
import { dependentRoles, requiredRoles, validateRoles, type DeclaredRole } from './roles.js';

const OPS = { id: 'ops', label: 'Operations' };
const PII = { id: 'ops_pii', label: 'Rider PII', description: 'Sees rider phone numbers', requires: ['ops'] };
const tool = (name: string, appRoles?: string[]): ToolManifest =>
  ({ name, description: name, operation: 'query', sql: 'SELECT 1', requires_auth: true, ...(appRoles ? { auth: { app_roles: appRoles } } : {}) }) as ToolManifest;
const view = (adminRoles?: string[], auditRoles?: string[]): OperatorViewContract => ({
  version: 1, resources: [], actions: [],
  ...(adminRoles ? { admin_access: { roles: adminRoles } } : {}),
  ...(auditRoles ? { audit: { app_roles: auditRoles } } : {}),
});

describe('validateRoles (#695)', () => {
  it('an absent block declares nothing, and leaves role references unchecked', () => {
    expect(validateRoles(undefined, [tool('a', ['typo'])], view(['typo']))).toEqual({ roles: null });
    expect(validateRoles(null, [], null)).toEqual({ roles: null });
  });

  it('accepts { id, label, description?, requires? } and normalises them', () => {
    expect(validateRoles([OPS, PII], [tool('rides', ['ops']), tool('riders', ['ops_pii', 'member'])], view(['ops'], ['ops']))).toEqual({
      roles: [
        { id: 'ops', label: 'Operations', description: null, requires: [] },
        { id: 'ops_pii', label: 'Rider PII', description: 'Sees rider phone numbers', requires: ['ops'] },
      ],
    });
  });

  it('refuses malformed entries', () => {
    expect(validateRoles([], [], null)).toMatchObject({ error: expect.stringContaining('roles must be an array of 1-50') });
    expect(validateRoles({}, [], null)).toMatchObject({ error: expect.stringContaining('roles must be an array') });
    expect(validateRoles(['ops'], [], null)).toEqual({ error: 'roles[0] must be an object' });
    expect(validateRoles([{ ...OPS, scope: 'app' }], [], null)).toEqual({ error: 'roles[0]: unknown field "scope"' });
    expect(validateRoles([{ ...OPS, id: 'Ops' }], [], null)).toMatchObject({ error: expect.stringContaining('roles[0].id must match') });
    expect(validateRoles([{ ...OPS, label: ' ' }], [], null)).toMatchObject({ error: expect.stringContaining('roles[0].label') });
    expect(validateRoles([{ ...OPS, description: 3 }], [], null)).toMatchObject({ error: expect.stringContaining('roles[0].description') });
    expect(validateRoles([{ ...OPS, requires: 'ops' }], [], null)).toMatchObject({ error: expect.stringContaining('roles[0].requires') });
    expect(validateRoles([OPS, OPS], [], null)).toEqual({ error: 'roles[1]: duplicate id "ops"' });
  });

  it('refuses the platform-managed names', () => {
    for (const id of ['owner', 'member']) {
      expect(validateRoles([{ id, label: id }], [], null)).toEqual({ error: `roles[0].id "${id}" is managed by the platform and cannot be declared` });
    }
  });

  it('requires names declared roles and forms no cycle', () => {
    expect(validateRoles([{ ...PII, requires: ['opps'] }], [], null)).toEqual({ error: 'roles[0].requires: "opps" is not a declared role' });
    expect(validateRoles([{ id: 'a', label: 'A', requires: ['a'] }], [], null)).toEqual({ error: 'roles: requires forms a cycle (a -> a)' });
    expect(validateRoles([
      { id: 'a', label: 'A', requires: ['b'] },
      { id: 'b', label: 'B', requires: ['c'] },
      { id: 'c', label: 'C', requires: ['a'] },
    ], [], null)).toEqual({ error: 'roles: requires forms a cycle (a -> b -> c -> a)' });
  });

  it('every role the manifest gates on must be declared', () => {
    expect(validateRoles([OPS], [tool('rides', ['opps'])], null)).toEqual({ error: 'action "rides" auth.app_roles: role "opps" is not declared in roles' });
    expect(validateRoles([OPS], [tool('rides', ['owner'])], null)).toEqual({ error: 'action "rides" auth.app_roles: role "owner" is not declared in roles' });
    expect(validateRoles([OPS], [], view(['admin']))).toEqual({ error: 'operator_view.admin_access.roles: role "admin" is not declared in roles' });
    expect(validateRoles([OPS], [], view(['ops'], ['auditor']))).toEqual({ error: 'operator_view.audit.app_roles: role "auditor" is not declared in roles' });
  });
});

describe('requiredRoles / dependentRoles (#695)', () => {
  const declared: DeclaredRole[] = [
    { id: 'ops', label: 'Ops', description: null, requires: [] },
    { id: 'ops_pii', label: 'PII', description: null, requires: ['ops'] },
    { id: 'ops_payouts', label: 'Payouts', description: null, requires: ['ops_pii'] },
    { id: 'support', label: 'Support', description: null, requires: [] },
  ];

  it('a grant brings what the role requires, transitively', () => {
    expect(requiredRoles(declared, 'ops_payouts').sort()).toEqual(['ops', 'ops_pii']);
    expect(requiredRoles(declared, 'ops')).toEqual([]);
    expect(requiredRoles(declared, 'undeclared')).toEqual([]);
  });

  it('a revoke takes the declared roles that require it, transitively', () => {
    expect(dependentRoles(declared, 'ops').sort()).toEqual(['ops_payouts', 'ops_pii']);
    expect(dependentRoles(declared, 'ops_payouts')).toEqual([]);
    expect(dependentRoles(declared, 'support')).toEqual([]);
  });
});
