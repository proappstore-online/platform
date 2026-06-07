import { describe, expect, it } from 'vitest';
import { buildAppSummary } from './context-summary.ts';

describe('buildAppSummary', () => {
  it('returns empty string for an empty file tree', () => {
    expect(buildAppSummary(new Map())).toBe('');
  });

  it('extracts exported component names from .tsx files', () => {
    const files = new Map([
      ['src/App.tsx', 'export default function App() { return <div /> }'],
      ['src/components/Header.tsx', 'export function Header() {}\nexport const Footer = () => {}'],
      ['README.md', 'export function NotAComponent() {}'], // not in src/
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toContain('## Components (2 files)');
    expect(summary).toContain('`src/App.tsx`: App');
    expect(summary).toContain('`src/components/Header.tsx`: Header, Footer');
    expect(summary).not.toContain('NotAComponent');
  });

  it('extracts CREATE TABLE columns (single-line)', () => {
    const files = new Map([
      ['src/App.tsx', `app.db.execute('CREATE TABLE items (id TEXT, title TEXT, created_at INTEGER)')`],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toContain('## Data Model');
    expect(summary).toContain('`items`: id, title, created_at');
  });

  it('extracts CREATE TABLE columns (multi-line)', () => {
    const files = new Map([
      ['src/db.ts', `app.db.execute(\`CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date INTEGER
)\`)`],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toContain('`events`: id, title, date');
  });

  it('detects SDK module usage', () => {
    const files = new Map([
      ['src/App.tsx', `
        app.auth.signIn()
        app.db.query('SELECT 1')
        app.rooms.join('lobby')
        app.storage.upload('f', file, 'image/png')
      `],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toContain('## SDK Usage');
    expect(summary).toContain('`app.auth`');
    expect(summary).toContain('`app.db`');
    expect(summary).toContain('`app.rooms`');
    expect(summary).toContain('`app.storage`');
  });

  it('parses dependencies from package.json (excludes @types/)', () => {
    const files = new Map([
      ['package.json', JSON.stringify({
        dependencies: {
          'react': '^18.0.0',
          'date-fns': '^3.0.0',
          '@types/react': '^18.0.0',
          '@proappstore/sdk': '^0.14.0',
        },
      })],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toContain('## Dependencies');
    expect(summary).toContain('`react`');
    expect(summary).toContain('`date-fns`');
    expect(summary).toContain('`@proappstore/sdk`');
    expect(summary).not.toContain('@types/react');
  });

  it('extracts view/route type unions', () => {
    const files = new Map([
      ['src/App.tsx', "type View = 'home' | 'settings' | 'profile'"],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toContain('## Views / Routes');
    expect(summary).toContain("'home' | 'settings' | 'profile'");
  });

  it('ignores view types outside src/', () => {
    const files = new Map([
      ['config.ts', "type View = 'admin'"],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).not.toContain('Views');
  });

  it('deduplicates tables with the same name across files', () => {
    const files = new Map([
      ['src/db.ts', "CREATE TABLE items (id TEXT, name TEXT)"],
      ['src/migrate.ts', "CREATE TABLE IF NOT EXISTS items (id TEXT, name TEXT, extra INTEGER)"],
    ]);
    const summary = buildAppSummary(files);
    // Should only appear once (first occurrence wins)
    const matches = summary.match(/`items`/g);
    expect(matches).toHaveLength(1);
  });

  it('produces a complete summary with all sections', () => {
    const files = new Map<string, string>([
      ['package.json', '{"dependencies":{"react":"^18"}}'],
      ['src/App.tsx', `
        export default function App() { return <div /> }
        type View = 'home' | 'about'
        app.auth.signIn()
        app.db.execute('CREATE TABLE tasks (id TEXT, done INTEGER)')
      `],
    ]);
    const summary = buildAppSummary(files);
    expect(summary).toMatch(/^# App Context Summary/);
    expect(summary).toContain('## Components');
    expect(summary).toContain('## Data Model');
    expect(summary).toContain('## SDK Usage');
    expect(summary).toContain('## Dependencies');
    expect(summary).toContain('## Views / Routes');
  });

  it('handles malformed package.json gracefully', () => {
    const files = new Map([['package.json', 'not json']]);
    const summary = buildAppSummary(files);
    // Should not throw, just skip the deps section
    expect(summary).toBe('');
  });
});
