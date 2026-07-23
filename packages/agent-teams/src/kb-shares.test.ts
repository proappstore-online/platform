import { describe, expect, it } from 'vitest';
import { createShare } from './kb-shares.js';

// Minimal SqlStorage stub — createShare only needs exec()+toArray() for the
// success path; the rejection path returns before touching sql.
const sql = { exec: () => ({ toArray: () => [{ slug: 'demo' }] }) } as unknown as SqlStorage;

describe('createShare access types (#90)', () => {
  it('rejects share types whose auth is not implemented yet', () => {
    for (const accessType of ['google', 'github', 'password']) {
      expect(createShare(sql, { accessType }).status, accessType).toBe(400);
    }
  });

  it('rejects an unknown type', () => {
    expect(createShare(sql, { accessType: 'nonsense' }).status).toBe(400);
  });

  it('allows an open share', () => {
    expect(createShare(sql, { accessType: 'open' }).status).toBe(201);
    expect(createShare(sql, {}).status).toBe(201); // defaults to open
  });
});
