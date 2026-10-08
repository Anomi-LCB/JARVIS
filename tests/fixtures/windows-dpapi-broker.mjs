// Isolated synthetic credential experiment. No operating vault or real provider access.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { IntegrationCredentialVault } from '../../packages/core/src/personal-operations/integration-security.js';
import { startGoogleCredentialBroker } from '../../packages/core/src/personal-operations/google-broker-host.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../../packages/core/src/personal-operations/google-vault-client.js';
import { readPrivateFile } from '../../packages/core/src/personal-operations/private-file.js';

const root = process.argv[2];
const pem = name => readFileSync(new URL(`./google-broker-tls/${name}.pem`, import.meta.url));
const credentials = { clientId: 'dpapi-synthetic-client', clientSecret: 'dpapi-synthetic-secret', refreshToken: 'dpapi-synthetic-refresh' };
const vault = new IntegrationCredentialVault({ path: join(root, 'vault.json'), storageLocation: 'synthetic-broker-exclusive-temp', clock: () => new Date('2026-10-03T00:00:00Z') });
let host;
try {
  if (process.argv[3] === '--initialize') vault.save({ connectorId: GOOGLE_CONNECTOR_ID, providerAccountId: 'synthetic@example.test', authMethod: 'oauth2', scopes: GOOGLE_READ_SCOPES, credentials });
  const metadata = vault.list();
  if (process.argv[3] === '--probe') {
    await new Promise(resolve => process.send({ type: 'probe', connectionCount: metadata.length }, resolve));
    process.exit(0);
  }
  const peer = new X509Certificate(pem('core')).fingerprint256;
  let providerCalls = 0;
  host = await startGoogleCredentialBroker({ vault, tls: {
    key: readPrivateFile(join(root, 'server-key.pem')), cert: pem('server'), ca: pem('ca'),
    allowedClientFingerprints: [peer], clientConnectionScopes: { [peer.replaceAll(':', '').toUpperCase()]: metadata.map(row => row.connectionId) }
  }, fetchImpl: async (url, options) => {
    providerCalls++;
    if (options.redirect !== 'error') throw new Error('synthetic-request-invalid');
    if (String(url).endsWith('/token')) {
      const body = new URLSearchParams(options.body);
      if (body.get('client_secret') !== credentials.clientSecret || body.get('refresh_token') !== credentials.refreshToken) throw new Error('synthetic-request-invalid');
      return { ok: true, status: 200, json: async () => ({ access_token: 'dpapi-synthetic-access', expires_in: 3600 }) };
    }
    if (options.headers.authorization !== 'Bearer dpapi-synthetic-access') throw new Error('synthetic-request-invalid');
    return { ok: true, status: 200, json: async () => ({ emailAddress: 'synthetic@example.test' }) };
  } });
  process.send({ type: 'ready', pid: process.pid, address: host.address, metadata });
  process.on('message', async message => {
    if (message?.action === 'stats') process.send({ type: 'stats', providerCalls });
    if (message?.action === 'remove') process.send({ type: 'removed', ...vault.remove(metadata[0].connectionId) });
  });
  process.on('disconnect', async () => { await host.close(); process.exit(0); });
} catch (error) {
  process.send({ type: 'startup-failed', code: error.message === 'A_INTEGRATION_VAULT_UNREADABLE' ? error.message : 'SYNTHETIC_BROKER_START_FAILED' });
  if (host) await host.close();
  process.exitCode = 1;
  process.disconnect();
}
