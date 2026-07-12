import { describe, expect, it } from 'vitest';
import { validateFlow } from './validate.js';
import { MAX_STEPS } from './types.js';

const base = { id: 'sign-in', name: 'Sign in works', steps: [{ op: 'expectText', text: 'Sign in' }] };

describe('validateFlow', () => {
  it('accepts a minimal valid flow', () => {
    expect(validateFlow(base)).toBeNull();
  });

  it('accepts every step shape', () => {
    expect(validateFlow({
      ...base,
      startPath: '/puzzles',
      steps: [
        { op: 'goto', path: '/puzzles' },
        { op: 'click', target: { text: 'Sign in' } },
        { op: 'click', target: { label: 'Login' } },
        { op: 'click', target: { selector: '#go' } },
        { op: 'clickPoint', xPct: 12.5, yPct: 87.5 },
        { op: 'fill', target: { label: 'Password' }, value: 'secret' },
        { op: 'press', key: 'Enter' },
        { op: 'expectVisible', target: { text: 'Home' } },
        { op: 'expectText', text: 'Welcome' },
        { op: 'waitFor', ms: 500 },
        { op: 'waitFor', target: { selector: '.board' } },
        { op: 'screenshot', name: 'after-login' },
      ],
    })).toBeNull();
  });

  it('rejects structural problems with step numbers', () => {
    expect(validateFlow(null)).toContain('object');
    expect(validateFlow({ ...base, id: 'Bad Id' })).toContain('flow.id');
    expect(validateFlow({ ...base, name: '' })).toContain('flow.name');
    expect(validateFlow({ ...base, startPath: 'puzzles' })).toContain('startPath');
    expect(validateFlow({ ...base, steps: [] })).toContain('non-empty');
    expect(validateFlow({ ...base, steps: Array(MAX_STEPS + 1).fill({ op: 'press', key: 'a' }) })).toContain('at most');
    expect(validateFlow({ ...base, steps: [{ op: 'teleport' }] })).toBe('step 1: unknown op "teleport"');
  });

  it('rejects bad targets and points', () => {
    expect(validateFlow({ ...base, steps: [{ op: 'click', target: {} }] })).toContain('exactly one');
    expect(validateFlow({ ...base, steps: [{ op: 'click', target: { text: 'a', label: 'b' } }] })).toContain('exactly one');
    expect(validateFlow({ ...base, steps: [{ op: 'clickPoint', xPct: 120, yPct: 5 }] })).toContain('0–100');
    expect(validateFlow({ ...base, steps: [{ op: 'goto', path: 'no-slash' }] })).toContain('goto.path');
    expect(validateFlow({ ...base, steps: [{ op: 'waitFor' }] })).toContain('ms or target');
  });
});
