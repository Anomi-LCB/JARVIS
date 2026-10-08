import {readFileSync,lstatSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {DuffelLocalAccessStore} from './duffel-local-access-store.js';
import {readPrivateFile} from './private-file.js';
import {createDuffelBrokerHttpsTransport} from './duffel-broker-https.js';
import {createDuffelBrokerQuoteClient,DUFFEL_CONNECTOR_ID,DUFFEL_READ_SCOPE,DUFFEL_READ_CAPABILITY} from './duffel-quote-broker.js';
import {resolveDuffelConnectionEnvironment,assertDuffelProfileUnchanged} from './duffel-connection-profile.js';

// Explicit service configuration only. Provider keys never enter this process.
export function createConfiguredDuffelBroker({env={},clock=()=>new Date()}={}) {
  env=resolveDuffelConnectionEnvironment({env,role:'core'});
  const prefix='JARVIS_CORE_DUFFEL_BROKER_';
  const names=['URL','TLS_KEY','TLS_CERT','TLS_CA','METADATA'];
  if(names.every(name=>!env[prefix+name]))return null;
  if(names.some(name=>typeof env[prefix+name]!=='string'||!env[prefix+name]))throw new Error('A_DUFFEL_BROKER_CORE_CONFIG_INCOMPLETE');
  const metadata=()=>{
    assertDuffelProfileUnchanged(env);
    try {
      const path=resolve(env[prefix+'METADATA']),stat=lstatSync(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8192)throw new Error();
      const data=JSON.parse(readFileSync(path,'utf8'));
      if(Object.keys(data).sort().join(',')!=='connectionId,revision,schemaVersion'||data.schemaVersion!==1
        ||typeof data.connectionId!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(data.connectionId))
        ||typeof data.revision!=='string'||!data.revision||data.revision.length>100)throw new Error();
      return [{connectionId:data.connectionId,updatedAt:data.revision,connectorId:DUFFEL_CONNECTOR_ID,
        authMethod:'api-key',scopes:[DUFFEL_READ_SCOPE],grants:[DUFFEL_READ_CAPABILITY],status:'credentials-stored-unverified'}];
    }catch{throw new Error('A_DUFFEL_BROKER_METADATA_INVALID');}
  };
  metadata();
  let transport,fingerprint;
  try{transport=createDuffelBrokerHttpsTransport({url:env[prefix+'URL'],key:readPrivateFile(env[prefix+'TLS_KEY']),
    cert:readFileSync(resolve(env[prefix+'TLS_CERT'])),ca:readFileSync(resolve(env[prefix+'TLS_CA']))});
    fingerprint=new X509Certificate(readFileSync(resolve(env[prefix+'TLS_CERT']))).fingerprint256;}
  catch{throw new Error('A_DUFFEL_BROKER_CORE_TLS_INVALID');}
  let accessStore;
  // The private key's parent was checked by readPrivateFile. Public metadata
  // replacement or movement must not silently remove an existing hold.
  try{accessStore=new DuffelLocalAccessStore(join(dirname(resolve(env[prefix+'TLS_KEY'])),'duffel-local-access.sqlite'));}
  catch(error){transport.close();throw error;}
  const reader=createDuffelBrokerQuoteClient({connectionMetadata:metadata,execute:transport.execute});
  let closed=false,brokerAccessRevoked=false,disposed=false,holdState=null;
  const held=()=>{holdState=accessStore.state(fingerprint);brokerAccessRevoked=holdState==='confirmed';return holdState!==null;};
  return Object.freeze({
    status(){
      try{const paused=disposed?holdState!==null:held(),readiness=reader.readiness();return {...readiness,credentialsConfigured:!paused&&!closed&&readiness.credentialsConfigured===true,
        ...(paused?{localPausePersisted:true}:{}),
        reason:brokerAccessRevoked?'broker-access-revoked':paused||closed?'connection-closed':readiness.reason,connectionMode:'broker-mtls',brokerAccessRevoked,brokerDisconnectSupported:true};}
      catch(error){return {ready:false,credentialsConfigured:false,providerVerified:false,bookingAvailable:false,reason:error.message==='A_DUFFEL_LOCAL_ACCESS_STORE_UNAVAILABLE'?'local-access-store-unavailable':'metadata-invalid',connectionMode:'broker-mtls'};}
    },
    async offer(id){
      if(closed||held())throw new Error('A_DUFFEL_CONNECTION_CLOSED');
      const before=JSON.stringify(metadata()),result=await reader.offer(id);
      if(closed||held()||JSON.stringify(metadata())!==before)throw new Error('A_DUFFEL_REVISION_CONFLICT');
      const now=clock().getTime();
      if(!Number.isFinite(now))throw new Error('A_DUFFEL_CLOCK_INVALID');
      if(!Number.isFinite(Date.parse(result?.expiresAt)))throw new Error('A_DUFFEL_RESPONSE_INVALID');
      if(Date.parse(result.expiresAt)<=now)throw new Error('A_DUFFEL_OFFER_EXPIRED');
      return result;
    },
    async disconnect(){
      if(closed||held())throw new Error('A_DUFFEL_CONNECTION_CLOSED');
      closed=true;
      try{
        accessStore.hold(fingerprint);
        holdState='pending';
        const receipt=await transport.execute({},{revokeSelf:true});
        if(!receipt||Object.keys(receipt).sort().join(',')!=='brokerAccessRevoked,credentialsDeleted,providerGrantRevoked'||receipt.brokerAccessRevoked!==true||receipt.credentialsDeleted!==false||receipt.providerGrantRevoked!==false)throw new Error('A_DUFFEL_RESPONSE_INVALID');
        accessStore.confirm(fingerprint);holdState='confirmed';brokerAccessRevoked=true;return {...receipt,localReadsPaused:true};
      }finally{transport.close();}
    },
    close(){closed=true;transport.close();if(!disposed){accessStore.close();disposed=true;}}
  });
}
