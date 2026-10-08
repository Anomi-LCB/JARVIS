import { Agent, request } from 'node:https';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from './google-vault-client.js';

const fail = code => { throw new Error(code); };
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

/** Broker-exclusive KV v2 reader. No writes, listing, secret export or historical-version fallback. */
export class OpenBaoGoogleVault {
  #agent; #base; #mount; #token; #connections;
  constructor({ url, ca, mount = 'jarvis', token, connections } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash
      || target.pathname !== '/' || !ca || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(mount)
      || typeof token !== 'function' || !Array.isArray(connections) || !connections.length
      || connections.some(row => !idPattern.test(row?.connectionId ?? '')
        || !Number.isSafeInteger(row.version) || row.version < 1)
      || new Set(connections.map(row => row.connectionId)).size !== connections.length) fail('A_GOOGLE_BROKER_SECRET_STORE_CONFIG_INVALID');
    this.#base = target; this.#mount = mount; this.#token = token;
    this.#connections = connections.map(({ connectionId, version }) => ({ connectionId, version }));
    this.#agent = new Agent({ ca, rejectUnauthorized: true, minVersion: 'TLSv1.3', keepAlive: true, maxSockets: 4 });
  }
  list() {
    return this.#connections.map(({ connectionId, version }) => ({ connectionId, connectorId: GOOGLE_CONNECTOR_ID,
      authMethod: 'oauth2', scopes: [...GOOGLE_READ_SCOPES], updatedAt: `openbao-kv-v2:${version}`, status: 'credentials-stored-unverified' }));
  }
  async #read(id) {
    const expected = this.#connections.find(row => row.connectionId === id);
    if (!expected) fail('A_GOOGLE_BROKER_CONNECTION_REQUIRED');
    let token;
    try { token = await this.#token(); } catch { fail('A_GOOGLE_BROKER_SECRET_STORE_AUTH_DENIED'); }
    if (typeof token !== 'string' || !token || token.length > 16384 || /[\r\n]/u.test(token)) fail('A_GOOGLE_BROKER_SECRET_STORE_AUTH_DENIED');
    const url = new URL(`/v1/${this.#mount}/data/${id}`, this.#base);
    const body = await new Promise((resolve, reject) => {
      const denied = code => reject(new Error(code));
      const req = request(url, { method: 'GET', agent: this.#agent, signal: AbortSignal.timeout(10000),
        headers: { 'X-Vault-Token': token } }, res => {
        let size = 0; const chunks = [];
        res.on('data', bytes => {
          size += bytes.length;
          if (size > 65536) { denied('A_GOOGLE_BROKER_SECRET_STORE_RESPONSE_INVALID'); res.destroy(); return; }
          chunks.push(bytes);
        });
        res.on('error', () => denied('A_GOOGLE_BROKER_SECRET_STORE_UNAVAILABLE'));
        res.on('end', () => {
          if ([401, 403].includes(res.statusCode)) return denied('A_GOOGLE_BROKER_SECRET_STORE_AUTH_DENIED');
          if (res.statusCode === 404) return denied('A_GOOGLE_BROKER_CONNECTION_REQUIRED');
          if (res.statusCode !== 200) return denied('A_GOOGLE_BROKER_SECRET_STORE_UNAVAILABLE');
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { denied('A_GOOGLE_BROKER_SECRET_STORE_RESPONSE_INVALID'); }
        });
      });
      req.on('error', () => denied('A_GOOGLE_BROKER_SECRET_STORE_UNAVAILABLE')); req.end();
    });
    const metadata = body?.data?.metadata, value = body?.data?.data;
    if (metadata?.version !== expected.version) fail('A_GOOGLE_BROKER_REVISION_CONFLICT');
    if (metadata.destroyed || metadata.deletion_time || value?.status !== 'active') fail('A_GOOGLE_BROKER_CONNECTION_REQUIRED');
    if (value?.schemaVersion !== 1 || value.connectionId !== id || value.connectorId !== GOOGLE_CONNECTOR_ID
      || value.authMethod !== 'oauth2' || !Array.isArray(value.scopes)
      || value.scopes.some(scope => !GOOGLE_READ_SCOPES.includes(scope))
      || !GOOGLE_READ_SCOPES.every(scope => value.scopes.includes(scope))
      || !value.credentials || Object.keys(value.credentials).sort().join(',') !== 'clientId,clientSecret,refreshToken'
      || !Object.values(value.credentials).every(secret => typeof secret === 'string' && secret.length > 0 && secret.length <= 16384)) {
      fail('A_GOOGLE_BROKER_SECRET_STORE_RESPONSE_INVALID');
    }
    if (value.expiresAt != null && (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now())) fail('A_GOOGLE_BROKER_CONNECTION_REQUIRED');
    return value;
  }
  async withCredentials(id, operation) {
    const value = await this.#read(id);
    const metadata = this.list().find(row => row.connectionId === id);
    const result = await operation(Object.freeze({ ...value.credentials }), Object.freeze(metadata));
    await this.#read(id); // rotation, removal or token revocation during work suppresses its result
    return result;
  }
  close() { this.#agent.destroy(); }
}
