import {isAbsolute,dirname,resolve} from 'node:path';
import {X509Certificate,createHash} from 'node:crypto';
import {readPrivateFile} from './private-file.js';

const exact=(object,keys)=>object&&Object.getPrototypeOf(object)===Object.prototype
  &&Object.keys(object).sort().join(',')===keys.slice().sort().join(',');
/** One operator-provisioned protected profile, separate projections for Core and broker.
 * Contains paths, never provider keys. Does not provision PKI or grant execution authority. */
export function resolveDuffelConnectionEnvironment({env={},role}={}){
  if(!['core','broker'].includes(role))throw new Error('A_DUFFEL_PROFILE_ROLE_INVALID');
  const path=env.JARVIS_DUFFEL_CONNECTION_PROFILE;
  if(!path)return {...env};
  let p,hash;
  try{
    if(typeof path!=='string'||!isAbsolute(path))throw new Error();
    const bytes=readPrivateFile(path,{maxBytes:8192});hash=createHash('sha256').update(bytes).digest('hex');p=JSON.parse(bytes.toString('utf8'));
    if(!exact(p,['schemaVersion','port','vault','metadata','revocations','serverTls','coreTls'])||p.schemaVersion!==1
      ||!Number.isInteger(p.port)||p.port<1024||p.port>65535
      ||!exact(p.serverTls,['key','cert','ca'])||!exact(p.coreTls,['key','cert','ca']))throw new Error();
    const paths=[p.vault,p.metadata,p.revocations,...Object.values(p.serverTls),...Object.values(p.coreTls)];
    if(paths.some(v=>typeof v!=='string'||!isAbsolute(v)))throw new Error();
    // Only the public CA may be shared between client/server; all other files have distinct roles.
    const distinct=[path,p.vault,p.metadata,p.revocations,p.serverTls.key,p.serverTls.cert,p.serverTls.ca,p.coreTls.key,p.coreTls.cert];
    if(new Set(distinct.map(v=>resolve(v).toLowerCase())).size!==distinct.length
      ||resolve(p.coreTls.ca).toLowerCase()!==resolve(p.serverTls.ca).toLowerCase()
      ||dirname(resolve(p.revocations)).toLowerCase()!==dirname(resolve(p.serverTls.key)).toLowerCase())throw new Error();
  }catch{throw new Error('A_DUFFEL_PROFILE_INVALID');}
  let projection;
  if(role==='core'){
    projection=Object.fromEntries(Object.entries({URL:`https://127.0.0.1:${p.port}/v1/duffel/quote`,TLS_KEY:p.coreTls.key,TLS_CERT:p.coreTls.cert,TLS_CA:p.coreTls.ca,METADATA:p.metadata})
      .map(([name,value])=>['JARVIS_CORE_DUFFEL_BROKER_'+name,value]));
  }else{
    let fingerprint;
    try{fingerprint=new X509Certificate(readPrivateFile(p.coreTls.cert)).fingerprint256;}catch{throw new Error('A_DUFFEL_PROFILE_CLIENT_CERT_INVALID');}
    projection=Object.fromEntries(Object.entries({PORT:String(p.port),TLS_KEY:p.serverTls.key,TLS_CERT:p.serverTls.cert,TLS_CA:p.serverTls.ca,
      VAULT:p.vault,METADATA:p.metadata,REVOCATIONS:p.revocations,CLIENT_FINGERPRINT:fingerprint})
      .map(([name,value])=>['JARVIS_DUFFEL_BROKER_'+name,value]));
  }
  projection.JARVIS_DUFFEL_CONNECTION_PROFILE_SHA256=hash;
  if(Object.entries(projection).some(([name,value])=>env[name]!==undefined&&env[name]!==value))throw new Error('A_DUFFEL_PROFILE_CONFIG_CONFLICT');
  // Strip opposite-role settings from the returned environment projection.
  const opposite=role==='core'?'JARVIS_DUFFEL_BROKER_':'JARVIS_CORE_DUFFEL_BROKER_';
  return {...Object.fromEntries(Object.entries(env).filter(([name])=>!name.startsWith(opposite))),...projection};
}

export function assertDuffelProfileUnchanged(env={}){
  if(!env.JARVIS_DUFFEL_CONNECTION_PROFILE)return;
  try{
    const bytes=readPrivateFile(env.JARVIS_DUFFEL_CONNECTION_PROFILE,{maxBytes:8192});
    if(createHash('sha256').update(bytes).digest('hex')!==env.JARVIS_DUFFEL_CONNECTION_PROFILE_SHA256)throw new Error();
  }catch{throw new Error('A_DUFFEL_PROFILE_CHANGED');}
}
