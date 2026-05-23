import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Single config file — FAS owns identity, PAS reads and writes the same file.
// One login, one session, shared across both CLIs.
const CONFIG_DIR = join(homedir(), '.fas');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  apiBase: string;
  github?: {
    accessToken: string;
    login: string;
    obtainedAt: number;
  };
  session?: {
    token: string;
    obtainedAt: number;
  };
}

const FAS_API_BASE = process.env.FAS_API_BASE ?? 'https://api.freeappstore.online';
const PAS_API_BASE = process.env.PAS_API_BASE ?? 'https://api.proappstore.online';

function normalizeApiBase(s: string): string {
  return s.replace(/\/+$/, '');
}

export async function readConfig(): Promise<CliConfig & { pasApiBase: string }> {
  let config: CliConfig;
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    config = { apiBase: FAS_API_BASE, ...parsed };
  } catch {
    config = { apiBase: FAS_API_BASE };
  }
  return {
    ...config,
    apiBase: normalizeApiBase(config.apiBase),
    pasApiBase: normalizeApiBase(PAS_API_BASE),
  };
}

export async function writeConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

/**
 * Get a session token from (in priority order):
 * 1. --token CLI flag
 * 2. FAS_SESSION_TOKEN env var
 * 3. ~/.fas/config.json session (shared across fas + pas CLIs)
 */
export function resolveToken(cliToken?: string): string | null {
  if (cliToken) return cliToken;
  if (process.env.FAS_SESSION_TOKEN) return process.env.FAS_SESSION_TOKEN;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw) as CliConfig;
    if (config.session?.token) return config.session.token;
  } catch {}
  return null;
}
