import { describe, expect, it } from 'vitest';
import { firstHeld, type HeldAppRoles } from './held-app-roles.js';

describe('firstHeld (#695)', () => {
  const held: HeldAppRoles = new Map([['ops', 'owner'], ['support', 'grant']]);

  it('names the role that admitted the caller and whether ownership supplied it', () => {
    expect(firstHeld(held, ['ops'])).toEqual({ role: 'ops', viaOwner: true });
    expect(firstHeld(held, ['support'])).toEqual({ role: 'support', viaOwner: false });
    expect(firstHeld(held, ['editor'])).toBeNull();
    expect(firstHeld(held, [])).toBeNull();
  });

  it('prefers a granted role over an owner-implied one, whatever the gate lists first', () => {
    expect(firstHeld(held, ['ops', 'support'])).toEqual({ role: 'support', viaOwner: false });
  });
});
