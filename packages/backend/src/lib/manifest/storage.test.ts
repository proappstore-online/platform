import { describe, expect, it } from 'vitest';
import type { DeclaredRole } from './roles.js';
import { validateStorage } from './storage.js';

const declared = (...ids: string[]): DeclaredRole[] => ids.map((id) => ({ id, label: id, description: null, requires: [] }));

describe('validateStorage (#696)', () => {
  it('an absent block declares nothing: the team keeps setting review roles at runtime', () => {
    expect(validateStorage(undefined, null)).toEqual({ storage: null });
    expect(validateStorage(null, declared('ops'))).toEqual({ storage: null });
  });

  it('accepts { review_roles } and drops repeats; an empty list declares that nobody reviews', () => {
    expect(validateStorage({ review_roles: ['ops', 'ops', 'verifier'] }, null)).toEqual({ storage: { review_roles: ['ops', 'verifier'] } });
    expect(validateStorage({ review_roles: [] }, declared('ops'))).toEqual({ storage: { review_roles: [] } });
  });

  it('follows PUT storage-config’s rules for the list', () => {
    expect(validateStorage([], null)).toEqual({ error: 'storage must be an object { review_roles }' });
    expect(validateStorage('ops', null)).toEqual({ error: 'storage must be an object { review_roles }' });
    expect(validateStorage({ review_roles: ['ops'], retention: 7 }, null)).toEqual({ error: 'storage: unknown field "retention"' });
    const shape = { error: 'storage.review_roles must be an array of up to 10 app role names' };
    expect(validateStorage({}, null)).toEqual(shape);
    expect(validateStorage({ review_roles: 'ops' }, null)).toEqual(shape);
    expect(validateStorage({ review_roles: ['Bad Role'] }, null)).toEqual(shape);
    expect(validateStorage({ review_roles: Array.from({ length: 11 }, (_, i) => `r${i}`) }, null)).toEqual(shape);
    expect(validateStorage({ review_roles: ['member'] }, null)).toEqual({ error: "storage.review_roles cannot include 'member' (every signed-in user holds it)" });
  });

  it('when the app declares roles, every review role must be one of them', () => {
    expect(validateStorage({ review_roles: ['ops'] }, declared('ops', 'ops_pii'))).toEqual({ storage: { review_roles: ['ops'] } });
    expect(validateStorage({ review_roles: ['ops', 'opps'] }, declared('ops'))).toEqual({ error: 'storage.review_roles: role "opps" is not declared in roles' });
    // Without a roles block a role name stays a free string, as on PUT storage-config.
    expect(validateStorage({ review_roles: ['opps'] }, null)).toEqual({ storage: { review_roles: ['opps'] } });
  });
});
