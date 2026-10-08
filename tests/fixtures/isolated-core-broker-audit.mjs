import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,chownSync,chmodSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork,execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
assert.equal(process.platform,'linux');assert.equal(process.geteuid(),0);
const root=mkdtempSync(join(tmpdir(),'jarvis-isolated-core-')),children=[],rows=[],startedAt=new Date().toISOString();chmodSync(root,0o711);
const coreFixture=new URL('./isolated-core-broker.mjs',import.meta.url);
function message(child,type,action){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>finish(Error('TEST_IPC_TIMEOUT')),15000);const onMessage=data=>{if(data.type===type)finish(null,data);};const onExit=()=>finish(Error('TEST_CHILD_EXIT'));function finish(error,data){clearTimeout(timer);child.off('message',onMessage);child.off('exit',onExit);error?reject(error):resolve(data);}child.on('message',onMessage);child.once('exit',onExit);if(action)child.send({action});});}
function launch(file,uid,env,args=[]){const child=fork(new URL(file,import.meta.url),args,{uid,gid:uid,env:{PATH:process.env.PATH,...env},stdio:['ignore','pipe','pipe','ipc']});let logs='';child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});children.push({child,logs:()=>logs});return child;}
async function stop(child){if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.disconnect();await exit;}}
try{
  const dirs={};for(const [role,uid] of [['broker',2000],['core',2001]]){
    const dir=join(root,role);mkdirSync(dir,{mode:0o700});
    const pem=readFileSync(new URL(`./google-broker-tls/${role==='broker'?'server':'core'}-key.pem`,import.meta.url));
    writeFileSync(join(dir,'key.pem'),pem,{mode:0o600});chownSync(join(dir,'key.pem'),uid,uid);
    if(role==='core'){writeFileSync(join(dir,'metadata.json'),JSON.stringify({schemaVersion:1,connectionId:'process-google',revision:'process-revision-one'}),{mode:0o600});chownSync(join(dir,'metadata.json'),uid,uid);}
    chownSync(dir,uid,uid);dirs[role]=dir;
  }
  const broker=launch('./google-broker-process.mjs',2000,{SYNTHETIC_BROKER_PRIVATE_KEY:join(dirs.broker,'key.pem')},[join(dirs.broker,'revocations.sqlite')]);
  const b=await message(broker,'ready');assert.equal(b.uid,2000);
  const cert=name=>new URL(`./google-broker-tls/${name}.pem`,import.meta.url).pathname;
  const core=launch(coreFixture,2001,{TEMP:dirs.core,TMP:dirs.core,JARVIS_TEST_MODE:'1',JARVIS_TEST_AUDIT_ROOT:join(dirs.core,'audit'),JARVIS_CORE_ROOT:dirs.core,
    JARVIS_CORE_HOST:'127.0.0.1',JARVIS_CORE_PORT:'0',JARVIS_CORE_ADMIN_TOKEN:'synthetic-role-admin',JARVIS_CORE_ALLOWED_ROOTS:'workspace',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_MISSION_PROVIDER:'xai',JARVIS_MISSION_MODEL:'synthetic',JARVIS_CORE_GOOGLE_BACKEND:'broker',JARVIS_CORE_GOOGLE_BROKER_URL:`https://127.0.0.1:${b.address.port}/v1/google/read`,JARVIS_CORE_GOOGLE_BROKER_TLS_KEY:join(dirs.core,'key.pem'),JARVIS_CORE_GOOGLE_BROKER_TLS_CERT:cert('core'),JARVIS_CORE_GOOGLE_BROKER_TLS_CA:cert('ca'),JARVIS_CORE_GOOGLE_BROKER_METADATA:join(dirs.core,'metadata.json')});
  const c=await message(core,'ready');assert.equal(c.uid,2001);assert.notEqual(c.pid,b.pid);
  const base=`http://127.0.0.1:${c.address.port}`,headers={authorization:'Bearer synthetic-role-admin','content-type':'application/json'};
  const post=async(path,body={})=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,path.endsWith('/connect')?202:200);return r.json();};
  assert.equal((await post('/personal-google/connect',{profile:'product'})).providerVerified,true);rows.push({id:'mtls-separate-uids',passed:true});
  const blocked=await post('/personal-google/sync');assert.equal(blocked.status,'degraded');assert.equal((await message(broker,'stats','stats')).credentialReads,2);rows.push({id:'missing-mandates-no-source-page',passed:true});
  for(const provider of ['gmail','google-calendar'])await post('/personal-google/mandate',{provider,maxPages:10,validFrom:'2020-01-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',readFrom:'2020-01-01T00:00:00Z',readUntil:'2099-01-01T00:00:00Z'});
  assert.equal((await post('/personal-google/sync')).status,'ready');assert.equal((await post('/personal-google/sync')).status,'ready');
  const inbox=await(await fetch(base+'/personal-inbox',{headers})).json();assert.equal(inbox.items.length,2);assert.equal(inbox.google.evidence.every(x=>x.committedPages===2),true);rows.push({id:'scoped-inbox-repeat-no-duplicate',passed:true});
  const paths={broker:join(dirs.broker,'key.pem'),core:join(dirs.core,'key.pem')};
  for(const [role,uid] of [['core',2001],['worker',2002]]){const probe=JSON.parse(execFileSync(process.execPath,[new URL('./private-file-roles.mjs',import.meta.url).pathname,'probe',JSON.stringify(paths)],{uid,gid:uid,env:{PATH:process.env.PATH},encoding:'utf8',timeout:10000}));assert.equal(probe.results[0].rawReadable,false);if(role==='worker')assert.equal(probe.results[1].rawReadable,false);rows.push({id:`${role}-private-access-denied`,passed:true});}
  await message(broker,'revoked-client','revoke-client');assert.equal((await post('/personal-google/sync')).status,'error');rows.push({id:'certificate-revocation-stops-sync',passed:true});
  await stop(core);await stop(broker);
  for(const row of children)assert.doesNotMatch(row.logs(),/process-synthetic-(?:secret|refresh|access)/u);
  process.stdout.write(JSON.stringify({schemaVersion:1,status:'passed',startedAt,observedAt:new Date().toISOString(),syntheticOnly:true,productionActivation:false,brokerUid:b.uid,coreUid:c.uid,rows})+'\n');
}catch(error){
  for(const row of children)process.stderr.write(row.logs().replace(/process-synthetic-[A-Za-z0-9-]+|synthetic-role-admin/gu,'[synthetic-redacted]').slice(0,3000));
  throw error;
}finally{
  for(const {child} of children)await stop(child);
  for(const role of ['broker','core']){const dir=join(root,role);if(existsSync(dir)){chownSync(dir,0,0);chmodSync(dir,0o700);}}
  // Nested Core directories are owner-private; discard the container tmpfs at --rm instead of broad privileged traversal.
}
