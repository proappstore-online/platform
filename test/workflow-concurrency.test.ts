import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// #360: verification workflows cancel superseded PR runs but never a run on main.
const read = (name: string) => readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', name), 'utf8');

describe.each(['ci.yml', 'quality.yml'])('%s concurrency', (file) => {
  const yml = read(file);

  it('groups runs per PR, and per commit on main', () => {
    expect(yml).toMatch(/^concurrency:\n(?:  #.*\n)*  group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.sha \}\}$/m);
  });

  it('cancels in-progress runs for pull requests only', () => {
    expect(yml).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });
});
