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

  it('returns just the matching section for a topic', () => {
    const out = sliceDocs(DOC, 'database');
    expect(out).toContain('## Database');
    expect(out).toContain('use app.db.execute');
    expect(out).not.toContain('## Rooms');
  });

  it('captures nested subsections under the matched heading', () => {
    const out = sliceDocs(DOC, 'rooms');
    expect(out).toContain('## Rooms');
    expect(out).toContain('### Caps');
    expect(out).toContain('32 peers');
    expect(out).not.toContain('## Database');
  });

  it('falls back to the full doc when the topic is not found', () => {
    expect(sliceDocs(DOC, 'nonexistent')).toContain('# Guide');
  });
});
