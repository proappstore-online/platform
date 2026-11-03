/*!
MIT License

Copyright (c) 2026 FreeAppStore

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// Adapted from freeappstore-online/platform at 57a9fef25b5ef47087b03ce770ba457dabfbabe1.
// Copyright (c) 2026 FreeAppStore. MIT; see lib/bundle-limits.LICENSE.
// PAS #523: aggregate initial budget and validated asset paths/manifest shapes.
/**
 * Bundle-size caps for PAS source-side compliance checks.
 * Centralized here so the initial graph and lazy asset rules use explicit budgets.
 *
 * Initial load is the HTML entry chunk plus its static imports — the JS
 * the browser downloads before any `import()`, worker, or wasm fetch.
 * Lazy assets (dynamic chunks, workers, wasm, model/data files) are
 * allowed to be much larger because they only download when the user
 * opens that feature.
 */
export const INITIAL_LOAD_MAX_GZIP_BYTES = 300 * 1024; // 300 KB
export const LAZY_ASSET_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per asset
