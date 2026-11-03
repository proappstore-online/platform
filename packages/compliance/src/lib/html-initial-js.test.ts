// Adapted from freeappstore-online/platform at 57a9fef25b5ef47087b03ce770ba457dabfbabe1.
// Copyright (c) 2026 FreeAppStore. MIT; see lib/bundle-limits.LICENSE.
// PAS #523: aggregate initial budget and validated asset paths/manifest shapes.
import { describe, expect, it } from 'vitest';
import { collectInitialJsRefs, jsAssetFileName } from './html-initial-js.js';

describe('collectInitialJsRefs', () => {
  it('collects the entry script', () => {
    const html = '<script type="module" src="/assets/index-abc.js"></script>';
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index-abc.js']);
  });

  it('collects modulepreload hrefs regardless of attribute order', () => {
    const html = `
      <link href="/assets/vendor-xyz.js" rel="modulepreload" crossorigin>
      <link rel="modulepreload" href="/assets/chunk-1.js">
      <script type="module" src="/assets/index-abc.js"></script>
    `;
    expect(collectInitialJsRefs(html)).toEqual([
      '/assets/index-abc.js',
      '/assets/vendor-xyz.js',
      '/assets/chunk-1.js',
    ]);
  });

  it('ignores stylesheets but preserves every modulepreload for validation', () => {
    const html = `
      <link rel="stylesheet" href="/assets/index.css">
      <link rel="modulepreload" href="/assets/ocr.wasm">
      <script src="/assets/index.js"></script>
    `;
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index.js', '/assets/ocr.wasm']);
  });

  it('dedupes identical refs', () => {
    const html = `
      <link rel="modulepreload" href="/assets/index.js">
      <script src="/assets/index.js"></script>
    `;
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index.js']);
  });

  it('does not treat data-src as the script that loads', () => {
    const html = '<script data-src="/assets/huge.js" src="/assets/index.js"></script>';
    expect(collectInitialJsRefs(html)).toEqual(['/assets/index.js']);
  });
});

describe('jsAssetFileName', () => {
  it('strips /assets/ and query strings', () => {
    expect(jsAssetFileName('/assets/index-abc.js')).toBe('index-abc.js');
    expect(jsAssetFileName('./assets/vendor.js?v=1')).toBe('vendor.js');
    expect(jsAssetFileName('https://app.example/assets/foo.mjs')).toBeNull();
  });

  it('returns null for non-asset or non-js refs', () => {
    expect(jsAssetFileName('/sw.js')).toBeNull();
    expect(jsAssetFileName('/assets/index.css')).toBeNull();
  });
});


describe('safe HTML references (#523)', () => {
  it('ignores comments and supports unquoted attributes', () => {
    expect(collectInitialJsRefs('<!-- <script src="/assets/old.js"> --> <script src=/assets/main.js></script> <link rel=modulepreload href=/assets/vendor.js>')).toEqual(['/assets/main.js', '/assets/vendor.js']);
  });
  it.each(['/assets/../private.js', '/assets/%2e%2e/private.js', '/assets/a\\b.js', '//cdn.test/assets/main.js'])('rejects unsafe or remote path %s', (path) => {
    expect(jsAssetFileName(path)).toBeNull();
  });
});


it('preserves extensionless executable refs instead of silently dropping them (#532)', () => {
  expect(collectInitialJsRefs('<script src="https://cdn.example/runtime"></script><link rel="modulepreload" href="/assets/vendor">')).toEqual(['https://cdn.example/runtime', '/assets/vendor']);
});
