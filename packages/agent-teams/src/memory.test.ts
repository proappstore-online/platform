import { describe, it, expect } from 'vitest';
import { formatMemory, DEFAULT_PERSONAS, PO_PERSONA, type MemoryEntry } from './memory.ts';

function entry(key: string, value: string): MemoryEntry {
  return { id: key, category: 'decision', key, value, createdAt: 0, updatedAt: 0 };
}

describe('formatMemory', () => {
  it('returns empty string when there is no memory', () => {
    expect(formatMemory([])).toBe('');
  });

  it('renders decisions as a ground-truth block', () => {
    const out = formatMemory([entry('auth', 'GitHub OAuth'), entry('audience', 'freelancers')]);
    expect(out).toContain('Project memory');
    expect(out).toContain('- auth: GitHub OAuth');
    expect(out).toContain('- audience: freelancers');
  });
});

describe('personas', () => {
  it('defines a persona for every build role and the PO', () => {
    for (const r of ['BA', 'Dev', 'QA'] as const) {
      expect(DEFAULT_PERSONAS[r].length).toBeGreaterThan(20);
    }
    expect(PO_PERSONA).toContain('Product Owner');
  });
});
