import { describe, expect, it } from 'vitest';
import { executeFileTool, isFileTool, MAX_FILE_BYTES, MAX_FILES } from './spine.ts';
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

describe('executeFileTool resource caps', () => {
  it('rejects a single file over the per-file byte cap', () => {
    const files = new Map<string, string>();
    const r = executeFileTool(call('write_file', { path: 'big.txt', content: 'x'.repeat(MAX_FILE_BYTES + 1) }), files);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('file too large');
    expect(files.size).toBe(0);
  });

  it('rejects creating beyond the file-count cap', () => {
    const files = new Map<string, string>();
    for (let i = 0; i < MAX_FILES; i++) files.set(`f${i}.ts`, 'a');
    const r = executeFileTool(call('write_file', { path: 'one-too-many.ts', content: 'a' }), files);
    expect(r.ok).toBe(false);
    expect(r.errorMessage).toContain('too many files');
    // overwriting an existing file is still allowed at the cap
    const ok = executeFileTool(call('write_file', { path: 'f0.ts', content: 'b' }), files);
    expect(ok.ok).toBe(true);
  });

  it('batch_write_files validates the whole batch before writing (no partial writes)', () => {
    const files = new Map<string, string>();
    const r = executeFileTool(call('batch_write_files', {
      files: [{ path: 'a.ts', content: 'ok' }, { path: 'b.ts', content: 'x'.repeat(MAX_FILE_BYTES + 1) }],
    }), files);
    expect(r.ok).toBe(false);
    expect(files.size).toBe(0); // a.ts was NOT written
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

  it('honors a path prefix on list_files', () => {
    const files = new Map([['src/a.ts', '1'], ['src/lib/b.ts', '2'], ['README.md', '3']]);
    expect(executeFileTool(call('list_files', { path: 'src' }), files).data).toBe('src/a.ts\nsrc/lib/b.ts');
    expect(executeFileTool(call('list_files', { path: 'src/lib' }), files).data).toBe('src/lib/b.ts');
  });

  it('returns an explicit empty message for a missing prefix (e.g. node_modules)', () => {
    const files = new Map([['src/a.ts', '1']]);
    expect(executeFileTool(call('list_files', { path: 'node_modules/@proappstore/sdk' }), files).data)
      .toBe('(no files under "node_modules/@proappstore/sdk")');
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
