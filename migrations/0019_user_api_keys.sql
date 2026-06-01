-- User API Key Vault — encrypted per-user API keys for third-party services.
-- Vendored from FAS (migration 0012). PAS owns its own copy.
--
-- Keys use envelope encryption (same KEK as app_secrets) and are never
-- returned to app clients. The PAS Agent Teams worker resolves a user's
-- BYO LLM key via the internal /v1/keys/resolve/:provider endpoint over the
-- PAS_BACKEND service binding; the proxy injects them server-side otherwise.

CREATE TABLE IF NOT EXISTS user_api_keys (
  user_id        TEXT    NOT NULL,
  provider       TEXT    NOT NULL,  -- e.g. 'openai', 'anthropic'
  label          TEXT,              -- user-friendly label, e.g. 'My Anthropic key'
  key_ciphertext BLOB    NOT NULL,
  dek_wrapped    BLOB    NOT NULL,
  iv             BLOB    NOT NULL,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_used_at   INTEGER,
  PRIMARY KEY (user_id, provider)
);

-- Supported providers registry. Platform-managed, not user-editable.
CREATE TABLE IF NOT EXISTS key_providers (
  id          TEXT PRIMARY KEY,  -- e.g. 'openai'
  name        TEXT NOT NULL,     -- e.g. 'OpenAI'
  docs_url    TEXT,              -- Link to the provider's API key page
  key_prefix  TEXT,              -- Expected prefix for validation, e.g. 'sk-'
  created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Seed the providers PAS Agent Teams runtimes can use (cf-native -> anthropic,
-- openai-responses -> openai), plus common adjacents.
INSERT OR IGNORE INTO key_providers (id, name, docs_url, key_prefix) VALUES
  ('anthropic',  'Anthropic',  'https://console.anthropic.com/settings/keys', 'sk-ant-'),
  ('openai',     'OpenAI',     'https://platform.openai.com/api-keys',        'sk-'),
  ('openrouter', 'OpenRouter', 'https://openrouter.ai/settings/keys',         'sk-or-'),
  ('google-ai',  'Google AI',  'https://aistudio.google.com/apikey',          'AI');
