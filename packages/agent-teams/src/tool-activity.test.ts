import { describe, it, expect } from 'vitest';
import { toolActivityDetail } from './tool-activity.ts';

describe('toolActivityDetail', () => {
  it('shows the file path for read/write', () => {
    expect(toolActivityDetail('read_file', { app_id: 'x', path: 'src/index.ts' })).toBe('read_file src/index.ts');
    expect(toolActivityDetail('write_file', { path: 'a/b.tsx' })).toBe('write_file a/b.tsx');
  });

  it('shows the query for search_files', () => {
    expect(toolActivityDetail('search_files', { query: 'useEffect' })).toBe('search_files "useEffect"');
  });

  it('lists batch-written files with a count', () => {
    expect(toolActivityDetail('batch_write_files', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] }))
      .toBe('batch_write_files (2): a.ts, b.ts');
  });

  it('caps the batch file list and adds an ellipsis', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => ({ path: `${p}.ts` }));
    expect(toolActivityDetail('batch_write_files', { files }))
      .toBe('batch_write_files (6): a.ts, b.ts, c.ts, d.ts, …');
  });

  it('shows the template for scaffold_app, plain name for list_files', () => {
    expect(toolActivityDetail('scaffold_app', { template: 'react-spa' })).toBe('scaffold_app react-spa');
    expect(toolActivityDetail('list_files', { app_id: 'x' })).toBe('list_files');
    expect(toolActivityDetail('list_files', { path: 'src' })).toBe('list_files src');
  });

  it('degrades gracefully with missing/garbage args', () => {
    expect(toolActivityDetail('read_file', undefined)).toBe('read_file');
    expect(toolActivityDetail('get_deploy_status', { app_id: 'x' })).toBe('get_deploy_status');
    expect(toolActivityDetail('batch_write_files', { files: [] })).toBe('batch_write_files');
  });
});
