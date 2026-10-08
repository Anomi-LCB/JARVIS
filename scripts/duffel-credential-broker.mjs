import {resolve,isAbsolute,dirname} from 'node:path';
import {existsSync,lstatSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {IntegrationCredentialVault} from '../packages/core/src/personal-operations/integration-security.js';
import {startDuffelCredentialBroker} from '../packages/core/src/personal-operations/duffel-broker-host.js';
import {BrokerRevocationStore} from '../packages/core/src/personal-operations/broker-revocation-store.js';
import {readPrivateFile} from '../packages/core/src/personal-operations/private-file.js';
import {DUFFEL_CONNECTOR_ID} from '../packages/core/src/personal-operations/duffel-quote-broker.js';
import {resolveDuffelConnectionEnvironment,assertDuffelProfileUnchanged} from '../packages/core/src/personal-operations/duffel-connection-profile.js';

/** Trusted separate-process startup. No provider key in env, test TLS bypass or automatic activation. */
export async function runConfiguredDuffelCredentialBroker({env=process.env}={}){
  if(process.platform!=='win32')throw new Error('A_DUFFEL_BROKER_WINDOWS_SECRET_STORE_REQUIRED');
  env=resolveDuffelConnectionEnvironment({env,role:'broker'});
  const files=['TLS_KEY','TLS_CERT','TLS_CA','VAULT','METADATA','REVOCATIONS'];
  const names=files.map(n=>'JARVIS_DUFFEL_BROKER_'+n);
  if(names.some(n=>typeof env[n]!=='string'||!isAbsolute(env[n]))
    ||!/^\d{4,5}$/u.test(env.JARVIS_DUFFEL_BROKER_PORT??'')
    ||!/^(?:[A-Fa-f0-9]{64}|(?:[A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2})$/u.test(env.JARVIS_DUFFEL_BROKER_CLIENT_FINGERPRINT??''))
    throw new Error('A_DUFFEL_BROKER_CONFIG_INCOMPLETE');
  const paths=Object.fromEntries(files.map((n,i)=>[n,resolve(env[names[i]])]));
  if(new Set(Object.values(paths).map(p=>p.toLowerCase())).size!==files.length)
    throw new Error('A_DUFFEL_BROKER_PATHS_INVALID');
  const port=Number(env.JARVIS_DUFFEL_BROKER_PORT);
  if(port<1024||port>65535)throw new Error('A_DUFFEL_BROKER_LISTEN_CONFIG_INVALID');
  let key,cert,ca,metadata;
  try{
    key=readPrivateFile(paths.TLS_KEY);cert=readPrivateFile(paths.TLS_CERT);ca=readPrivateFile(paths.TLS_CA);
    const certificate=new X509Certificate(cert),authority=new X509Certificate(ca),now=Date.now();
    if([certificate,authority].some(c=>/TEST ONLY/iu.test(c.subject)))throw new Error('A_DUFFEL_BROKER_TEST_CERT_DENIED');
    if(!authority.ca||certificate.ca||!certificate.verify(authority.publicKey)||!certificate.checkPrivateKey(createPrivateKey(key))
      ||[certificate,authority].some(c=>!(Date.parse(c.validFrom)<=now&&Date.parse(c.validTo)>now)))throw new Error();
    // New SQLite sidecars inherit the already checked key directory's private ACL.
    if(dirname(paths.REVOCATIONS)!==dirname(paths.TLS_KEY))throw new Error();
    if(existsSync(paths.REVOCATIONS))readPrivateFile(paths.REVOCATIONS,{maxBytes:1048576});
    for(const suffix of ['-wal','-shm'])if(existsSync(paths.REVOCATIONS+suffix)){
      const info=lstatSync(paths.REVOCATIONS+suffix);
      if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error();
      readPrivateFile(paths.REVOCATIONS+suffix,{maxBytes:1048576,allowEmpty:true});
    }
    readPrivateFile(paths.VAULT,{maxBytes:1048576});
    metadata=JSON.parse(readPrivateFile(paths.METADATA,{maxBytes:4096}).toString('utf8'));
    if(Object.keys(metadata).sort().join(',')!=='connectionId,revision,schemaVersion'||metadata.schemaVersion!==1
      ||typeof metadata.connectionId!=='string'||!/^[a-zA-Z0-9._-]{1,128}$/u.test(metadata.connectionId)
      ||typeof metadata.revision!=='string'||!metadata.revision)throw new Error();
  }catch(error){throw new Error(error?.message==='A_DUFFEL_BROKER_TEST_CERT_DENIED'?error.message:'A_DUFFEL_BROKER_FILES_INVALID');}
  const vault=new IntegrationCredentialVault({path:paths.VAULT,storageLocation:'explicit-duffel-broker-exclusive-vault'});
  const rows=vault.list();
  if(!rows.some(r=>r.connectionId===metadata.connectionId&&r.connectorId===DUFFEL_CONNECTOR_ID&&r.updatedAt===metadata.revision))
    throw new Error('A_DUFFEL_BROKER_CONNECTION_METADATA_INVALID');
  const peer=env.JARVIS_DUFFEL_BROKER_CLIENT_FINGERPRINT.replaceAll(':','').toUpperCase();
  const guardedVault={list(){assertDuffelProfileUnchanged(env);return vault.list();},
    withCredentials(id,operation){assertDuffelProfileUnchanged(env);return vault.withCredentials(id,async(...args)=>{
      assertDuffelProfileUnchanged(env);const result=await operation(...args);assertDuffelProfileUnchanged(env);return result;
    });}};
  const revocationStore=new BrokerRevocationStore({path:paths.REVOCATIONS});
  let host;
  try{host=await startDuffelCredentialBroker({vault:guardedVault,port,tls:{key,cert,ca,revocationStore,
    allowedClientFingerprints:[peer],clientConnectionScopes:{[peer]:[metadata.connectionId]}}});}
  catch{revocationStore.close();throw new Error('A_DUFFEL_BROKER_START_FAILED');}
  let closing;
  return Object.freeze({...host,close(){return closing??=host.close().finally(()=>revocationStore.close());}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const host=await runConfiguredDuffelCredentialBroker();
    const ready={status:'listening',host:host.address.address,port:host.address.port,transport:'mtls',providerVerified:false,bookingAvailable:false};
    console.log(JSON.stringify(ready));
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;await host.close();process.exit(0);};
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
    if(process.send){
      process.on('message',message=>{if(message?.type==='duffel-stop')void stop();});
      process.once('disconnect',stop);
      process.send({type:'duffel-ready',pid:process.pid,...ready});
    }
  }catch(error){console.error(/^A_DUFFEL_BROKER_[A-Z_]+$/u.test(error?.message??'')?error.message:'A_DUFFEL_BROKER_START_FAILED');process.exitCode=1;}
}
