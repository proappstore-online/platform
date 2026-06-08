/** Authenticated user profile. */
export interface User {
  id: string;
  /** Display name (GitHub handle, Google name, or credential login). */
  name: string;
  /** @deprecated Use `name` instead. Alias kept for backward compatibility. */
  login: string;
  avatarUrl: string | null;
  /**
   * Platform-level date of birth in `YYYY-MM-DD` form. Null until the user
   * has set it through any app — once set, it propagates across the
   * platform and cannot be changed without contacting support.
   */
  dateOfBirth: string | null;
}

/** Options for initializing the SDK via `initApp()`. */
export interface FasInitOptions {
  /** The app's unique identifier (e.g. "tuner", "quicknotes"). */
  appId: string;
  /** Override the API base URL (defaults to https://api.proappstore.online). */
  apiBase?: string;
}

/** Callback returned by subscribe methods — call to unsubscribe. */
export type Unsubscribe = () => void;
