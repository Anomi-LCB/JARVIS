import {createPcOutboundObserver} from '../apps/pc-agent/src/outbound-observer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PcLocalTaskScope} from '../apps/pc-agent/src/pc-local-task-scope.js';
import {createPcLocalScopeSettings} from '../apps/pc-agent/src/pc-local-scope-api.js';
import {createPcAgentServer,PcAgentApiGuard} from '../apps/pc-agent/src/main.mjs';
import {createAgRuntime} from '../apps/runtime-compose/src/create-runtime.js';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';

const task='mission_task_'+'a'.repeat(32);
const registration=(expectedRevision=0)=>({expectedRevision,allowedTaskIds:[task,'read_only'],allowedArtifactTaskIds:[task],allowedCommandTaskIds:[task]});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'jarvis-pc-catalog-')),dbPath=join(root,'catalog.sqlite'),handles=[];
 const open=(managedCatalog=true)=>{const scope=new PcLocalTaskScope({dbPath,managedCatalog});handles.push(scope);return scope;};
 t.after(async()=>{for(const scope of handles)scope.close();await rm(root,{recursive:true,force:true});});
 return {root,open,dbPath};
}
test('catalog registration and execution grants are separate; removal is atomic and fences a live lease',async t=>{
 const f=await fixture(t),a=f.open(),b=f.open();
 assert.equal(a.catalog().revision,0);assert.throws(()=>a.replace({expectedRevision:0,allowedTaskIds:[task],expiresAt:Date.now()+60000}),/TARGET_NOT_CONFIGURED/u);
 const registered=a.replaceCatalog(registration());assert.equal(registered.revision,1);assert.equal(a.snapshot().revision,1);assert.equal(a.snapshot().active,false);
 assert.deepEqual(b.catalog(),registered);assert.throws(()=>b.replaceCatalog(registration()),/REVISION_CONFLICT/u);
 a.replace({expectedRevision:1,allowedTaskIds:[task],expiresAt:Date.now()+60000});const lease=a.capture(task),readLease=a.captureCatalog(task,'read');
 b.replaceCatalog({expectedRevision:1,allowedTaskIds:['read_only'],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]});
 assert.equal(a.snapshot().active,false);assert.deepEqual(a.snapshot().allowedTaskIds,[]);assert.equal(a.snapshot().revision,3);
 assert.throws(()=>a.assertCurrent(task,lease),/CHANGED/u);assert.throws(()=>a.assertCatalogCurrent(task,'read',readLease),/CHANGED/u);
 assert.deepEqual(f.open().catalog().allowedTaskIds,['read_only']);assert.equal(f.open().snapshot().active,false);
});
test('catalog role hierarchy, bounded input and nonforgeable role leases are enforced',async t=>{
 const f=await fixture(t),scope=f.open();
 const invalid=[{...registration(),allowedTaskIds:[task,task]},{...registration(),allowedArtifactTaskIds:['foreign']},{...registration(),allowedCommandTaskIds:['read_only']},{...registration(),extra:true},{...registration(),allowedTaskIds:['bad/id']},{...registration(),allowedTaskIds:Array.from({length:1001},(_,i)=>`t${i}`)}];
 for(const value of invalid)assert.throws(()=>scope.replaceCatalog(value),/INPUT_INVALID/u);
 assert.equal(scope.catalog().revision,0);assert.equal(scope.snapshot().revision,0);scope.replaceCatalog(registration());
 const lease=scope.captureCatalog('read_only','read');scope.assertCatalogCurrent('read_only','read',lease);
 assert.throws(()=>scope.captureCatalog('read_only','artifact'),/DENIED/u);assert.throws(()=>scope.captureCatalog('read_only','command'),/DENIED/u);
 assert.throws(()=>scope.assertCatalogCurrent(task,'read',lease),/LEASE_INVALID/u);assert.throws(()=>scope.assertCatalogCurrent('read_only','read',{...lease}),/LEASE_INVALID/u);
 assert.throws(()=>f.open().assertCatalogCurrent('read_only','read',lease),/LEASE_INVALID/u);
});
test('legacy permission records are never silently adopted into a managed catalog',async t=>{
 const f=await fixture(t),legacy=f.open(false);legacy.replace({expectedRevision:0,allowedTaskIds:[task],expiresAt:Date.now()+60000});
 assert.throws(()=>f.open(true),/CONFIG_INVALID/u);assert.equal(legacy.snapshot().active,true);assert.equal(legacy.snapshot().revision,1);
 assert.throws(()=>legacy.catalog(),/NOT_CONFIGURED/u);
 assert.throws(()=>createPcLocalScopeSettings({scope:legacy,allowedTaskIds:[]}),/CONFIG_INVALID/u);
});
test('actual PC administrator API registers current IDs but execution token cannot register or grant',async t=>{
 const f=await fixture(t),scope=f.open(),runtime=createAgRuntime({allowedRoots:[f.root],auditRoot:join(f.root,'audit'),workerDaemonEnabled:false,env:{JARVIS_TEST_MODE:'1',JARVIS_LLM_INTENT:'0'}});
 const server=createPcAgentServer(runtime.pcAgent,{localTaskScope:scope,apiGuard:new PcAgentApiGuard({apiToken:'synthetic-catalog-admin',executionToken:'synthetic-catalog-executor'})});
 const address=await listenOnFetchSafePort(server);t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const api=async(path,method='GET',body,token='synthetic-catalog-admin')=>{const r=await fetch(`http://127.0.0.1:${address.port}/outbound/${path}`,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json()};};
 assert.equal((await api('local-task-catalog')).value.revision,0);
 assert.equal((await api('local-task-catalog','PUT',registration(),'synthetic-catalog-executor')).status,401);
 assert.equal((await api('local-task-catalog','PUT',{...registration(),extra:'ignored'})).status,400);
 const saved=await api('local-task-catalog','PUT',registration());assert.equal(saved.status,200);assert.equal(saved.value.executionAuthority,false);assert.equal(saved.value.verifiedCompletion,false);
 let local=await api('local-task-scope');assert.deepEqual(local.value.selectableTaskIds,[task]);assert.equal(local.value.active,false);
 assert.equal((await api('local-task-scope','PUT',{expectedRevision:1,allowedTaskIds:[task],expiresAt:Date.now()+60000})).status,200);
 assert.equal((await api('local-task-catalog','PUT',registration())).status,409);
 assert.equal((await api('local-task-catalog','PUT',{expectedRevision:1,allowedTaskIds:[],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]})).status,200);
 local=await api('local-task-scope');assert.equal(local.value.active,false);assert.deepEqual(local.value.allowedTaskIds,[]);assert.deepEqual(local.value.selectableTaskIds,[]);
});

for(const mode of ['normal','during-read','lost-ack-revoked'])test(`catalog read admission checks local revision before publication or ACK replay: ${mode}`,async t=>{
 const f=await fixture(t),scope=f.open();scope.replaceCatalog(registration());let submissions=0,reads=0,payload=null;
 const revoke=()=>scope.replaceCatalog({expectedRevision:1,allowedTaskIds:[],allowedArtifactTaskIds:[],allowedCommandTaskIds:[]});
 const observer=createPcOutboundObserver({allowedTaskIds:[],taskCatalog:scope,pcClient:{health:async()=>({}),taskResult:async()=>{reads++;if(mode==='during-read')revoke();return {synthetic:'private task result'};}},transport:{exchange:async(op,input)=>{
  if(op==='pull')return {requestId:'read',generation:1,lease:'fixture-lease',expiresAt:Date.now()+60000,request:{operation:'task-result',taskId:task}};
  if(op==='submit'){submissions++;payload=input.result;if(mode==='lost-ack-revoked')throw new Error('lost ACK');return {accepted:true};}
 }}});
 if(mode==='lost-ack-revoked'){await assert.rejects(observer.tick(),/lost ACK/u);assert.equal(submissions,1);revoke();assert.equal((await observer.tick()).status,'scope-changed');assert.equal(submissions,1);assert.equal(reads,1);}
 else{await observer.tick();assert.equal(reads,1);assert.equal(payload.status,mode==='normal'?'observed':'unavailable');if(mode==='during-read')assert.equal(payload.value,undefined);}
});
