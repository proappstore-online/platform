export interface Env {
  API_BASE: string;
  /** Agent Teams API base (the autonomous build loop). e.g. https://agents.proappstore.online */
  AGENTS_BASE: string;
  /** Shared PAS session signing key — verifies session JWTs locally (no FAS). */
  SESSION_SIGNING_KEY: string;
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
}
