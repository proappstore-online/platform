import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { getTemplate } from '../packages/build-core/src/template-catalogue.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// Source files copied verbatim from the reviewed commit, not the moving local
// template checkout. Updating a review requires reviewing and replacing these.
const review = JSON.parse(readFileSync(new URL('./fixtures/template-app-review.json', import.meta.url), 'utf8')) as {
  repository: string; revision: string; reviewed_at: string; files: Record<string, string>;
};
const template = getTemplate('template-app')!;

describe('reviewed base-template contract', () => {
  it('publishes the reviewed source revision, review date and SDK requirement', () => {
    const pkg = JSON.parse(review.files['web/package.json']!);
    expect(template.repo).toBe(review.repository);
    expect(template.release.source_commit).toBe(review.revision);
    expect(template.security_compliance.reviewed_at).toBe(review.reviewed_at);
    expect(template.requires.sdk).toBe(`>=${pkg.dependencies['@proappstore/sdk'].replace(/^\^/, '')}`);
  });

  it('documents only the remaining auth-mode deviation, not the fixed theme or zoom issues', () => {
    const html = review.files['web/index.html']!;
    expect(html).toContain("localStorage.getItem('stores-theme')");
    expect(html).not.toMatch(/fas:theme|user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
    expect(review.files['web/src/App.tsx']).not.toMatch(/authMode\s*:/);
    expect(template.security_compliance.known_deviations).toEqual(['PAS-AUTH-001']);
  });

  it('can migrate and execute all registered actions with caller isolation', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const migrations = JSON.parse(review.files['migrations.json']!);
      for (const migration of migrations.migrations) db.exec(migration.sql);
      const manifest = JSON.parse(review.files['mcp.json']!);
      const action = (name: string) => manifest.tools.find((tool: { name: string }) => tool.name === name);
      expect(manifest.tools.every((tool: { requires_auth: boolean }) => tool.requires_auth)).toBe(true);
      db.prepare(action('create_item').sql).run({ __uuid: 'own', __user_id: 'owner', title: 'Own item', __now: 1 });
      db.prepare(action('create_item').sql).run({ __uuid: 'other', __user_id: 'other', title: 'Other item', __now: 2 });
      expect(db.prepare(action('list_items').sql).all({ __user_id: 'owner', status: null, limit: 20 })).toMatchObject([{ id: 'own' }]);
      expect(db.prepare(action('get_item').sql).all({ id: 'other', __user_id: 'owner' })).toEqual([]);
      expect(db.prepare(action('get_item').sql).all({ id: 'own', __user_id: 'owner' })).toMatchObject([{ title: 'Own item' }]);
      expect(review.files['.github/workflows/deploy.yml']).toContain('proappstore-online/platform/.github/workflows/app-deploy.yml@app-deploy-v1');
    } finally {
      db.close();
    }
  });
});
