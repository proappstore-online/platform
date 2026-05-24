/**
 * Proxy allowlist: per-app rules for what upstream URLs the secret-injecting
 * proxy will forward to. Two responsibilities:
 *
 *   1. Hard blocklist of AI-provider hosts at *registration* time. Free-tier
 *      app proxy is for cheap third-party APIs (weather, music, etc.) — not
 *      for OpenAI/Anthropic/etc., which route through the PAS key vault and
 *      have real billing teeth. Block early so a leaked OpenAI key in this
 *      table can't quietly drain a developer's account.
 *   2. Match an inbound proxy request (URL + method) against the registered
 *      rules at *call* time, and return the rule that wins (or null).
 */
export interface AllowlistRule {
  pattern: string; // URL prefix, no globs
  injectKind: 'query' | 'header' | 'bearer' | 'oauth2_cc';
  injectName: string; // ignored for 'bearer' and 'oauth2_cc'
  secretName: string; // FK to app_secrets.name (client_id for oauth2_cc)
  secretName2: string; // FK to app_secrets.name for client_secret (oauth2_cc only)
  tokenUrl: string; // token endpoint URL (oauth2_cc only)
  methods: string[]; // upper-case HTTP verbs
}

/**
 * Hosts that must use the PAS key vault, not this proxy. Match is on the
 * registerable host (eTLD+1 conceptually); we check both exact and suffix
 * (`.openai.com`) so subdomains like `api.openai.com` are caught too.
 */
const AI_PROVIDER_HOSTS = [
  'openai.com',
  'anthropic.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
] as const;

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllowlistError';
  }
}

/**
 * Validate a rule about to be inserted. Throws AllowlistError on rejection.
 * Caller is responsible for the auth + ownership checks.
 */
export function validateRule(input: {
  pattern: string;
  injectKind: string;
  injectName: string;
  secretName: string;
  secretName2?: string;
  tokenUrl?: string;
  methods: string[];
}): AllowlistRule {
  const { pattern, injectKind, injectName, secretName, methods } = input;

  if (!pattern.startsWith('https://')) {
    throw new AllowlistError('pattern must start with https://');
  }
  let url: URL;
  try {
    url = new URL(pattern);
  } catch {
    throw new AllowlistError('pattern is not a valid URL');
  }
  if (isAiProviderHost(url.hostname)) {
    throw new AllowlistError(
      `host ${url.hostname} is reserved for the PAS AI key vault and cannot be used with the free app-secret proxy`,
    );
  }
  const validKinds = ['query', 'header', 'bearer', 'oauth2_cc'] as const;
  if (!validKinds.includes(injectKind as typeof validKinds[number])) {
    throw new AllowlistError(`injectKind must be one of: ${validKinds.join(', ')}`);
  }
  if (injectKind !== 'bearer' && injectKind !== 'oauth2_cc' && !injectName) {
    throw new AllowlistError(`injectName is required for injectKind='${injectKind}'`);
  }
  if (!secretName) {
    throw new AllowlistError('secretName is required');
  }

  // OAuth2 client_credentials requires a second secret (client_secret) and a token URL
  let secretName2 = input.secretName2 ?? '';
  let tokenUrl = input.tokenUrl ?? '';
  if (injectKind === 'oauth2_cc') {
    if (!secretName2) {
      throw new AllowlistError('secretName2 (client_secret) is required for oauth2_cc');
    }
    if (!tokenUrl) {
      throw new AllowlistError('tokenUrl is required for oauth2_cc');
    }
    if (!tokenUrl.startsWith('https://')) {
      throw new AllowlistError('tokenUrl must start with https://');
    }
    let tokenHost: string;
    try { tokenHost = new URL(tokenUrl).hostname; } catch {
      throw new AllowlistError('tokenUrl is not a valid URL');
    }
    if (isAiProviderHost(tokenHost)) {
      throw new AllowlistError(
        `tokenUrl host ${tokenHost} is reserved for the PAS AI key vault`,
      );
    }
    // Block private/internal hosts on tokenUrl (same as webhook validation)
    const h = tokenHost.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
        h === '[::1]' || h.endsWith('.local') ||
        h.startsWith('10.') || h.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h === '169.254.169.254') {
      throw new AllowlistError('tokenUrl must not point to private/internal addresses');
    }
  }

  if (!Array.isArray(methods) || methods.length === 0) {
    throw new AllowlistError('methods must be a non-empty array');
  }
  const upperMethods = methods.map((m) => m.toUpperCase());
  for (const m of upperMethods) {
    if (!/^[A-Z]+$/.test(m)) {
      throw new AllowlistError(`invalid HTTP method: ${m}`);
    }
  }
  return {
    pattern,
    injectKind: injectKind as AllowlistRule['injectKind'],
    injectName,
    secretName,
    secretName2,
    tokenUrl,
    methods: upperMethods,
  };
}

/**
 * Pick the rule that matches an inbound proxy request. Returns null if none.
 * Match = pattern is a prefix of url AND method is allowed. If multiple rules
 * match, the longest pattern wins (most specific).
 */
export function pickRule(
  rules: AllowlistRule[],
  url: string,
  method: string,
): AllowlistRule | null {
  const upperMethod = method.toUpperCase();
  let best: AllowlistRule | null = null;
  for (const rule of rules) {
    if (!url.startsWith(rule.pattern)) continue;
    if (!rule.methods.includes(upperMethod)) continue;
    if (best === null || rule.pattern.length > best.pattern.length) {
      best = rule;
    }
  }
  return best;
}

/**
 * Inject the (already decrypted) secret into a request per the rule.
 * Returns the new URL + headers to use for the upstream fetch.
 */
export function injectSecret(
  rule: AllowlistRule,
  url: string,
  headers: Headers,
  secret: string,
): { url: string; headers: Headers } {
  const out = new Headers(headers);
  if (rule.injectKind === 'header') {
    out.set(rule.injectName, secret);
    return { url, headers: out };
  }
  if (rule.injectKind === 'bearer' || rule.injectKind === 'oauth2_cc') {
    out.set('Authorization', `Bearer ${secret}`);
    return { url, headers: out };
  }
  // query
  const u = new URL(url);
  u.searchParams.set(rule.injectName, secret);
  return { url: u.toString(), headers: out };
}

export function isAiProviderHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  for (const blocked of AI_PROVIDER_HOSTS) {
    if (h === blocked || h.endsWith(`.${blocked}`)) return true;
  }
  return false;
}
