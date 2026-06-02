import { describe, expect, it } from 'vitest';
import { executeFileTool, isFileTool } from './spine.ts';
import type { ToolCall } from './types.ts';

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `c-${name}`, name, args };
}

describe('isFileTool', () => {
  it('recognizes file tools', () => {
    for (const n of ['write_file', 'read_file', 'list_files', 'delete_file', 'search_files', 'batch_write_files']) {
      expect(isFileTool(n)).toBe(true);
    }
  });
  it('rejects infra tools', () => {
    expect(isFileTool('scaffold_app')).toBe(false);
    expect(isFileTool('get_deploy_status')).toBe(false);
  });
});

describe('executeFileTool', () => {
  it('writes then reads a file', () => {
    const files = new Map<string, string>();
    const w = executeFileTool(call('write_file', { path: 'src/app.ts', content: 'hi' }), files);
    expect(w.ok).toBe(true);
    expect(files.get('src/app.ts')).toBe('hi');
    const r = executeFileTool(call('read_file', { path: 'src/app.ts' }), files);
    expect(r.ok).toBe(true);
    expect(r.data).toBe('hi');
  });

  it('rejects unsafe paths', () => {
    const files = new Map<string, string>();
    for (const path of ['../escape', '/etc/passwd', '.github/workflows/ci.yml']) {
      const res = executeFileTool(call('write_file', { path, content: 'x' }), files);
      expect(res.ok).toBe(false);
    }
    expect(files.size).toBe(0);
  });

  it('read_file errors on missing file', () => {
    const res = executeFileTool(call('read_file', { path: 'nope.ts' }), new Map());
    expect(res.ok).toBe(false);
    expect(res.errorMessage).toContain('not found');
  });

  it('lists files sorted', () => {
    const files = new Map([['b.ts', '1'], ['a.ts', '2']]);
    const res = executeFileTool(call('list_files', {}), files);
    expect(res.data).toBe('a.ts\nb.ts');
  });

  it('deletes a file', () => {
    const files = new Map([['x.ts', '1']]);
    expect(executeFileTool(call('delete_file', { path: 'x.ts' }), files).ok).toBe(true);
    expect(files.has('x.ts')).toBe(false);
    expect(executeFileTool(call('delete_file', { path: 'x.ts' }), files).ok).toBe(false);
  });

  it('searches across files with path:line output', () => {
    const files = new Map([
      ['a.ts', 'const foo = 1\nconst bar = 2'],
      ['b.ts', 'FOO again'],
    ]);
    const res = executeFileTool(call('search_files', { query: 'foo' }), files);
    expect(res.ok).toBe(true);
    expect(res.data).toContain('a.ts:1:');
    expect(res.data).toContain('b.ts:1:');
  });

  it('batch writes multiple files atomically-ish', () => {
    const files = new Map<string, string>();
    const res = executeFileTool(
      call('batch_write_files', { files: [{ path: 'a.ts', content: '1' }, { path: 'b.ts', content: '2' }] }),
      files,
    );
    expect(res.ok).toBe(true);
    expect(files.size).toBe(2);
  });

  it('batch write rejects when any path is unsafe', () => {
    const files = new Map<string, string>();
    const res = executeFileTool(
      call('batch_write_files', { files: [{ path: 'ok.ts', content: '1' }, { path: '../bad', content: '2' }] }),
      files,
    );
    expect(res.ok).toBe(false);
  });
});
