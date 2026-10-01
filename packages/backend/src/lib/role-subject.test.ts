import { describe, expect, it } from 'vitest';
import { roleLoginAlias, roleSubjects } from './role-subject.js';

describe('roleSubjects (#272)', () => {
  it('a GitHub session matches its id and its GitHub login', () => {
    expect(roleSubjects({ id: 'gh:7', login: 'bob' })).toEqual(['gh:7', 'bob']);
  });

  it('credential and Google sessions match their id only — their login is a free-text name', () => {
    expect(roleSubjects({ id: 'cred:abc', login: 'gh:2' })).toEqual(['cred:abc', 'cred:abc']);
    expect(roleSubjects({ id: 'google:1', login: 'bob' })).toEqual(['google:1', 'google:1']);
  });

  it('a GitHub session without a login falls back to its id', () => {
    expect(roleLoginAlias({ id: 'gh:7', login: '' })).toBe('gh:7');
    expect(roleLoginAlias({ id: 'gh:7', login: null })).toBe('gh:7');
  });
});
