import { describe, it, expect } from 'vitest';
import { extractToken } from './auth.ts';

describe('extractToken', () => {
  it('extracts Bearer token', () => {
    const req = new Request('https://example.com', {
      headers: { Authorization: 'Bearer abc123' },
    });
    expect(extractToken(req)).toBe('abc123');
  });

  it('returns null for missing header', () => {
    const req = new Request('https://example.com');
    expect(extractToken(req)).toBeNull();
  });

  it('returns null for non-Bearer auth', () => {
    const req = new Request('https://example.com', {
      headers: { Authorization: 'Basic abc123' },
    });
    expect(extractToken(req)).toBeNull();
  });

  it('returns null for empty Bearer value', () => {
    const req = new Request('https://example.com', {
      headers: { Authorization: 'Bearer ' },
    });
    expect(extractToken(req)).toBeNull();
  });

  it('handles token with special characters', () => {
    const req = new Request('https://example.com', {
      headers: { Authorization: 'Bearer tok_abc.123-xyz' },
    });
    expect(extractToken(req)).toBe('tok_abc.123-xyz');
  });
});
