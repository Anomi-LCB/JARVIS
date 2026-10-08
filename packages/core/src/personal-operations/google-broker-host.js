import { IntegrationConnectorRegistry } from './integration-security.js';
import { createGoogleOperationBroker } from './google-operation-broker.js';
import { createGoogleBrokerHttpsServer } from './google-broker-https.js';

/** Start only in a separately supervised trusted process, with a broker-exclusive vault. */
export async function startGoogleCredentialBroker({ vault, tls, host = '127.0.0.1', port = 0,
  registry = new IntegrationConnectorRegistry(), fetchImpl = globalThis.fetch, clock } = {}) {
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('A_GOOGLE_BROKER_LISTEN_CONFIG_INVALID');
  }
  const broker = createGoogleOperationBroker({ vault, registry, fetchImpl, clock });
  const { server, revokeClient } = createGoogleBrokerHttpsServer({ broker, ...tls });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return Object.freeze({
    address: server.address(), revokeClient,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
