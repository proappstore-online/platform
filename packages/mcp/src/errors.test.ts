import { describe, expect, it } from 'vitest';
import { errText } from './errors.js';

describe('errText (#114)', () => {
  it('returns a text content block flagged isError so agents can detect failure without parsing', () => {
    expect(errText('Error: nope')).toEqual({ content: [{ type: 'text', text: 'Error: nope' }], isError: true });
  });
});
