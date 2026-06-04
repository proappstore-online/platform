export interface Env {
  API_BASE: string;
  /** Agent Teams API base (the autonomous build loop). e.g. https://agents.proappstore.online */
  AGENTS_BASE: string;
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
}
