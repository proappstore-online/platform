import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => {
  exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown>; all(): Record<string, unknown>[] }; close(): void;
} };
it('0126 preserves existing encrypted accounts and grants as legacy consent, but invalidates old pending OAuth', () => {
  const db = new DatabaseSync(':memory:');
  const root = fileURLToPath(new URL('../../../../migrations/', import.meta.url));
  try {
    for (const name of readdirSync(root).filter(n => n.endsWith('.sql') && n < '0126').sort()) db.exec(readFileSync(`${root}/${name}`, 'utf8'));
    db.exec(`PRAGMA foreign_keys=ON;
      INSERT INTO users (id,provider,provider_id,login,created_at,last_login_at) VALUES ('gh:1','github','1','user',1,1);
      INSERT INTO apps (id,creator_id,created_at) VALUES ('first','gh:1',1),('second','gh:1',1);
      INSERT INTO google_calendar_accounts (user_id,version,status,email,google_subject,credential_ct,credential_dek,credential_iv,updated_at) VALUES ('gh:1',7,'connected','person@example.test','123456',X'010203',X'0405',X'0607',1);
      INSERT INTO app_connectors (app_id,name,kind,modes,events,created_at) VALUES ('first','calendar','google_calendar','["oauth"]','[]',1),('second','calendar','google_calendar','["oauth"]','[]',1);
      INSERT INTO google_calendar_app_authorizations VALUES ('first','gh:1',7),('second','gh:1',7);
      INSERT INTO google_calendar_grants (id,app_id,user_id,account_version,calendar_id,calendar_name,created_at) VALUES ('g1','first','gh:1',7,'team@example.test','Team',1),('g2','second','gh:1',7,'team@example.test','Team',1);
      INSERT INTO google_calendar_oauth_states (state_hash,app_id,user_id,account_version,callback_url,return_to,expires_at) VALUES ('old-state','first','gh:1',7,'https://first.proappstore.online/callback','https://first.proappstore.online/',9999999999999);`);
    db.exec(readFileSync(`${root}/0126_google_connector_consent.sql`, 'utf8'));
    expect(db.prepare('SELECT version,hex(credential_ct) AS ciphertext FROM google_calendar_accounts').get()).toEqual({ version: 7, ciphertext: '010203' });
    expect(db.prepare(`SELECT g.id FROM google_calendar_grants g JOIN google_calendar_app_authorizations auth ON auth.app_id=g.app_id AND auth.user_id=g.user_id AND auth.account_version=g.account_version AND auth.authorization_version=g.authorization_version JOIN app_connectors k ON k.app_id=g.app_id AND k.contract_hash=auth.contract_hash ORDER BY g.id`).all()).toEqual([{ id: 'g1' }, { id: 'g2' }]);
    expect(db.prepare('SELECT consent_version,consented_at FROM google_calendar_app_authorizations LIMIT 1').get()).toEqual({ consent_version: 0, consented_at: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM google_calendar_oauth_states').get().n).toBe(0);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec("UPDATE app_connectors SET contract_hash='changed' WHERE app_id='first'");
    expect(db.prepare('SELECT app_id FROM google_calendar_app_authorizations').all()).toEqual([{ app_id: 'second' }]);
    expect(db.prepare('SELECT id FROM google_calendar_grants').all()).toEqual([{ id: 'g2' }]);
  } finally { db.close(); }
});
