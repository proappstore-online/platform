import { describe, it, expect } from 'vitest';
import { PLATFORM_CAPABILITIES, sliceDocs, DOCS_SKILLS_URL } from './platform-skill.ts';

const DOC = `# Guide
intro line

## Database
use app.db.execute
more db

## Rooms
realtime stuff

### Caps
32 peers
`;

describe('PLATFORM_CAPABILITIES', () => {
  it('documents real SDK primitives and cites the official docs URL', () => {
    expect(PLATFORM_CAPABILITIES).toContain('app.db.execute');
    expect(PLATFORM_CAPABILITIES).toContain(DOCS_SKILLS_URL);
  });
});

describe('sliceDocs', () => {
  it('returns the whole doc (capped) with no topic', () => {
    expect(sliceDocs(DOC)).toContain('# Guide');
  });

  it('returns just the matching section for a heading topic', () => {
    const out = sliceDocs(DOC, 'database');
    expect(out).toContain('## Database');
    expect(out).toContain('use app.db.execute');
    expect(out).not.toContain('## Rooms');
  });

  it('matches BODY keywords, not just headings (the SignInButton case)', () => {
    // "execute" only appears in the Database section's body — must still match.
    const out = sliceDocs(DOC, 'execute');
    expect(out).toContain('use app.db.execute');
    expect(out).not.toContain('## Rooms');
    expect(out.length).toBeLessThan(DOC.length); // not the whole doc
  });

  it('falls back to the full doc when the topic is not found', () => {
    expect(sliceDocs(DOC, 'nonexistent')).toContain('# Guide');
  });

  it('bounds output for a monolithic doc (no sub-headings) via windowing', () => {
    // Mimics skills.md: one huge block with no ##/### headings → heading slicing
    // returns everything, so the windowing fallback must cap it near `max`.
    const big = '## SDK\n```ts\n' + 'filler line\n'.repeat(5000) + 'app.db.execute(sql)\n' + 'more\n'.repeat(5000) + '```';
    const out = sliceDocs(big, 'db.execute', 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain('app.db.execute(sql)');
  });

  it('caps a no-topic read to max chars', () => {
    expect(sliceDocs('x'.repeat(50000), undefined, 6000).length).toBe(6000);
  });
});
