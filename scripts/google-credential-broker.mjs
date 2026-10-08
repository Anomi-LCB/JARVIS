import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { IntegrationCredentialVault } from '../packages/core/src/personal-operations/integration-security.js';
import { startGoogleCredentialBroker } from '../packages/core/src/personal-operations/google-broker-host.js';
import { OpenBaoGoogleVault } from '../packages/core/src/personal-operations/openbao-google-vault.js';
import { BrokerRevocationStore } from '../packages/core/src/personal-operations/broker-revocation-store.js';
import { readPrivateFile } from '../packages/core/src/personal-operations/private-file.js';

/** Separate-process entrypoint. Never auto-discovers the Core/user vault or a test certificate. */
export async function runConfiguredGoogleCredentialBroker({ env = process.env } = {}) {
  const openbao = env.JARVIS_BROKER_SECRET_STORE === 'openbao';
  if (process.platform !== 'win32' && !openbao) throw new Error('A_GOOGLE_BROKER_LINUX_SECRET_STORE_REQUIRED');
  if (env.JARVIS_BROKER_SECRET_STORE && !['openbao', 'windows-dpapi'].includes(env.JARVIS_BROKER_SECRET_STORE)) throw new Error('A_GOOGLE_BROKER_CONFIG_INCOMPLETE');
  const names = ['JARVIS_BROKER_TLS_KEY', 'JARVIS_BROKER_TLS_CERT', 'JARVIS_BROKER_REVOCATIONS',
    'JARVIS_BROKER_TLS_CA', 'JARVIS_BROKER_CLIENT_FINGERPRINT', 'JARVIS_BROKER_GOOGLE_CONNECTION_ID', 'JARVIS_BROKER_PORT',
    ...(openbao ? ['JARVIS_BROKER_OPENBAO_URL', 'JARVIS_BROKER_OPENBAO_CA', 'JARVIS_BROKER_OPENBAO_TOKEN_FILE', 'JARVIS_BROKER_OPENBAO_VERSION'] : ['JARVIS_BROKER_GOOGLE_VAULT'])];
  if (names.some(name => typeof env[name] !== 'string' || !env[name])) throw new Error('A_GOOGLE_BROKER_CONFIG_INCOMPLETE');
  const port = Number(env.JARVIS_BROKER_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('A_GOOGLE_BROKER_LISTEN_CONFIG_INVALID');
  let key, cert, ca;
  try {
    cert = readFileSync(resolve(env.JARVIS_BROKER_TLS_CERT));
    ca = readFileSync(resolve(env.JARVIS_BROKER_TLS_CA));
    if ([cert, ca].some(bytes => /TEST ONLY/u.test(new X509Certificate(bytes).subject))) {
      throw new Error('A_GOOGLE_BROKER_TEST_CERT_DENIED');
    }
    key = readPrivateFile(env.JARVIS_BROKER_TLS_KEY);
  } catch (error) {
    throw new Error(error?.message === 'A_GOOGLE_BROKER_TEST_CERT_DENIED' ? error.message : 'A_GOOGLE_BROKER_TLS_FILES_INVALID');
  }
  const readPrivateToken = () => {
    try {
      return readPrivateFile(env.JARVIS_BROKER_OPENBAO_TOKEN_FILE).toString('utf8').trim();
    } catch { throw new Error('A_GOOGLE_BROKER_SECRET_STORE_AUTH_DENIED'); }
  };
  const vault = openbao ? new OpenBaoGoogleVault({ url: env.JARVIS_BROKER_OPENBAO_URL,
    ca: readFileSync(resolve(env.JARVIS_BROKER_OPENBAO_CA)), token: readPrivateToken,
    connections: [{ connectionId: env.JARVIS_BROKER_GOOGLE_CONNECTION_ID, version: Number(env.JARVIS_BROKER_OPENBAO_VERSION) }] })
    : new IntegrationCredentialVault({ path: resolve(env.JARVIS_BROKER_GOOGLE_VAULT), storageLocation: 'explicit-broker-exclusive-vault' });
  const revocationStore = new BrokerRevocationStore({ path: resolve(env.JARVIS_BROKER_REVOCATIONS) });
  let host;
  try { host = await startGoogleCredentialBroker({ vault, port, tls: { key, cert, ca, revocationStore,
    allowedClientFingerprints: [env.JARVIS_BROKER_CLIENT_FINGERPRINT], clientConnectionScopes: {
      [env.JARVIS_BROKER_CLIENT_FINGERPRINT.replaceAll(':', '').toUpperCase()]: [env.JARVIS_BROKER_GOOGLE_CONNECTION_ID]
    } } }); } catch (error) { revocationStore.close(); vault.close?.(); throw error; }
  return Object.freeze({ ...host, async close() { try { await host.close(); } finally { revocationStore.close(); vault.close?.(); } } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const host = await runConfiguredGoogleCredentialBroker();
    console.log(JSON.stringify({ status: 'listening', host: host.address.address, port: host.address.port, transport: 'mtls' }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await host.close(); process.exit(0); });
  } catch (error) {
    console.error(/^A_GOOGLE_BROKER_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'A_GOOGLE_BROKER_START_FAILED');
    process.exitCode = 1;
  }
}
