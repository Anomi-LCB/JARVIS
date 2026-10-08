import { GoogleReadClient } from './google-client.js';
import { createHash } from 'node:crypto';
import {snapshotGooglePageJob} from './google-page-contract.js';
import {snapshotGoogleCollectionPage} from './google-collection-page.js';

const credentialFields = ['clientId', 'clientSecret', 'refreshToken'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const GOOGLE_CONNECTOR_ID = 'jarvis-google-workspace';
export const GOOGLE_READ_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly'
]);

/** Register the fixed, read-only Google Workspace contract used by OAuth handoff and sync. */
export function registerGoogleWorkspaceConnector(registry) {
  if (!registry?.register || !registry?.get) throw new TypeError('A trusted integration connector registry is required.');
  if (!registry.get(GOOGLE_CONNECTOR_ID)) registry.register({
    id: GOOGLE_CONNECTOR_ID,
    displayName: 'Google Workspace 읽기',
    category: 'personal-operations',
    authMethods: ['oauth2'],
    scopes: [...GOOGLE_READ_SCOPES],
    credentialFields: ['clientId', 'clientSecret', 'refreshToken'],
    requiredCredentialFields: ['clientId', 'clientSecret', 'refreshToken'],
    capabilities: [
      { id: 'gmail-read', riskTier: 'read', scopes: [GOOGLE_READ_SCOPES[0]] },
      { id: 'calendar-read', riskTier: 'read', scopes: [GOOGLE_READ_SCOPES[1]] }
    ]
  });
  return registry;
}

/**
 * A read-only client facade backed exclusively by the service's integration vault. Secrets are
 * only materialized inside the trusted Core process; callers receive no credential accessor.
 */
export function createGoogleVaultReadClient({ registry, vault, fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  if (!registry?.get || !vault?.list || !vault?.withCredentials) throw new TypeError('Google vault client requires a registry and credential vault.');
  registerGoogleWorkspaceConnector(registry);
  let cached = null, closed = false, credentialGeneration = 0;

  const findConnection = () => {
    if (closed) return null;
    const matches = vault.list().filter(item => item.connectorId === GOOGLE_CONNECTOR_ID
      && item.authMethod === 'oauth2'
      && !['expired', 'revoked', 'removed', 'disconnected', 'reauth-required'].includes(item.status)
      && GOOGLE_READ_SCOPES.every(scope => item.scopes.includes(scope)));
    return matches.length === 1 ? matches[0] : null;
  };
  const resolveClient = async () => {
    if (closed) throw new Error('A_GOOGLE_CONNECTION_CLOSED');
    const generation = credentialGeneration;
    const connection = findConnection();
    if (!connection) throw new Error('A_GOOGLE_CONNECTION_REQUIRED');
    const connectionHash = digest(connection);
    const credentialRevision = typeof vault.credentialRevision === 'function' ? vault.credentialRevision(connection.connectionId) : null;
    const credentials = await vault.withCredentials(connection.connectionId, (credentials, metadata) => {
        if (metadata.connectorId !== GOOGLE_CONNECTOR_ID || metadata.authMethod !== 'oauth2'
          || !GOOGLE_READ_SCOPES.every(scope => metadata.scopes.includes(scope))
          || !['clientId', 'clientSecret', 'refreshToken'].every(key => typeof credentials[key] === 'string' && credentials[key])) {
          throw new Error('A_GOOGLE_CONNECTION_INVALID');
        }
        return Object.freeze(Object.fromEntries(credentialFields.map(key => [key, credentials[key]])));
      });
    const credentialHash = digest(credentials);
    const assertCurrent = async () => {
      if (closed) throw new Error('A_GOOGLE_CONNECTION_CLOSED');
      if (generation !== credentialGeneration) throw new Error('A_GOOGLE_CONNECTION_CHANGED');
      const current = findConnection();
      if (!current || digest(current) !== connectionHash) throw new Error('A_GOOGLE_CONNECTION_CHANGED');
      // The production vault revision covers the entire encrypted record and rechecks file bytes.
      // Test/custom vaults without that contract retain the original scoped credential check.
      const currentHash = credentialRevision === null
        ? await vault.withCredentials(connection.connectionId, values => digest(Object.fromEntries(credentialFields.map(key => [key, values[key]]))))
        : vault.credentialRevision(connection.connectionId);
      if (closed) throw new Error('A_GOOGLE_CONNECTION_CLOSED');
      if (generation !== credentialGeneration || currentHash !== (credentialRevision ?? credentialHash) || digest(findConnection()) !== connectionHash) throw new Error('A_GOOGLE_CONNECTION_CHANGED');
    };
    await assertCurrent();
    const bindingHash = digest([connectionHash, credentialHash]);
    if (!cached || cached.bindingHash !== bindingHash) {
      const guardedFetch = async (url, options) => {
        await assertCurrent();
        const response = await fetchImpl(url, options);
        await assertCurrent();
        return response;
      };
      cached = { bindingHash, client: new GoogleReadClient({ credentials, fetchImpl: guardedFetch, clock: () => clock().getTime() }) };
    }
    const client = cached.client;
    const run = async operation => {
      let result;
      try { result = await operation(client); }
      catch (error) { await assertCurrent(); throw error; }
      await assertCurrent(); return result;
    };
    return { connection, run };
  };

  return Object.freeze({
    configured() { return Boolean(findConnection()); },
    connectionRequirements() { return { connectorId: GOOGLE_CONNECTOR_ID, requiredScopes: [...GOOGLE_READ_SCOPES],
      remoteGrantRevocationConfirmed: false }; },
    async account() { const { run } = await resolveClient(); return run(client => client.account()); },
    authorizationBinding(){
      const connection=findConnection();
      if(!connection||connection.providerVerification?.status!=='verified'||connection.providerVerification.providerVerified!==true||typeof vault.credentialRevision!=='function')throw Error('A_GOOGLE_CONNECTION_REQUIRED');
      return {connectionId:connection.connectionId,revision:vault.credentialRevision(connection.connectionId)};
    },
    async collectionPage(job,{authorize}={}){
      job=snapshotGoogleCollectionPage(job);
      if(typeof authorize!=='function'||authorize()!==true)throw Error('A_GOOGLE_COLLECTION_AUTHORIZATION_REQUIRED');
      const {run}=await resolveClient();if(authorize()!==true)throw Error('A_GOOGLE_COLLECTION_SCOPE_DENIED');
      return run(client=>client.collectionPage(job,{authorize}));
    },
    async page(job) {
      job = snapshotGooglePageJob(job);
      if (!['gmail', 'google-calendar'].includes(job?.provider)) throw new Error('A_GOOGLE_PROVIDER_INVALID');
      const { run } = await resolveClient();
      return run(client => client.page(job));
    },
    async verifyConnection() {
      const { connection, run } = await resolveClient();
      const account = await run(client => client.account());
      if (!account.includes('@')) throw new Error('A_GOOGLE_ACCOUNT_INVALID');
      if (typeof vault.recordProviderVerification === 'function') {
        vault.recordProviderVerification(connection.connectionId, {
          status: 'verified', providerVerified: true, checkedAt: clock().toISOString(), modelCount: 0
        }, { expectedUpdatedAt: connection.updatedAt });
        cached = null;
      }
      return { verified: true, checkedAt: clock().toISOString() };
    },
    invalidate() { credentialGeneration++; cached = null; },
    close() { closed = true; credentialGeneration++; cached = null; }
  });
}
