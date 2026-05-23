import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.proappstore');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  apiBase: string;
  authApiBase: string;
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

const DEFAULT_CONFIG: CliConfig = {
  apiBase: process.env.PAS_API_BASE ?? 'https://api.proappstore.online',
  authApiBase: process.env.PAS_AUTH_API_BASE ?? 'https://api.freeappstore.online',
};

function normalizeApiBase(s: string): string {
  return s.replace(/\/+$/, '');
}

export async function readConfig(): Promise<CliConfig> {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    return {
      ...merged,
      apiBase: normalizeApiBase(merged.apiBase),
      authApiBase: normalizeApiBase(merged.authApiBase),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeConfig(config: CliConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

/**
 * Get a session token from (in priority order):
 * 1. --token CLI flag
 * 2. PAS_SESSION_TOKEN env var
 * 3. ~/.proappstore/config.json session
 */
export function resolveToken(cliToken?: string): string | null {
  if (cliToken) return cliToken;
  if (process.env.PAS_SESSION_TOKEN) return process.env.PAS_SESSION_TOKEN;
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw) as CliConfig;
    if (config.session?.token) return config.session.token;
  } catch {}
  return null;
}
