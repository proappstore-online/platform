import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkClaudeMdSlim } from './claude-md-slim.js';

const SLIM_CLAUDE_MD = `# myapp

A free app on ProAppStore.

- Subdomain: \`myapp.proappstore.online\`
- Dev: \`pnpm install && pnpm dev\`
- Build: \`pnpm build\`
- Deploy: \`git push origin main\` (auto-deploys via Cloudflare Pages)

Free, MIT-licensed, no tracking. For platform conventions, read
https://raw.githubusercontent.com/proappstore-online/proappstore/main/SKILLS.md
before writing or changing anything.
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-claude-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkClaudeMdSlim', () => {
  it('passes when there is no CLAUDE.md', async () => {
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/no CLAUDE\.md/);
  });

  it('passes the canonical slim shape', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), SLIM_CLAUDE_MD);
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('warns on legacy "## Tech Stack" boilerplate', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `# myapp\n\n## Tech Stack\n- TypeScript\n\n${SLIM_CLAUDE_MD.split('\n').slice(2).join('\n')}`,
    );
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Tech Stack/);
  });

  it('warns on "## Platform: ProAppStore" header', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `# myapp\n\n## Platform: ProAppStore\n- Hosted on CF Pages\n\n${SLIM_CLAUDE_MD.split('\n').slice(2).join('\n')}`,
    );
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Platform: ProAppStore/);
  });

  it('warns on "## Brand Guidelines" header', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `# myapp\n\n## Brand Guidelines\n- Manrope\n\n${SLIM_CLAUDE_MD.split('\n').slice(2).join('\n')}`,
    );
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Brand Guidelines/);
  });

  it('warns on "## Rules" header (boilerplate platform rules belong in SKILLS.md)', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `# myapp\n\n## Rules\n- No tracking\n\n${SLIM_CLAUDE_MD.split('\n').slice(2).join('\n')}`,
    );
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Rules/);
  });

  it('warns when over the soft line limit', async () => {
    const padding = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n');
    await writeFile(join(dir, 'CLAUDE.md'), `${SLIM_CLAUDE_MD}\n${padding}`);
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/non-blank lines/);
  });

  it('warns when the SKILLS.md pointer is missing entirely', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), `# myapp\n\nA free app.\n\n- Dev: pnpm dev\n`);
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/missing SKILLS\.md pointer/);
  });

  it('does not warn on an allowed custom section like "## Architecture"', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `${SLIM_CLAUDE_MD}\n## Architecture\n\nstuff specific to this repo.\n`,
    );
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does not warn on "## Setup (one-time, admin)" — repo-specific setup', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      `${SLIM_CLAUDE_MD}\n## Setup (one-time, admin)\n\nGCP OAuth setup steps.\n`,
    );
    const r = await checkClaudeMdSlim(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});
