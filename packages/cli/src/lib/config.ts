import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.pas');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const FAS_CONFIG_FILE = join(homedir(), '.fas', 'config.json');

export interface PasConfig {
  apiBase: string;
  fasApiBase: string;
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

const DEFAULT_CONFIG: PasConfig = {
  apiBase: process.env.PAS_API_BASE ?? 'https://api.proappstore.online',
  fasApiBase: process.env.FAS_API_BASE ?? 'https://api.freeappstore.online',
};

function normalizeApiBase(s: string): string {
  return s.replace(/\/+$/, '');
}

export async function readConfig(): Promise<PasConfig> {
  // Try PAS config first
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PasConfig>;
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    return { ...merged, apiBase: normalizeApiBase(merged.apiBase), fasApiBase: normalizeApiBase(merged.fasApiBase) };
  } catch {
    // Fall back to FAS config (shared identity)
    try {
      const raw = await readFile(FAS_CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PasConfig>;
      return {
        ...DEFAULT_CONFIG,
        ...(parsed.github && { github: parsed.github }),
        ...(parsed.session && { session: parsed.session }),
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }
}

export async function writeConfig(config: PasConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}

/**
 * Get a session token from (in priority order):
 * 1. --token CLI flag
 * 2. FAS_SESSION_TOKEN env var
 * 3. ~/.pas/config.json session
 * 4. ~/.fas/config.json session (fallback — shared identity)
 */
export function resolveToken(cliToken?: string): string | null {
  if (cliToken) return cliToken;
  if (process.env.FAS_SESSION_TOKEN) return process.env.FAS_SESSION_TOKEN;
  // Try PAS config
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw) as PasConfig;
    if (config.session?.token) return config.session.token;
  } catch {}
  // Fall back to FAS config
  try {
    const raw = readFileSync(FAS_CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw) as Partial<PasConfig>;
    if (config.session?.token) return config.session.token;
  } catch {}
  return null;
}
