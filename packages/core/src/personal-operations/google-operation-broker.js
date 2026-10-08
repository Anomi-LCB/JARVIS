import { GoogleReadClient } from './google-client.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES, registerGoogleWorkspaceConnector } from './google-vault-client.js';
import {snapshotGooglePageJob,googlePageWireJob} from './google-page-contract.js';

const unavailable = new Set(['expired', 'revoked', 'removed', 'disconnected', 'reauth-required']);
const safeErrors = /^A_GOOGLE_(?:TOKEN_NETWORK|TOKEN_INVALID|TOKEN_HTTP_\d{3}|REAUTH_REQUIRED|API_NETWORK|API_HTTP_\d{3}|RESPONSE_INVALID|ACCOUNT_INVALID|ACCOUNT_MISMATCH|PAGE_INVALID|MESSAGE_INVALID)$/u;
const brokerErrors = new Set(['A_GOOGLE_BROKER_CONNECTION_REQUIRED', 'A_GOOGLE_BROKER_REVISION_CONFLICT', 'A_GOOGLE_BROKER_RESPONSE_DENIED',
  'A_GOOGLE_BROKER_SECRET_STORE_AUTH_DENIED', 'A_GOOGLE_BROKER_SECRET_STORE_UNAVAILABLE', 'A_GOOGLE_BROKER_SECRET_STORE_RESPONSE_INVALID']);
const fail = code => { throw new Error(code); };
function objectWithKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key==='string'&&keys.includes(key)
      && Object.getOwnPropertyDescriptor(value,key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'));
}
function validateRequest(request) {
  if (!objectWithKeys(request, ['connectionId', 'expectedRevision', 'operation', 'job'])
    || typeof request.connectionId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/u.test(request.connectionId)
    || typeof request.expectedRevision !== 'string' || request.expectedRevision.length > 100
    || !['account', 'page'].includes(request.operation)) fail('A_GOOGLE_BROKER_REQUEST_INVALID');
  if (request.operation === 'account') {
    if (Object.hasOwn(request, 'job')) fail('A_GOOGLE_BROKER_REQUEST_INVALID');
    return;
  }
  try{snapshotGooglePageJob(request.job,{workerMetadata:false});}catch{fail('A_GOOGLE_BROKER_REQUEST_INVALID');}
}

/** Trusted broker-side operation boundary. No URL, code, headers or secret-read operation is accepted.
 * Deploy in a separate authenticated process before claiming isolation from Core. */
export function createGoogleOperationBroker({ registry, vault, fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  if (!registry?.get || !vault?.list || !vault?.withCredentials) throw new TypeError('A trusted registry and vault are required.');
  registerGoogleWorkspaceConnector(registry);
  const connection = request => {
    const row = vault.list().find(item => item.connectionId === request.connectionId);
    const scope = request.operation === 'page' && request.job.provider === 'google-calendar' ? GOOGLE_READ_SCOPES[1] : GOOGLE_READ_SCOPES[0];
    if (!row || row.connectorId !== GOOGLE_CONNECTOR_ID || row.authMethod !== 'oauth2'
      || unavailable.has(row.status) || !row.scopes?.includes(scope)
      || (request.job?.account !== undefined && !row.scopes?.includes(GOOGLE_READ_SCOPES[0]))) fail('A_GOOGLE_BROKER_CONNECTION_REQUIRED');
    if (row.updatedAt !== request.expectedRevision) fail('A_GOOGLE_BROKER_REVISION_CONFLICT');
    return { row, scope };
  };
  return Object.freeze({
    async execute(input, { signal = null } = {}) {
      validateRequest(input);
      signal?.throwIfAborted();
      // Snapshot validated input before any asynchronous work; callers cannot change its target later.
      const request = structuredClone(input);
      const { scope } = connection(request);
      try {
        const result = await vault.withCredentials(request.connectionId, async (credentials, metadata) => {
          signal?.throwIfAborted();
          if (metadata.connectionId !== request.connectionId || metadata.updatedAt !== request.expectedRevision
            || metadata.connectorId !== GOOGLE_CONNECTOR_ID || metadata.authMethod !== 'oauth2'
            || !metadata.scopes?.includes(scope)) fail('A_GOOGLE_BROKER_REVISION_CONFLICT');
          const client = new GoogleReadClient({ credentials, fetchImpl, clock: () => clock().getTime(), signal });
          const output = request.operation === 'account' ? await client.account() : await client.page(request.job);
          signal?.throwIfAborted();
          // Do not return credential echoes from a compromised/misconfigured upstream response.
          const serialized = JSON.stringify(output);
          if ([...Object.values(credentials), client.token].some(secret => typeof secret === 'string'
            && secret.length >= 8 && serialized.includes(secret))) fail('A_GOOGLE_BROKER_RESPONSE_DENIED');
          return output;
        });
        connection(request); // revocation/revision changes during the call suppress its result
        return result;
      } catch (error) {
        if (safeErrors.test(error?.message ?? '') || brokerErrors.has(error?.message)) throw new Error(error.message);
        fail('A_GOOGLE_BROKER_OPERATION_FAILED'); // never return provider/vault error text
      }
    }
  });
}

/** Core-side facade: receives redacted metadata and an operation transport, never a vault or token. */
export function createGoogleBrokerReadClient({ connectionMetadata, execute } = {}) {
  if (typeof connectionMetadata !== 'function' || typeof execute !== 'function') throw new TypeError('Broker transport and metadata accessor are required.');
  const find = () => {
    const rows = connectionMetadata().filter(row => row.connectorId === GOOGLE_CONNECTOR_ID && row.authMethod === 'oauth2'
      && !unavailable.has(row.status) && GOOGLE_READ_SCOPES.every(scope => row.scopes?.includes(scope)));
    return rows.length === 1 ? rows[0] : null;
  };
  const call = (operation, job) => {
    const row = find();
    if (!row) return Promise.reject(new Error('A_GOOGLE_CONNECTION_REQUIRED'));
    let wireJob;if(operation==='page'){
      try{wireJob=googlePageWireJob(job);}catch{return Promise.reject(new Error('A_GOOGLE_BROKER_REQUEST_INVALID'));}
    }
    return execute({ connectionId: row.connectionId, expectedRevision: row.updatedAt, operation,
      ...(operation === 'page' ? { job:wireJob } : {}) });
  };
  return Object.freeze({
    configured: () => Boolean(find()),
    connectionRequirements: () => ({ connectorId: GOOGLE_CONNECTOR_ID, requiredScopes: [...GOOGLE_READ_SCOPES], remoteGrantRevocationConfirmed: false }),
    account: () => call('account'),
    page: job => call('page', job),
    close() {}
  });
}
