import { describe, it, expect, vi } from 'vitest';
import { Storage } from './storage.js';

function storageWith(status: number) {
  const authenticatedFetch = vi.fn(async () => new Response(null, { status }));
  const storage = new Storage('myapp', 'https://api.proappstore.online', {
    token: 'tok', handleUnauthorized: vi.fn(), authenticatedFetch,
  });
  return { storage, authenticatedFetch };
}

// #207: user-public and team deletions address the server's namespaced DELETE routes.
describe('Storage deletion', () => {
  it('deleteUserPublic targets the caller-scoped _userpub namespace', async () => {
    const { storage, authenticatedFetch } = storageWith(204);
    await storage.deleteUserPublic('p/1.jpg');
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://api.proappstore.online/v1/apps/myapp/storage/_userpub/p/1.jpg', { method: 'DELETE' });
  });

  it('deletePublic takes a returned key and targets _public/<key>', async () => {
    const { storage, authenticatedFetch } = storageWith(204);
    await storage.deletePublic('u/gh:1/p/1.jpg');
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://api.proappstore.online/v1/apps/myapp/storage/_public/u/gh:1/p/1.jpg', { method: 'DELETE' });
  });

  it('never reports a wrong key or a refused takedown as success', async () => {
    await expect(storageWith(404).storage.deletePublic('u/gh:1/nope.jpg')).rejects.toThrow('File not found.');
    await expect(storageWith(404).storage.deleteUserPublic('nope.jpg')).rejects.toThrow('File not found.');
    await expect(storageWith(403).storage.deletePublic('banner.png')).rejects.toThrow('Not allowed to delete this file.');
  });

  it('keeps delete() tolerant of a missing private file', async () => {
    await expect(storageWith(404).storage.delete('notes/a.txt')).resolves.toBeUndefined();
  });
});
