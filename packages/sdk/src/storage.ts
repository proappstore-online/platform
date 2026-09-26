interface AuthLike {
  token: string | null;
  handleUnauthorized(): void;
  authenticatedFetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

interface UploadResult {
  key: string;
  size: number;
  contentType: string;
  url: string;
}

interface FileInfo {
  key: string;
  size: number;
  uploaded: string;
}

/**
 * File storage — upload, download, list, delete files.
 * Backed by R2 on the PAS API, scoped to (appId, userId).
 */
export class Storage {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: AuthLike,
  ) {}

  /** Upload a file. Returns the upload result with the file URL. */
  async upload(path: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<UploadResult> {
    const url = `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/storage/${path}`;
    const response = await this.auth.authenticatedFetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || (data instanceof Blob ? data.type : 'application/octet-stream'),
      },
      body: data as BodyInit,
    });

    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`storage.upload failed (${response.status}): ${text}`);
    }

    return (await response.json()) as UploadResult;
  }

  /** Download a file. Returns the Response (use .blob(), .arrayBuffer(), etc.). */
  async download(path: string): Promise<Response> {
    const url = `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/storage/${path}`;
    const response = await this.auth.authenticatedFetch(url);

    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (response.status === 404) throw new Error('File not found.');
    if (!response.ok) throw new Error(`storage.download failed: ${response.status}`);

    return response;
  }

  /**
   * Upload a public file. Anyone can view it without auth (for profile pics, event photos, etc.).
   * Stored under the _public/ prefix. Returns a public URL usable in <img src>.
   */
  async uploadPublic(path: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<UploadResult> {
    return this.upload(`_public/${path}`, data, contentType);
  }

  /**
   * Upload a user-generated PUBLIC file (rating photos, user avatars, etc.).
   * Unlike uploadPublic (owner-only), ANY signed-in user can call this — the file
   * is stored publicly under the caller's own id, which the server assigns from the
   * session, so users can't spoof or overwrite each other. The returned `key`
   * (e.g. `u/<userId>/<path>`) is what you pass to publicUrl() + store in your DB.
   */
  async uploadUserPublic(path: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<UploadResult> {
    return this.upload(`_userpub/${path}`, data, contentType);
  }

  /**
   * Upload a private document for review (#208) — e.g. a registration
   * certificate. Only you and holders of the app's declared review roles can
   * read it; it is never public or cached. PDF, PNG, JPEG, WebP or HEIC only.
   * The returned `key` (`_review/u/<userId>/<path>`) is what reviewers pass to
   * downloadForReview(); store it on the row under review.
   */
  async uploadForReview(path: string, data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Promise<UploadResult> {
    return this.upload(`_review/${path}`, data, contentType);
  }

  /** The authenticated URL of a review upload (send the session; never usable in a bare <img src>). */
  reviewUrl(userId: string, path: string): string {
    return this.url(`_review/u/${encodeURIComponent(userId)}/${path}`);
  }

  /**
   * Download a review upload — as its uploader, or as a holder of a review role.
   * Every reviewer read is recorded in the app's audit trail. Throws
   * 'Not allowed to read this file.' for anyone else.
   */
  async downloadForReview(userId: string, path: string): Promise<Response> {
    const response = await this.auth.authenticatedFetch(this.reviewUrl(userId, path));
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (response.status === 403) throw new Error('Not allowed to read this file.');
    if (response.status === 404) throw new Error('File not found.');
    if (!response.ok) throw new Error(`storage.downloadForReview failed: ${response.status}`);
    return response;
  }

  /** Delete a review upload — its uploader or a reviewer. Throws if there is no such file or you may not. */
  async deleteForReview(userId: string, path: string): Promise<void> {
    return this.remove(`_review/u/${encodeURIComponent(userId)}/${path}`, false);
  }

  /** Get a public URL for a file (no auth needed, usable in <img src>). File must have been uploaded with uploadPublic(). */
  publicUrl(path: string): string {
    return `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/public/${path}`;
  }

  /** Get a private URL for a file (requires auth header). */
  url(path: string): string {
    return `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/storage/${path}`;
  }

  /** List all files for the current user in this app. */
  async list(): Promise<FileInfo[]> {
    const url = `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/files`;
    const response = await this.auth.authenticatedFetch(url);

    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) throw new Error(`storage.list failed: ${response.status}`);

    const data = (await response.json()) as { files: FileInfo[] };
    return data.files;
  }

  /** Delete one of your own private files. A missing file is not an error. */
  async delete(path: string): Promise<void> {
    return this.remove(path, true);
  }

  /**
   * Delete one of YOUR user-public files — the `path` you passed to uploadUserPublic(),
   * not the returned `u/<userId>/…` key. The server scopes it to the caller's id, so
   * nobody can delete another user's upload this way. Throws if there is no such file.
   */
  async deleteUserPublic(path: string): Promise<void> {
    return this.remove(`_userpub/${path}`, false);
  }

  /**
   * Delete a public file by its key, for the app team: a user upload's returned key
   * (`u/<userId>/…`, team admin+, for takedowns) or an owner-curated uploadPublic()
   * path (app owner). Browsers may keep serving a deleted public file from cache for
   * up to a year, so upload each version under a fresh path when takedown speed matters.
   * Throws if there is no such file, so a wrong key is never a silent success.
   */
  async deletePublic(key: string): Promise<void> {
    return this.remove(`_public/${key}`, false);
  }

  private async remove(path: string, missingOk: boolean): Promise<void> {
    const url = `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/storage/${path}`;
    const response = await this.auth.authenticatedFetch(url, {
      method: 'DELETE',
    });

    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (response.status === 404 && missingOk) return;
    if (response.status === 404) throw new Error('File not found.');
    if (response.status === 403) throw new Error('Not allowed to delete this file.');
    if (!response.ok) {
      throw new Error(`storage.delete failed: ${response.status}`);
    }
  }
}
