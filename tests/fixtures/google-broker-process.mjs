// SYNTHETIC TEST PROCESS ONLY. No operating environment or real credential vault is read.
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { startGoogleCredentialBroker } from '../../packages/core/src/personal-operations/google-broker-host.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from '../../packages/core/src/personal-operations/google-vault-client.js';
import { BrokerRevocationStore } from '../../packages/core/src/personal-operations/broker-revocation-store.js';
import { readPrivateFile } from '../../packages/core/src/personal-operations/private-file.js';

const pem = name => readFileSync(new URL(`./google-broker-tls/${name}.pem`, import.meta.url));
const row = { connectionId: 'process-google', connectorId: GOOGLE_CONNECTOR_ID, authMethod: 'oauth2',
  scopes: [...GOOGLE_READ_SCOPES], status: 'credentials-stored-unverified', updatedAt: 'process-revision-one' };
let credentialReads = 0, providerCalls = 0;
const credentials = { clientId: 'process-synthetic-client', clientSecret: 'process-synthetic-secret', refreshToken: 'process-synthetic-refresh' };
const vault = { list: () => [{ ...row }], withCredentials: async (id, operation) => {
  credentialReads++; return operation(credentials, { ...row });
} };
const clientFingerprint = new X509Certificate(pem('core')).fingerprint256;
const revocationStore = process.argv[2] ? new BrokerRevocationStore({ path: process.argv[2] }) : null;
const host = await startGoogleCredentialBroker({ vault, tls: { key: process.env.SYNTHETIC_BROKER_PRIVATE_KEY ? readPrivateFile(process.env.SYNTHETIC_BROKER_PRIVATE_KEY) : pem('server-key'), cert: pem('server'), ca: pem('ca'),
  revocationStore, allowedClientFingerprints: [clientFingerprint], clientConnectionScopes: {
    [clientFingerprint.replaceAll(':', '').toUpperCase()]: [row.connectionId]
  } }, fetchImpl: async url => {
    providerCalls++;
    let data;
    if (String(url).endsWith('/token')) data = { access_token: 'process-synthetic-access', expires_in: 3600 };
    else if (String(url).endsWith('/profile')) data = { emailAddress: 'fixture@example.test' };
    else if (String(url).includes('/messages/item-one')) data = { payload: { headers: [{ name: 'Subject', value: '자료 준비' }] } };
    else if (String(url).includes('/messages?')) data = { messages: [{ id: 'item-one' }] };
    else data = { items: [{ id: 'event-one', summary: '회의', start: { date: '2026-10-03' } }] };
    return { ok: true, status: 200, json: async () => data };
  } });
process.send({ type: 'ready', pid: process.pid, uid:process.geteuid?.(), address: host.address, metadata: [{ ...row }] });
process.on('message', async message => {
  if (message?.action === 'stats') process.send({ type: 'stats', credentialReads, providerCalls });
  if (message?.action === 'revoke-client') { host.revokeClient(clientFingerprint); process.send({ type: 'revoked-client' }); }
  if (message?.action === 'revoke-google') { row.status = 'revoked'; process.send({ type: 'revoked-google' }); }
  if (message?.action === 'close') { await host.close(); revocationStore?.close(); process.exit(0); }
});
process.on('disconnect', async () => { await host.close(); revocationStore?.close(); process.exit(0); });
