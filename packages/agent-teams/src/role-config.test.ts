import { describe, it, expect } from 'vitest';
import { validateRoleConfig } from './role-config.ts';
import type { RoleConfig } from './types.ts';

const base: RoleConfig = {
  role: 'Dev',
  runtime: 'cf-native',
  model: 'claude-sonnet-4-6',
  spineTools: ['read_file', 'write_file'],
  vendorTools: [],
};

describe('validateRoleConfig', () => {
  it('accepts a valid config', () => {
    expect(validateRoleConfig(base)).toBeNull();
  });
  it('rejects an unknown role', () => {
    expect(validateRoleConfig({ ...base, role: 'PM' as RoleConfig['role'] })).toMatch(/invalid role/);
  });
  it('rejects an unknown runtime', () => {
    expect(validateRoleConfig({ ...base, runtime: 'bedrock' as RoleConfig['runtime'] })).toMatch(/invalid runtime/);
  });
  it('rejects an unknown spine tool', () => {
    expect(validateRoleConfig({ ...base, spineTools: ['read_file', 'rm_rf'] })).toMatch(/unknown spine tool: rm_rf/);
  });
  it('bounds model length and maxTokens', () => {
    expect(validateRoleConfig({ ...base, model: '' })).toMatch(/model must be/);
    expect(validateRoleConfig({ ...base, maxTokens: 100 })).toMatch(/maxTokens/);
    expect(validateRoleConfig({ ...base, maxTokens: 16384 })).toBeNull();
  });
  it('caps persona + systemPromptOverride length', () => {
    expect(validateRoleConfig({ ...base, persona: 'x'.repeat(4097) })).toMatch(/persona too long/);
    expect(validateRoleConfig({ ...base, systemPromptOverride: 'x'.repeat(8193) })).toMatch(/systemPromptOverride too long/);
  });
});
