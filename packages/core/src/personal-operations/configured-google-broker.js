import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGoogleBrokerHttpsTransport } from './google-broker-https.js';
import { createGoogleBrokerReadClient } from './google-operation-broker.js';
import { GOOGLE_CONNECTOR_ID, GOOGLE_READ_SCOPES } from './google-vault-client.js';
import { readPrivateFile } from './private-file.js';

/** Explicit Core-side selection. This module never receives Google credentials or an OpenBao token. */
export function createConfiguredGoogleBroker({ env, clock = () => new Date(), onVerified = async () => {}, authorizePage = () => { throw new Error('A_GOOGLE_MANDATE_REQUIRED'); } } = {}) {
  const names = ['JARVIS_CORE_GOOGLE_BROKER_URL', 'JARVIS_CORE_GOOGLE_BROKER_TLS_KEY',
    'JARVIS_CORE_GOOGLE_BROKER_TLS_CERT', 'JARVIS_CORE_GOOGLE_BROKER_TLS_CA', 'JARVIS_CORE_GOOGLE_BROKER_METADATA'];
  if (names.some(name => typeof env?.[name] !== 'string' || !env[name])) throw new Error('A_GOOGLE_BROKER_CORE_CONFIG_INCOMPLETE');
  const metadata = () => {
    try {
      const path = resolve(env.JARVIS_CORE_GOOGLE_BROKER_METADATA), info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error();
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (Object.keys(data).sort().join(',') !== 'connectionId,revision,schemaVersion' || data.schemaVersion !== 1
        || typeof data.connectionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(data.connectionId)
        || typeof data.revision !== 'string' || !data.revision || data.revision.length > 100) throw new Error();
      return [{ connectionId: data.connectionId, updatedAt: data.revision, connectorId: GOOGLE_CONNECTOR_ID,
        authMethod: 'oauth2', scopes: [...GOOGLE_READ_SCOPES], status: 'credentials-stored-unverified' }];
    } catch { throw new Error('A_GOOGLE_BROKER_METADATA_INVALID'); }
  };
  metadata();
  let transport;
  try { transport = createGoogleBrokerHttpsTransport({ url: env.JARVIS_CORE_GOOGLE_BROKER_URL,
    key: readPrivateFile(env.JARVIS_CORE_GOOGLE_BROKER_TLS_KEY),
    cert: readFileSync(resolve(env.JARVIS_CORE_GOOGLE_BROKER_TLS_CERT)),
    ca: readFileSync(resolve(env.JARVIS_CORE_GOOGLE_BROKER_TLS_CA)) }); }
  catch { throw new Error('A_GOOGLE_BROKER_CORE_TLS_INVALID'); }
  const reader = createGoogleBrokerReadClient({ connectionMetadata: metadata, execute: transport.execute });
  let state = { status: 'verification-required', providerVerified: false }, closed = false, verifiedBinding = null;
  const binding = () => JSON.stringify(metadata().map(({ connectionId, updatedAt }) => [connectionId, updatedAt]));
  const status = () => {
    let current = state;
    if (closed) return { ...(state.status==='broker-access-revoked'?state:{status:'blocked',providerVerified:false,code:'A_GOOGLE_CONNECTION_CLOSED'}), credentialLocation: 'broker', connectionMode: 'broker-mtls' };
    try { if (state.providerVerified && binding() !== verifiedBinding) current = { status: 'verification-required', providerVerified: false }; }
    catch { current = { status: 'blocked', providerVerified: false, code: 'A_GOOGLE_BROKER_METADATA_INVALID' }; }
    return { ...current, credentialLocation: 'broker', connectionMode: 'broker-mtls' };
  };
  const verifyConnection = async () => {
    if (closed) throw new Error('A_GOOGLE_CONNECTION_CLOSED');
    state = { status: 'activating', providerVerified: false };
    try {
      const before = binding();
      const account = await reader.account();
      if (typeof account !== 'string' || !account.includes('@')) throw new Error('A_GOOGLE_ACCOUNT_INVALID');
      if (closed) throw new Error('A_GOOGLE_CONNECTION_CLOSED');
      if (binding() !== before) throw new Error('A_GOOGLE_BROKER_REVISION_CONFLICT');
      const checkedAt = clock().toISOString();
      verifiedBinding = before;
      state = { status: 'connected', providerVerified: true, checkedAt };
      return { verified: true, checkedAt, account };
    } catch (error) {
      state = { status: 'failed', providerVerified: false,
        code: /^A_GOOGLE_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'A_GOOGLE_BROKER_OPERATION_FAILED' };
      throw new Error(state.code);
    }
  };
  const client = Object.freeze({ ...reader, configured() { try { return !closed && reader.configured(); } catch { return false; } },
    async account() { return (await verifyConnection()).account; },
    authorizationBinding() { if(!status().providerVerified)throw new Error('A_GOOGLE_CONNECTION_REQUIRED');const row=metadata()[0]; return {connectionId:row.connectionId,revision:row.updatedAt}; },
    async page(job,{authorization}={}) {
      if (!status().providerVerified) throw new Error('A_GOOGLE_CONNECTION_REQUIRED');
      authorizePage(job,authorization);
      try {
        const before = binding(), result = await reader.page(job);
        if (closed || binding() !== before) throw new Error('A_GOOGLE_BROKER_REVISION_CONFLICT');
        return result;
      } catch (error) {
        state = { status: 'failed', providerVerified: false, code: /^A_GOOGLE_[A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'A_GOOGLE_BROKER_OPERATION_FAILED' };
        throw new Error(state.code);
      }
    },
    verifyConnection, close() { closed = true; transport.close(); } });
  const controller = Object.freeze({ status, setupStatus: () => ({ credentialLocation: 'broker', connectionMode: 'broker-mtls',
    productAuthorizationConfigured: false, brokerConfigured: client.configured(), readScopeRequired: true, interactiveSession: false,brokerDisconnectSupported:true }),
    async disconnect(){
      if(closed)throw Error('A_GOOGLE_CONNECTION_CLOSED');
      const receipt=await transport.execute({},{revokeSelf:true});
      if(!receipt||Object.keys(receipt).sort().join(',')!=='brokerAccessRevoked,credentialsDeleted,providerGrantRevoked'||receipt.brokerAccessRevoked!==true||receipt.credentialsDeleted!==false||receipt.providerGrantRevoked!==false)throw Error('A_GOOGLE_BROKER_RESPONSE_INVALID');
      state={status:'broker-access-revoked',brokerAccessRevoked:true,providerVerified:false};client.close();return receipt;
    },
    async start(input = {}) {
      if (Object.keys(input).some(key => !['profile', 'completionOrigin'].includes(key)) || input.profile !== 'product') {
        throw Object.assign(new Error('A_GOOGLE_PRODUCT_INPUT_INVALID'), { code: 'A_GOOGLE_PRODUCT_INPUT_INVALID' });
      }
      await verifyConnection(); await onVerified(); return status();
    },
    close: async () => { client.close(); }
  });
  return Object.freeze({ client, controller });
}
