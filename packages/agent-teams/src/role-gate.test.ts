import { describe, expect, it } from 'vitest';
import { minRoleFor } from './project-do.js';

// #79: privileged agent-teams DO routes must require a sufficient team role,
// not just membership. This locks the route→minRole table so a read-only
// `viewer` can't deploy, write files, drain the owner's budget, etc.
describe('minRoleFor (agent-teams DO role gate)', () => {
  it('destructive / spend-config / deploy routes require owner', () => {
    for (const [path, method] of [
      ['/deploy', 'POST'],
      ['/files', 'POST'],
      ['/files', 'DELETE'],
      ['/budget', 'PUT'],
      ['/roles', 'PUT'],
      ['/project/pause', 'POST'],
      ['/project/play', 'POST'],
      ['/chat/history', 'DELETE'],
      ['/activity', 'DELETE'],
      ['/shares', 'POST'],
      ['/generate-listing', 'POST'],
      ['/tickets/abc123', 'DELETE'],
      ['/memory/abc123', 'DELETE'],
    ] as const) {
      expect(minRoleFor(path, method), `${method} ${path}`).toBe('owner');
    }
  });

  it('non-destructive mutations require developer', () => {
    for (const [path, method] of [
      ['/chat', 'POST'],
      ['/tickets', 'POST'],
      ['/project/research', 'POST'],
      ['/memory', 'POST'],
      ['/run-tests', 'POST'],
      ['/sync', 'POST'],
      ['/tickets/abc/messages', 'POST'],
    ] as const) {
      expect(minRoleFor(path, method), `${method} ${path}`).toBe('developer');
    }
  });

  it('reads are allowed for any member (viewer)', () => {
    for (const path of ['/project', '/roles', '/files', '/cost', '/activity', '/tickets', '/memory']) {
      expect(minRoleFor(path, 'GET'), `GET ${path}`).toBe('viewer');
    }
  });
});
