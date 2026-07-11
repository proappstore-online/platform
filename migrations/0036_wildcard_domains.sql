-- Wildcard app base domains: kind='wildcard' rows store the BASE domain
-- (e.g. 'chessclubs.online'); every single-label subdomain of it serves the app.
ALTER TABLE app_custom_domains ADD COLUMN kind TEXT NOT NULL DEFAULT 'exact';

-- Host worker resolves by domain alone; PRIMARY KEY (app_id, domain) leads on
-- app_id, so hostname lookups need a domain-first index.
CREATE INDEX IF NOT EXISTS idx_app_custom_domains_domain
  ON app_custom_domains(domain, status);
