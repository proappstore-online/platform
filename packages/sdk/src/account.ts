import type { Auth } from './auth.js';

/** An app's own cleanup, run before the platform deletes its data for the user. */
export type DeleteHandler = () => Promise<void> | void;

export interface PublicFileInfo {
  /** The publicUrl path: `u/<userId>/<path>`. */
  key: string;
  size: number;
  uploaded: string;
}

/**
 * Per-app account deletion (#379). Deleting an account removes the user's data
 * in THIS app only — never their ProAppStore sign-in, their subscription, or
 * their data in any other app.
 *
 * `delete()` runs the app's handler (registered with `onDelete`) first, then
 * the platform removes what it holds for the user in this app (kv, files,
 * public uploads, review uploads, app roles, push subscriptions, app tokens)
 * and records them as deleted for this app, then signs out. If the handler
 * throws, nothing is deleted by the platform and the error propagates.
 *
 * The app's own database rows are the app's to delete or anonymise in its
 * handler — only the app knows which rows are the user's personal data.
 */
export class Account {
  private handler: DeleteHandler | null = null;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /**
   * Register the app's deletion handler. The SDK's "Delete account" menu items
   * (`ProfileMenu`, `ProProfilePage`) call it through `delete()`. Returns an
   * unregister function.
   */
  onDelete(handler: DeleteHandler): () => void {
    this.handler = handler;
    return () => { if (this.handler === handler) this.handler = null; };
  }

  /** Delete the signed-in user's account in this app, then sign out. */
  async delete(): Promise<void> {
    const url = this.url('account');
    await this.handler?.();
    const response = await this.auth.authenticatedFetch(url, { method: 'DELETE' });
    if (response.status === 401) {
      this.auth.handleUnauthorized();
      throw new Error('Not signed in.');
    }
    if (!response.ok) throw new Error(`account.delete failed: ${response.status}`);
    this.auth.signOut();
  }

  /** Whether the signed-in user has deleted their account in this app — an app can refuse them. */
  async isDeleted(): Promise<boolean> {
    const response = await this.auth.authenticatedFetch(this.url('account'));
    if (!response.ok) throw new Error(`account.isDeleted failed: ${response.status}`);
    return ((await response.json()) as { deleted: boolean }).deleted;
  }

  /** The signed-in user's public uploads in this app, including ones the app no longer references. */
  async publicFiles(): Promise<PublicFileInfo[]> {
    const response = await this.auth.authenticatedFetch(this.url('public-files'));
    if (!response.ok) throw new Error(`account.publicFiles failed: ${response.status}`);
    return ((await response.json()) as { files: PublicFileInfo[] }).files;
  }

  private url(path: string): URL {
    const user = this.auth.user;
    if (!user) throw new Error('Not signed in.');
    return new URL(`/v1/apps/${encodeURIComponent(this.appId)}/users/${encodeURIComponent(user.id)}/${path}`, this.apiBase);
  }
}
