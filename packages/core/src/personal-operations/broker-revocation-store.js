import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const normalize = value => {
  const id = String(value).replaceAll(':', '').toUpperCase();
  if (!/^[A-F0-9]{64}$/u.test(id)) throw new Error('A_GOOGLE_BROKER_FINGERPRINT_INVALID');
  return id;
};

/** Broker-owned append-only certificate revocations. No credentials or un-revoke operation. */
export class BrokerRevocationStore {
  #db;
  constructor({ path, clock = () => new Date() } = {}) {
    if (typeof path !== 'string' || !path || path === ':memory:') throw new Error('A_GOOGLE_BROKER_REVOCATION_PATH_REQUIRED');
    this.clock = clock;
    const file = resolve(path); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      this.#db = new DatabaseSync(file);
      if (process.platform !== 'win32') chmodSync(file, 0o600);
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS broker_certificate_revocations(fingerprint TEXT PRIMARY KEY, revoked_at TEXT NOT NULL, reason TEXT NOT NULL)');
    } catch { this.#db?.close(); throw new Error('A_GOOGLE_BROKER_REVOCATION_STORE_UNAVAILABLE'); }
  }
  isRevoked(value) {
    const id = normalize(value);
    try { return Boolean(this.#db.prepare('SELECT 1 FROM broker_certificate_revocations WHERE fingerprint=?').get(id)); }
    catch { throw new Error('A_GOOGLE_BROKER_REVOCATION_STORE_UNAVAILABLE'); }
  }
  revoke(value, reason = 'user-revoked') {
    const id = normalize(value);
    if (!['user-revoked', 'certificate-compromised', 'credential-reset'].includes(reason)) throw new Error('A_GOOGLE_BROKER_REVOCATION_REASON_INVALID');
    try { return this.#db.prepare('INSERT OR IGNORE INTO broker_certificate_revocations VALUES(?,?,?)').run(id, this.clock().toISOString(), reason).changes > 0; }
    catch { throw new Error('A_GOOGLE_BROKER_REVOCATION_STORE_UNAVAILABLE'); }
  }
  close() { this.#db.close(); }
}
