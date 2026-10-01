import { describe, it, expect, vi } from 'vitest';
import { Storage } from './storage.js';
import { resolvePrivateApp } from './auth.js';

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

// #208: review uploads address the server's _review namespace.
describe('Storage review uploads', () => {
  it('uploadForReview writes to _review/<path>', async () => {
    const authenticatedFetch = vi.fn(async () => Response.json({ key: '_review/u/gh:1/cert.pdf', size: 4, contentType: 'application/pdf', url: '/x' }));
    const storage = new Storage('myapp', 'https://api.proappstore.online', { token: 't', handleUnauthorized: vi.fn(), authenticatedFetch });
    await storage.uploadForReview('cert.pdf', new Uint8Array([1]), 'application/pdf');
    expect(authenticatedFetch.mock.calls[0]![0]).toBe('https://api.proappstore.online/v1/apps/myapp/storage/_review/cert.pdf');
  });

  it('downloadForReview and deleteForReview address _review/u/<userId>/<path> and name refusals', async () => {
    const { storage, authenticatedFetch } = storageWith(403);
    expect(storage.reviewUrl('gh:1', 'cert.pdf')).toBe('https://api.proappstore.online/v1/apps/myapp/storage/_review/u/gh%3A1/cert.pdf');
    await expect(storage.downloadForReview('gh:1', 'cert.pdf')).rejects.toThrow('Not allowed to read this file.');
    expect(authenticatedFetch).toHaveBeenCalledWith('https://api.proappstore.online/v1/apps/myapp/storage/_review/u/gh%3A1/cert.pdf');
    await expect(storage.deleteForReview('gh:1', 'cert.pdf')).rejects.toThrow('Not allowed to delete this file.');
    await expect(storageWith(404).storage.deleteForReview('gh:1', 'x.pdf')).rejects.toThrow('File not found.');
    await expect(storageWith(204).storage.deleteForReview('gh:1', 'cert.pdf')).resolves.toBeUndefined();
  });
});

// #259 review: on a private app an <img src> of the API URL carries no session
// and is refused; the host-mediated same-origin URL carries the cookie.
describe('Storage.publicUrl on a private app', () => {
  const auth = (usesPlatformCookie: boolean) => ({ token: null, usesPlatformCookie, handleUnauthorized: vi.fn(), authenticatedFetch: vi.fn() });

  it('is the same-origin /.pas/api URL in platform-cookie mode', () => {
    vi.stubGlobal('window', { location: { origin: 'https://diary.proappstore.online' } });
    try {
      expect(new Storage('diary', 'https://api.proappstore.online', auth(true), true).publicUrl('u/gh:2/a.png'))
        .toBe('https://diary.proappstore.online/.pas/api/v1/apps/diary/public/u/gh:2/a.png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stays the API URL for a public app, and outside cookie mode', () => {
    expect(new Storage('open', 'https://api.proappstore.online', auth(true)).publicUrl('logo.png'))
      .toBe('https://api.proappstore.online/v1/apps/open/public/logo.png');
    expect(new Storage('diary', 'https://api.proappstore.online', auth(false), true).publicUrl('a.png'))
      .toBe('https://api.proappstore.online/v1/apps/diary/public/a.png');
  });
});

describe('resolvePrivateApp', () => {
  it('reads the host marker; an explicit option wins; no document is public', () => {
    expect(resolvePrivateApp()).toBe(false);
    vi.stubGlobal('document', { querySelector: (sel: string) => (sel === 'meta[name="pas-visibility"]' ? { getAttribute: () => 'private' } : null) });
    try {
      expect(resolvePrivateApp()).toBe(true);
      expect(resolvePrivateApp('public')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(resolvePrivateApp('private')).toBe(true);
  });
});
