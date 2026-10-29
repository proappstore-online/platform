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
  /**
   * Whether this is a child account (provisioned with `isChild`, no email, no real name). The server reads it from the account record,
   * and a registered action's SQL sees the same fact as `:__user_is_child`: gate the UI on this, enforce in the SQL.
   */
  isChild: boolean;
}

/** Callback returned by subscribe methods — call to unsubscribe. */
export type Unsubscribe = () => void;
