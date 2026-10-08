import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,appendFile} from 'node:fs/promises';
import {join,dirname,resolve,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {DeviceRegistry,DeviceTokenService} from '../apps/bridge/src/bridge-runtime.js';
import {createConfiguredCoreServiceRuntime} from '../scripts/core-service-runtime.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
const oldSecret='synthetic-old-device-secret-at-least-32',newSecret='synthetic-new-device-secret-at-least-32';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'jarvis-pairing-migration-'));t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(basename(root).startsWith('jarvis-pairing-migration-'));await rm(root,{recursive:true,force:true});});return root;}
function register(journalPath){const tokens=new DeviceTokenService({secret:oldSecret}),registry=new DeviceRegistry({tokenService:tokens,journalPath}),issued=tokens.issue({deviceId:'synthetic-mobile',deviceName:'synthetic'});registry.register({deviceId:'synthetic-mobile',deviceName:'synthetic',tokenHash:issued.tokenHash,expiresAt:issued.expiresAt,issuedAt:issued.issuedAt,tokenId:issued.tokenId,tokenVersion:issued.tokenVersion,tokenAlgorithm:issued.algorithm,tokenScope:issued.scope});return issued;}
test('migration key mismatch refuses startup without rewriting active pairing history',async t=>{
 const root=await fixture(t),journalPath=join(root,'devices.jsonl');register(journalPath);const before=await readFile(journalPath);
 assert.throws(()=>new DeviceRegistry({journalPath,tokenService:new DeviceTokenService({secret:newSecret}),keyChangePolicy:'reject'}),/D_DEVICE_MIGRATION_KEY_MISMATCH/);
 assert.deepEqual(await readFile(journalPath),before);
});
test('migration refuses corrupted pairing journal without rewriting it',async t=>{
 const root=await fixture(t),journalPath=join(root,'devices.jsonl');register(journalPath);await appendFile(journalPath,'{broken\n');const before=await readFile(journalPath);
 assert.throws(()=>new DeviceRegistry({journalPath,tokenService:new DeviceTokenService({secret:oldSecret}),keyChangePolicy:'reject'}),/D_DEVICE_MIGRATION_JOURNAL_INVALID/);
 assert.deepEqual(await readFile(journalPath),before);
});
test('migration cannot silently select an unknown key policy',()=>{
 assert.throws(()=>new DeviceRegistry({keyChangePolicy:'accept-any-key'}),/D_DEVICE_KEY_CHANGE_POLICY_INVALID/);
});
test('migration refuses a foreign journal record without hiding it as an empty registry',async t=>{
 const root=await fixture(t),journalPath=join(root,'devices.jsonl');register(journalPath);
 await appendFile(journalPath,JSON.stringify({schemaVersion:'foreign-format',device:{deviceId:'foreign'}})+'\n');const before=await readFile(journalPath);
 assert.throws(()=>new DeviceRegistry({journalPath,tokenService:new DeviceTokenService({secret:oldSecret}),keyChangePolicy:'reject'}),/D_DEVICE_MIGRATION_JOURNAL_INVALID/);
 assert.deepEqual(await readFile(journalPath),before);
});
test('migration preserves a revoked device without restoring its authority under another key',async t=>{
 const root=await fixture(t),journalPath=join(root,'devices.jsonl'),issued=register(journalPath);
 const old=new DeviceRegistry({journalPath,tokenService:new DeviceTokenService({secret:oldSecret})});old.revoke('synthetic-mobile','synthetic');
 const before=await readFile(journalPath),current=new DeviceRegistry({journalPath,tokenService:new DeviceTokenService({secret:newSecret}),keyChangePolicy:'reject'});
 assert.equal(current.devices.get('synthetic-mobile').status,'revoked');assert.equal(current.authenticateToken(issued.deviceToken).success,false);
 assert.deepEqual(await readFile(journalPath),before);
});
for(const mismatch of [true,false])test('configured Core migration preserves original key contract '+(mismatch?'mismatch':'matching'),async t=>{
 const root=await fixture(t),state=join(root,'pairing'),journalPath=join(state,'bridge-devices.jsonl');
 const {mkdir}=await import('node:fs/promises');await mkdir(state);const issued=register(journalPath),before=await readFile(journalPath);let runtime;
 const env={JARVIS_TEST_MODE:'1',JARVIS_CORE_ROOT:root,JARVIS_CORE_AUDIT_ROOT:join(root,'audit'),JARVIS_CORE_ALLOWED_ROOTS:root,JARVIS_CORE_ADMIN_TOKEN:'synthetic-migration-admin',JARVIS_CORE_WORKER_DAEMON_ENABLED:'0',JARVIS_CORE_WORKER_DAEMON_AUTOSTART:'0',JARVIS_PERSONAL_IMPORT_ENABLED:'0',JARVIS_GOOGLE_SYNC_ENABLED:'0',JARVIS_LLM_INTENT:'0',JARVIS_LLM_PLANNER:'0',JARVIS_LLM_CONTENT:'0',JARVIS_CORE_MOBILE_GATEWAY_ENABLED:'1',JARVIS_DEVICE_TOKEN_SECRET:mismatch?newSecret:oldSecret,JARVIS_BRIDGE_STATE_DIR:state};
 try{
  if(mismatch){await assert.rejects(async()=>{runtime=await createConfiguredCoreServiceRuntime({env});},/D_DEVICE_MIGRATION_KEY_MISMATCH/);assert.deepEqual(await readFile(journalPath),before);return;}
  runtime=await createConfiguredCoreServiceRuntime({env});await listenOnFetchSafePort(runtime.server,{host:'127.0.0.1',port:0});
  const base=`http://127.0.0.1:${runtime.server.address().port}`;
  const accepted=await fetch(base+'/mobile/tasks',{headers:{authorization:`Bearer ${issued.deviceToken}`}});assert.equal(accepted.status,200);assert.notEqual((await accepted.json()).success,false);
  const rejected=await fetch(base+'/mobile/tasks',{headers:{authorization:'Bearer synthetic-wrong'}});assert.notEqual((await rejected.json()).success,true);
  assert.equal(runtime.bridgeRuntime.registry.devices.get('synthetic-mobile').status,'active');
  console.log(JSON.stringify({configuredCore:true,preservedTokenAccepted:true,foreignTokenDenied:true,physicalDevice:false}));
 }finally{await runtime?.close();}
});
