import { describe, it, expect } from 'vitest';
import { isAllowedTool } from './tool-dispatch.ts';

describe('isAllowedTool', () => {
  const spineTools = ['write_file', 'read_file', 'scaffold_app'];

  it('allows tools in the list', () => {
    expect(isAllowedTool('write_file', spineTools)).toBe(true);
    expect(isAllowedTool('read_file', spineTools)).toBe(true);
    expect(isAllowedTool('scaffold_app', spineTools)).toBe(true);
  });

  it('rejects tools not in the list', () => {
    expect(isAllowedTool('delete_file', spineTools)).toBe(false);
    expect(isAllowedTool('', spineTools)).toBe(false);
    expect(isAllowedTool('WRITE_FILE', spineTools)).toBe(false); // case-sensitive
  });

  it('rejects all tools with empty list', () => {
    expect(isAllowedTool('write_file', [])).toBe(false);
  });
});
