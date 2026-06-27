import { describe, expect, it } from 'vitest';
import { seedFiles, type TemplateType } from '../template-seed.ts';
import { TEMPLATE_TYPES, templateOverlay } from './index.ts';

const TEMPLATES = TEMPLATE_TYPES.filter((t) => t !== 'blank') as Exclude<TemplateType, 'blank'>[];

// ── Registry ───────────────────────────────────────────────────────

describe('template registry', () => {
  it('exports all 5 category templates + blank', () => {
    expect(TEMPLATE_TYPES).toEqual(['blank', 'marketplace', 'realtime', 'social', 'organization', 'dashboard']);
  });

  it('blank returns empty overlay', () => {
    expect(templateOverlay('test', 'blank').size).toBe(0);
  });

  it('each category returns at least 5 files', () => {
    for (const t of TEMPLATES) {
      expect(templateOverlay('test', t).size).toBeGreaterThanOrEqual(5);
    }
  });
});

// ── Base infrastructure survives overlay ────────────────────────────

describe('templates preserve base infrastructure', () => {
  const BASE_FILES = [
    'index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts',
    '.gitignore', 'LICENSE', 'README.md', 'CLAUDE.md', 'manifest.json', 'mcp.json',
    'src/main.tsx', 'src/index.css', 'tests/setup.ts',
    'public/icon.svg', 'public/og-image.svg',
  ];

  for (const tpl of TEMPLATES) {
    it(`${tpl}: all base files present`, () => {
      const files = seedFiles('test', tpl);
      for (const f of BASE_FILES) {
        expect(files.has(f), `${tpl} missing ${f}`).toBe(true);
      }
    });
  }
});

// ── Slug interpolation ─────────────────────────────────────────────

describe('templates interpolate slug correctly', () => {
  for (const tpl of TEMPLATES) {
    describe(tpl, () => {
      const files = seedFiles('my-cool-app', tpl);

      it('lib/app.ts has correct appId', () => {
        expect(files.get('src/lib/app.ts')).toContain("appId: 'my-cool-app'");
      });

      it('App.tsx references slug in brand', () => {
        expect(files.get('src/App.tsx')).toContain('my-cool-app');
      });

      it('no un-interpolated ${slug} remains', () => {
        for (const [path, content] of files) {
          if (path.startsWith('src/')) {
            expect(content, `${tpl}/${path} has raw \${slug}`).not.toContain('${slug}');
          }
        }
      });
    });
  }
});

// ── SDK usage patterns ─────────────────────────────────────────────

describe('templates use SDK correctly', () => {
  for (const tpl of TEMPLATES) {
    describe(tpl, () => {
      const files = seedFiles('test', tpl);
      const appTsx = files.get('src/App.tsx')!;
      const appTs = files.get('src/lib/app.ts')!;
      const dbTs = files.get('src/lib/db.ts')!;

      it('lib/app.ts imports initPro', () => {
        expect(appTs).toContain("import { initPro } from '@proappstore/sdk'");
      });

      it('App.tsx imports useProAuth', () => {
        expect(appTsx).toContain('useProAuth');
      });

      it('App.tsx imports useTheme', () => {
        expect(appTsx).toContain('useTheme');
      });

      it('App.tsx has sign-in buttons', () => {
        expect(appTsx).toContain('signIn');
      });

      it('App.tsx handles loading state', () => {
        expect(appTsx).toContain('loading');
        expect(appTsx).toContain('Loading');
      });

      it('App.tsx handles not-signed-in state', () => {
        expect(appTsx).toContain('Sign in');
      });

      it('db.ts exports migrate()', () => {
        expect(dbTs).toContain('export async function migrate');
      });

      it('db.ts has MIGRATIONS array', () => {
        expect(dbTs).toContain('MIGRATIONS');
      });

      it('App.tsx calls migrate after auth', () => {
        expect(appTsx).toContain('migrate');
      });
    });
  }
});

// ── SQL migrations are valid ───────────────────────────────────────

describe('templates have valid SQL migrations', () => {
  for (const tpl of TEMPLATES) {
    describe(tpl, () => {
      const dbTs = seedFiles('test', tpl).get('src/lib/db.ts')!;

      it('has named migrations', () => {
        expect(dbTs).toMatch(/name:\s*'0001_init'/);
      });

      it('has CREATE TABLE statements', () => {
        expect(dbTs).toContain('CREATE TABLE IF NOT EXISTS');
      });

      it('has at least one index', () => {
        expect(dbTs).toContain('CREATE INDEX IF NOT EXISTS');
      });

      it('uses PRIMARY KEY', () => {
        expect(dbTs).toContain('PRIMARY KEY');
      });

      it('does not use DROP TABLE', () => {
        expect(dbTs).not.toContain('DROP TABLE');
      });
    });
  }
});

// ── No variable shadowing of window.location ───────────────────────

describe('templates avoid location variable shadowing', () => {
  for (const tpl of TEMPLATES) {
    it(`${tpl}: no "const [location," state declaration`, () => {
      const files = seedFiles('test', tpl);
      for (const [path, content] of files) {
        if (path.startsWith('src/')) {
          expect(content, `${tpl}/${path} shadows window.location`).not.toMatch(/const \[location,\s*setLocation\]/);
        }
      }
    });
  }
});

// ── Event listener cleanup ─────────────────────────────────────────

describe('templates clean up hashchange listeners', () => {
  for (const tpl of TEMPLATES) {
    const appTsx = seedFiles('test', tpl).get('src/App.tsx')!;
    if (appTsx.includes('hashchange')) {
      it(`${tpl}: has removeEventListener for hashchange`, () => {
        expect(appTsx).toContain('removeEventListener');
      });
    }
  }
});

// ── Template-specific structure ────────────────────────────────────

describe('marketplace template structure', () => {
  const files = seedFiles('test', 'marketplace');

  it('has Browse, Detail, Create pages', () => {
    expect(files.has('src/pages/Browse.tsx')).toBe(true);
    expect(files.has('src/pages/Detail.tsx')).toBe(true);
    expect(files.has('src/pages/Create.tsx')).toBe(true);
  });

  it('db has listings and applications tables', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('listings');
    expect(db).toContain('applications');
    expect(db).toContain('saved_listings');
  });

  it('types has Listing and Application', () => {
    const types = files.get('src/types.ts')!;
    expect(types).toContain('interface Listing');
    expect(types).toContain('interface Application');
  });

  it('Browse has search and category filter', () => {
    const browse = files.get('src/pages/Browse.tsx')!;
    expect(browse).toContain('search');
    expect(browse).toContain('category');
    expect(browse).toContain('CATEGORIES');
  });

  it('Detail has save and apply actions', () => {
    const detail = files.get('src/pages/Detail.tsx')!;
    expect(detail).toContain('saveListing');
    expect(detail).toContain('applyToListing');
  });
});

describe('realtime template structure', () => {
  const files = seedFiles('test', 'realtime');

  it('has BoardView page and realtime hook', () => {
    expect(files.has('src/pages/BoardView.tsx')).toBe(true);
    expect(files.has('src/lib/realtime.ts')).toBe(true);
  });

  it('db has workspaces, boards, lists, cards tables', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('workspaces');
    expect(db).toContain('boards');
    expect(db).toContain('lists');
    expect(db).toContain('cards');
  });

  it('realtime hook uses app.rooms', () => {
    const rt = files.get('src/lib/realtime.ts')!;
    expect(rt).toContain('app.rooms');
    expect(rt).toContain('broadcast');
    expect(rt).toContain('peers');
  });

  it('types has BoardPatch union', () => {
    const types = files.get('src/types.ts')!;
    expect(types).toContain('BoardPatch');
    expect(types).toContain('card.created');
  });
});

describe('social template structure', () => {
  const files = seedFiles('test', 'social');

  it('has Discover, Connections, Chat, ProfileEdit pages', () => {
    expect(files.has('src/pages/Discover.tsx')).toBe(true);
    expect(files.has('src/pages/Connections.tsx')).toBe(true);
    expect(files.has('src/pages/Chat.tsx')).toBe(true);
    expect(files.has('src/pages/ProfileEdit.tsx')).toBe(true);
  });

  it('db has profiles, likes, connections, messages tables', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('profiles');
    expect(db).toContain('likes');
    expect(db).toContain('connections');
    expect(db).toContain('messages');
  });

  it('has mutual matching logic', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('likeUser');
    expect(db).toContain('mutual');
  });

  it('Chat uses rooms for real-time', () => {
    const chat = files.get('src/pages/Chat.tsx')!;
    expect(chat).toContain('app.rooms');
  });

  it('App has bottom tab navigation', () => {
    const app = files.get('src/App.tsx')!;
    expect(app).toContain('sticky bottom-0');
    expect(app).toContain('Discover');
    expect(app).toContain('Connections');
    expect(app).toContain('Profile');
  });
});

describe('organization template structure', () => {
  const files = seedFiles('test', 'organization');

  it('has OrgView page', () => {
    expect(files.has('src/pages/OrgView.tsx')).toBe(true);
  });

  it('db has orgs, memberships, role_tracks tables', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('orgs');
    expect(db).toContain('memberships');
    expect(db).toContain('role_tracks');
  });

  it('has atomic org creation (batch insert)', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('app.db.batch');
  });

  it('has role-based access (admin/member)', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain("'admin'");
    expect(db).toContain("'member'");
  });

  it('OrgView has tabs for members/roles/settings', () => {
    const org = files.get('src/pages/OrgView.tsx')!;
    expect(org).toContain('members');
    expect(org).toContain('roles');
    expect(org).toContain('settings');
  });
});

describe('dashboard template structure', () => {
  const files = seedFiles('test', 'dashboard');

  it('has Dashboard, ItemList, ItemDetail, ItemForm pages', () => {
    expect(files.has('src/pages/Dashboard.tsx')).toBe(true);
    expect(files.has('src/pages/ItemList.tsx')).toBe(true);
    expect(files.has('src/pages/ItemDetail.tsx')).toBe(true);
    expect(files.has('src/pages/ItemForm.tsx')).toBe(true);
  });

  it('db has items table with priority and status', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('items');
    expect(db).toContain('priority');
    expect(db).toContain("'active'");
    expect(db).toContain("'archived'");
  });

  it('has getStats function', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('getStats');
    expect(db).toContain('byCategory');
  });

  it('has CRUD operations', () => {
    const db = files.get('src/lib/db.ts')!;
    expect(db).toContain('createItem');
    expect(db).toContain('updateItem');
    expect(db).toContain('deleteItem');
    expect(db).toContain('listItems');
    expect(db).toContain('getItem');
  });

  it('Dashboard shows stats cards', () => {
    const dash = files.get('src/pages/Dashboard.tsx')!;
    expect(dash).toContain('stats.total');
    expect(dash).toContain('stats.active');
    expect(dash).toContain('stats.archived');
  });

  it('ItemForm handles both create and edit', () => {
    const form = files.get('src/pages/ItemForm.tsx')!;
    expect(form).toContain('editId');
    expect(form).toContain('createItem');
    expect(form).toContain('updateItem');
  });
});

// ── No template leaks across slugs ─────────────────────────────────

describe('templates are slug-isolated', () => {
  it('different slugs produce different content', () => {
    const a = seedFiles('alpha', 'marketplace');
    const b = seedFiles('beta', 'marketplace');
    expect(a.get('src/lib/app.ts')).not.toBe(b.get('src/lib/app.ts'));
    expect(a.get('src/lib/app.ts')).toContain('alpha');
    expect(b.get('src/lib/app.ts')).toContain('beta');
  });

  it('base files are slug-specific too', () => {
    const a = seedFiles('alpha', 'marketplace');
    const b = seedFiles('beta', 'marketplace');
    expect(a.get('index.html')).toContain('alpha');
    expect(b.get('index.html')).toContain('beta');
  });
});
