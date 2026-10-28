import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkAppTitle } from './app-title.js';

const html = (title: string) => `<!doctype html><html lang="en"><head><title>${title}</title></head></html>`;
const app = (title: string, extra: Record<string, string> = {}) =>
  mapFileSource(new Map([['web/index.html', html(title)], ['package.json', '{"name":"bookkeeper"}'], ...Object.entries(extra)]));

describe('app-title (#499)', () => {
  it('warns when the title is the slug, as bookkeeper served it', async () => {
    const r = await checkAppTitle(app('bookkeeper'));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/the app's id/);
    expect(r.suggestions?.join(' ')).toMatch(/display name/);
  });

  it('warns when the title is still the template placeholder, in any case', async () => {
    for (const t of ['APPNAME', 'appname']) expect((await checkAppTitle(app(t))).detail).toMatch(/template placeholder/);
  });

  it('passes a display name, including one that differs only in case or spacing from the slug', async () => {
    expect((await checkAppTitle(app('Bookkeeper'))).status).toBe('pass');
    expect((await checkAppTitle(app('Door Drop', { 'package.json': '{"name":"door-drop"}' }))).status).toBe('pass');
  });

  it('uses .pas.json appId in preference to the package name, and strips a scope', async () => {
    expect((await checkAppTitle(app('shop', { '.pas.json': '{"appId":"shop"}' }))).status).toBe('warn');
    expect((await checkAppTitle(app('shop', { 'package.json': '{"name":"@acme/shop"}' }))).status).toBe('warn');
  });

  it('ignores a title that only appears in a comment, and tolerates whitespace around the title', async () => {
    const files = mapFileSource(new Map([['web/index.html', '<!-- <title>bookkeeper</title> --><title>\n  Bookkeeper\n</title>'], ['package.json', '{"name":"bookkeeper"}']]));
    expect((await checkAppTitle(files)).status).toBe('pass');
  });

  it('leaves a missing index.html, an empty title and an app with no id to html-meta', async () => {
    expect((await checkAppTitle(mapFileSource(new Map()))).status).toBe('pass');
    expect((await checkAppTitle(app(''))).status).toBe('pass');
    expect((await checkAppTitle(mapFileSource(new Map([['web/index.html', html('Anything')]])))).status).toBe('pass');
  });
});
